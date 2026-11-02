// Байтовый канал COM-порта и насос владельца. Железа и com0com не нужно:
// канал проверяется на localhost, насос эмулируется парой пайпов.
//   node --test test/serial-link.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LinkServer, LinkClient } from '../src/net/tapLink.js';
import {
  PKT, PacketCutter, packetFrame, encodePortParams, parsePortParams,
  MSR_CTS, CTRL_RTS_ON,
} from '../src/net/serialLink.js';
import { SerialShare, PUMP } from '../src/core/serialShare.js';

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('условие не выполнилось за отведённое время');
}

const PARAMS_115200 = { baud: 115200, parity: 0, dataBits: 8, stopBits: 0 };
const PARAMS_9600 = { baud: 9600, parity: 0, dataBits: 8, stopBits: 0 };

// --------------------------------------------------------------- резка пакетов

test('PacketCutter собирает пакет из кусков, ловит нулевую длину', () => {
  const c = new PacketCutter();
  const frame = packetFrame(PKT.DATA, Buffer.from('hello'));
  assert.deepEqual(c.push(frame.subarray(0, 2)), []);
  assert.deepEqual(c.push(frame.subarray(2, 4)), []);
  const got = c.push(frame.subarray(4));
  assert.equal(got.length, 1);
  assert.equal(got[0].type, PKT.DATA);
  assert.equal(got[0].payload.toString(), 'hello');

  const two = Buffer.concat([
    packetFrame(PKT.MSR, Buffer.from([1])),
    packetFrame(PKT.PARAMS, encodePortParams(PARAMS_115200)),
  ]);
  const r = c.push(two);
  assert.deepEqual(r.map((p) => p.type), [PKT.MSR, PKT.PARAMS]);
  assert.deepEqual(parsePortParams(r[1].payload), PARAMS_115200);
  assert.throws(() => c.push(Buffer.from([0, 0])), /нулевой/);
});

// --------------------------------------------------------------- канал NDS1

function startServer() {
  const server = new LinkServer({ port: 0 });
  return server.start().then(() => server);
}

test('байтовый канал: пакеты идут в обе стороны через один порт с кадрами L2', async () => {
  const server = await startServer();
  try {
    const fromClient = [];
    const serial = server.openSerial({
      label: 'COM-тест',
      onPacket: (type, payload) => {
        fromClient.push({ type, payload });
        if (type === PKT.DATA) serial.send(PKT.DATA, Buffer.concat([payload, Buffer.from('!')]));
        if (type === PKT.PARAMS) serial.send(PKT.PARAMS_RESULT, Buffer.from([1]));
      },
    });

    const got = [];
    const client = new LinkClient({
      host: '127.0.0.1', port: server.server.address().port, token: serial.token,
      label: 'тест', serial: true, onPacket: (t, p) => got.push({ t, payload: p }),
    });
    await client.start();

    client.send(PKT.DATA, Buffer.from('abc'));
    client.send(PKT.PARAMS, encodePortParams(PARAMS_115200));
    await waitFor(() => fromClient.length >= 2 && got.length >= 2);

    assert.equal(fromClient[0].payload.toString(), 'abc');
    assert.deepEqual(parsePortParams(fromClient[1].payload), PARAMS_115200);
    assert.equal(got.find((x) => x.t === PKT.DATA).payload.toString(), 'abc!');
    assert.equal(got.find((x) => x.t === PKT.PARAMS_RESULT).payload[0], 1);

    // Кадры L2 с токеном байтового сеанса не проходят, и наоборот.
    const l2 = new LinkClient({ host: '127.0.0.1', port: server.server.address().port, token: serial.token, label: 'л2' });
    await assert.rejects(() => l2.start(), (e) => e.code === 'rejected');

    const wrong = new LinkClient({
      host: '127.0.0.1', port: server.server.address().port, token: serial.token,
      label: 'тест2', serial: true, onPacket: () => {},
    });
    wrong.token = Buffer.from('ff'.repeat(32), 'hex');
    await assert.rejects(() => wrong.start(), (e) => e.code === 'rejected');

    client.stop();
  } finally {
    await server.stop();
  }
});

test('второе подключение с тем же пропуском вытесняет первое', async () => {
  const server = await startServer();
  try {
    const serial = server.openSerial({ label: 'COM-тест', onPacket: () => {} });
    const a = new LinkClient({ host: '127.0.0.1', port: server.server.address().port, token: serial.token, label: 'a', serial: true, onPacket: () => {} });
    await a.start();
    const b = new LinkClient({ host: '127.0.0.1', port: server.server.address().port, token: serial.token, label: 'b', serial: true, onPacket: () => {} });
    await b.start();
    await waitFor(() => !a.connected && b.connected);
    a.stop();
    b.stop();
  } finally {
    await server.stop();
  }
});

// --------------------------------------------------------------- насос и SerialShare

/**
 * Эмуляция насоса парой пайпов: то, что процессы приложения и насоса сказали
 * бы друг другу. Устройство — петля: записанное возвращается как DATA.
 */
function emulatePump(initial = PARAMS_9600) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { if (child.exitCode === null) { child.exitCode = 0; child.emit('exit', 0); } };
  const state = { params: { ...initial }, applied: [], writes: [], ctrl: null, breaks: [], closed: false };
  const send = (type, payload) => child.stdout.write(packetFrame(type, payload));

  const cutter = new PacketCutter();
  child.stdin.on('data', (chunk) => {
    for (const p of cutter.push(chunk)) {
      switch (p.type) {
        case PUMP.WRITE:
          state.writes.push(Buffer.from(p.payload));
          send(PUMP.DATA, p.payload);
          break;
        case PUMP.PARAMS:
          state.params = parsePortParams(p.payload);
          state.applied.push({ ...state.params });
          send(PUMP.PARAMS_RESULT, Buffer.from([1]));
          break;
        case PUMP.CTRL:
          state.ctrl = p.payload[0];
          break;
        case PUMP.BREAK:
          state.breaks.push(p.payload.readUInt16BE(0));
          break;
        case PUMP.CLOSE:
          state.closed = true;
          child.kill();
          break;
      }
    }
  });

  send(PUMP.READY, Buffer.concat([encodePortParams(initial), Buffer.from([0])]));
  return {
    child,
    state,
    setLines: (m) => send(PUMP.MSR, Buffer.from([m])),
    deviceData: (bytes) => send(PUMP.DATA, bytes),
  };
}

function fakeConfig() {
  const data = { netLinkPort: 47814, serialRestore: {} };
  return { get: (k) => data[k], set: (patch) => Object.assign(data, patch), data };
}

function shareWith(config, emu) {
  return new SerialShare({
    config,
    supported: true,
    pump: {
      compile: async () => 'ndspump.exe',
      spawn: (exe, com) => {
        assert.equal(exe, 'ndspump.exe');
        emu.spawned.push(com);
        return emu.child;
      },
    },
  });
}

test('SerialShare: занятие, эхо, параметры, линии, Break', async () => {
  const server = await startServer();
  try {
    const emu = { spawned: [], ...emulatePump() };
    const config = fakeConfig();
    const share = shareWith(config, emu);
    await share.start({ server });

    const grant = await share.lend(
      { deviceId: 'com:COM3', type: 'com', key: 'COM3', description: 'Тестовый порт' },
      { holderId: 'node-A' },
    );
    assert.deepEqual(emu.spawned, ['COM3']);
    assert.equal(grant.mode, 'serial');
    assert.deepEqual(grant.params, PARAMS_9600, 'занявшему сообщено, с чем порт открыт');
    assert.deepEqual(config.data.serialRestore['com:COM3'].params, PARAMS_9600, 'исходные параметры запомнены');

    const got = [];
    const client = new LinkClient({
      host: '127.0.0.1', port: server.server.address().port, token: grant.token,
      label: 'COM3', serial: true, onPacket: (t, p) => got.push({ t, payload: p }),
    });
    await client.start();

    client.send(PKT.DATA, Buffer.from('ping'));
    client.send(PKT.PARAMS, encodePortParams(PARAMS_115200));
    await waitFor(() => got.some((x) => x.t === PKT.DATA && x.payload.toString() === 'ping')
      && got.some((x) => x.t === PKT.PARAMS_RESULT && x.payload[0] === 1));
    assert.deepEqual(emu.state.params, PARAMS_115200, 'параметры дошли до насоса');

    emu.setLines(MSR_CTS);
    emu.deviceData(Buffer.from('from-device'));
    client.send(PKT.CTRL, Buffer.from([CTRL_RTS_ON]));
    const br = Buffer.alloc(2);
    br.writeUInt16BE(30);
    client.send(PKT.BREAK, br);
    await waitFor(() => got.some((x) => x.t === PKT.MSR && (x.payload[0] & MSR_CTS))
      && got.some((x) => x.t === PKT.DATA && x.payload.toString() === 'from-device')
      && emu.state.ctrl === CTRL_RTS_ON
      && emu.state.breaks.includes(30));

    await share.unlend({ deviceId: 'com:COM3' });
    assert.deepEqual(emu.state.applied.at(-1), PARAMS_9600, 'порту вернули исходные параметры');
    assert.equal(emu.state.closed, true);
    assert.equal(config.data.serialRestore['com:COM3'], undefined);
    await waitFor(() => !client.connected, 1500);
    client.stop();
    await share.stop();
  } finally {
    await server.stop();
  }
});

test('порт передаётся другому держателю: прежний пропуск не действует', async () => {
  const server = await startServer();
  try {
    const emu = { spawned: [], ...emulatePump() };
    const share = shareWith(fakeConfig(), emu);
    await share.start({ server });

    const first = await share.lend({ deviceId: 'com:COM4', type: 'com', key: 'COM4' }, { holderId: 'node-A' });
    const clientA = new LinkClient({ host: '127.0.0.1', port: server.server.address().port, token: first.token, label: 'a', serial: true, onPacket: () => {} });
    await clientA.start();

    const second = await share.lend({ deviceId: 'com:COM4', type: 'com', key: 'COM4' }, { holderId: 'node-B' });
    assert.notEqual(second.token, first.token);

    const clientB = new LinkClient({ host: '127.0.0.1', port: server.server.address().port, token: second.token, label: 'b', serial: true, onPacket: () => {} });
    await clientB.start();
    await waitFor(() => !clientA.connected && clientB.connected, 2000);

    clientA.token = Buffer.from('ff'.repeat(32), 'hex');
    const back = new LinkClient({ host: '127.0.0.1', port: server.server.address().port, token: first.token, label: 'a2', serial: true, onPacket: () => {} });
    await assert.rejects(() => back.start(), (e) => e.code === 'rejected');

    clientA.stop();
    clientB.stop();
    await share.stop();
  } finally {
    await server.stop();
  }
});

test('после падения приложения параметры порта возвращаются при старте', async () => {
  const config = fakeConfig();
  config.data.serialRestore = {
    'com:COM5': { com: 'COM5', name: 'Старый порт', params: { baud: 4800, parity: 2, dataBits: 7, stopBits: 2 } },
  };
  const emu = { spawned: [], ...emulatePump() };
  const share = shareWith(config, emu);
  await share.start({ server: {} });

  assert.deepEqual(emu.spawned, ['COM5']);
  assert.deepEqual(emu.state.applied.at(-1), { baud: 4800, parity: 2, dataBits: 7, stopBits: 2 });
  assert.deepEqual(config.data.serialRestore, {});
  assert.equal(emu.state.closed, true, 'восстанавливающий насос закрылся сразу');
  await share.stop();
});

test('блокировки: LPT и не-Windows честно отказываются', async () => {
  const share = new SerialShare({ config: fakeConfig(), supported: true });
  assert.match(share.lendBlocker({ type: 'lpt', key: 'LPT1' }).text, /только последовательные/);
  assert.match(share.lendBlocker({ type: 'com', key: 'COM1' }).text, /канал/);
  const off = new SerialShare({ config: fakeConfig(), supported: false });
  assert.match(off.lendBlocker({ type: 'com', key: 'COM1' }).text, /Windows/);
});

// Настоящая компиляция насоса: один раз собирается и остаётся в кэше настроек.
test('насос собирается PowerShell-ом без npm-зависимостей', { skip: process.platform !== 'win32', timeout: 180000 }, async () => {
  const { buildPump } = await import('../src/core/serialShare.js');
  const exe = await buildPump();
  assert.match(exe, /ndspump-[0-9a-f]{8}\.exe$/, 'имя насоса несёт отпечаток исходников');
  const fs = await import('node:fs');
  assert.ok(fs.existsSync(exe));
  assert.ok(fs.statSync(exe).size > 4096, 'exe не пуст');
});
