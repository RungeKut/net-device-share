// Клиентская сторона проброса COM: пары com0com (setupc) и занявший.
// com0com и насос не нужны: setupc подменён, насос эмулируется пайпами.
//   node --test test/serial-client.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LinkServer } from '../src/net/tapLink.js';
import {
  PKT, PacketCutter, packetFrame, encodePortParams, parsePortParams,
  MSR_CTS, CTRL_RTS_ON, CTRL_DTR_OFF,
} from '../src/net/serialLink.js';
import { SerialShare, PUMP } from '../src/core/serialShare.js';
import { parseList, createPair, usedComNames } from '../src/net/com0com.js';
import { DeviceHub } from '../src/devices/hub.js';

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('условие не выполнилось за отведённое время');
}

const PARAMS_9600 = { baud: 9600, parity: 0, dataBits: 8, stopBits: 0 };

// ------------------------------------------------------------------ setupc

test('setupc list разбирается: имена, COM#, RealPortName', () => {
  const out = parseList([
    'CNCA0 PortName=COM#,RealPortName=COM3,EmuBR=no',
    'CNCB0 PortName=-',
    'CNCA4 PortName=COM12,EmuBR=yes',
    'CNCB4 PortName=COM17',
    'мусорная строка',
  ].join('\n'));
  assert.deepEqual(out.map((p) => `${p.side}${p.id}:${p.name}`), ['A0:COM3', 'B0:null', 'A4:COM12', 'B4:COM17']);
});

test('usedComNames читает SERIALCOMM', async () => {
  const names = await usedComNames(async (cmd, args) => ({
    ok: true,
    stdout: [
      'HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM',
      '    \\Device\\Serial0    REG_SZ    COM1',
      '    \\Device\\VCP0    REG_SZ    COM12',
      '    \\Device\\Parallel1    REG_SZ    LPT1',
    ].join('\r\n'),
  }));
  assert.ok(names.has('COM1') && names.has('COM12') && names.has('LPT1'));
});

function fakeSetupc() {
  let nextId = 5;
  let lines = [];
  const listOut = () => lines.join('\n');
  return async (cmd, args) => {
    if (args[0] === 'list') return { ok: true, stdout: listOut() };
    if (args[0] === 'install') {
      const id = Number(args[1]);
      const side = (param) => {
        const m = String(param).match(/PortName=(\S+)/);
        return m && m[1] !== 'COM#' ? m[1] : `COM9${++nextId}`;
      };
      lines.push(`CNCA${id} PortName=${side(args[2])}`, `CNCB${id} PortName=${side(args[3])}`);
      return { ok: true, stdout: '' };
    }
    if (args[0] === 'remove') {
      lines = lines.filter((l) => !l.startsWith(`CNCA${Number(args[1])} `) && !l.startsWith(`CNCB${Number(args[1])} `));
      return { ok: true, stdout: '' };
    }
    throw new Error(`неожиданная команда ${args[0]}`);
  };
}

test('createPair: имя владельца свободно — достаётся его порту; занято — свободное имя', async () => {
  const okPair = await createPair('COM12', {
    runFn: fakeSetupc(),
    usedNames: async () => new Set(['COM1']),
  });
  assert.equal(okPair.theirs, 'COM12', 'имя владельца досталось порту человека');
  assert.match(okPair.ours, /^COM9/);
  assert.equal(okPair.theirsNote, null);

  const busyPair = await createPair('COM12', {
    runFn: fakeSetupc(),
    usedNames: async () => new Set(['COM12']),
  });
  assert.match(busyPair.theirs, /^COM9/);
  assert.match(busyPair.theirsNote, /занято/);
});

// ------------------------------------------------------ два SerialShare

/**
 * Эмуляция насоса парой пайпов. echo — у владельца: прибор-петля возвращает
 * записанное (иначе байты не come обратно). У занявшего эха нет: наш конец
 * пары только передаёт то, что пришло по сети, приложению человека.
 */
function emulatePump(initial = PARAMS_9600, { echo = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { if (child.exitCode === null) { child.exitCode = 0; child.emit('exit', 0); } };
  const state = { params: { ...initial }, applied: [], writes: [], ctrl: null, closed: false };
  const send = (type, payload) => child.stdout.write(packetFrame(type, payload));

  const cutter = new PacketCutter();
  child.stdin.on('data', (chunk) => {
    for (const p of cutter.push(chunk)) {
      switch (p.type) {
        case PUMP.WRITE:
          state.writes.push(Buffer.from(p.payload));
          if (echo) send(PUMP.DATA, p.payload);
          break;
        case PUMP.PARAMS:
          state.params = parsePortParams(p.payload);
          state.applied.push({ ...state.params });
          send(PUMP.PARAMS_RESULT, Buffer.from([1]));
          break;
        case PUMP.CTRL:
          state.ctrl = p.payload[0];
          break;
        case PUMP.CLOSE:
          state.closed = true;
          child.kill();
          break;
      }
    }
  });

  send(PUMP.READY, Buffer.concat([encodePortParams(initial), Buffer.from([0])]));
  return { child, state, setLines: (m) => send(PUMP.MSR, Buffer.from([m])), deviceData: (b) => send(PUMP.DATA, b) };
}

function fakeConfig() {
  const data = { netLinkPort: 47814, serialRestore: {}, serialPairs: {} };
  return { get: (k) => data[k], set: (patch) => Object.assign(data, patch), data };
}

function shareWith(config, emu, com0com = null) {
  return new SerialShare({
    config,
    supported: true,
    pump: { compile: async () => 'ndspump.exe', spawn: () => emu.child },
    ...(com0com ? { com0com } : {}),
  });
}

test('владелец и занявший на одной машине: байты и линии проходят весь путь', async () => {
  const server = new LinkServer({ port: 0 });
  await server.start();
  try {
    const ownerEmu = emulatePump();
    const owner = shareWith(fakeConfig(), ownerEmu);
    await owner.start({ server });
    const grant = await owner.lend(
      { deviceId: 'com:COM12', type: 'com', key: 'COM12', description: 'Порт владельца' },
      { holderId: 'node-B' },
    );
    assert.equal(grant.com, 'COM12');

    const clientEmu = emulatePump(PARAMS_9600, { echo: false });
    const removed = [];
    const client = shareWith(fakeConfig(), clientEmu, {
      present: () => true,
      createPair: async (ownerName) => ({ id: 7, ours: 'COM91', theirs: ownerName, theirsNote: null }),
      removePair: async (id) => {
        removed.push(id);
        return true;
      },
    });
    await client.start({ server: {} });

    const stages = [];
    const res = await client.borrow({
      key: 'node-B|com:COM12',
      host: '127.0.0.1',
      port: server.server.address().port,
      token: grant.token,
      com: grant.com,
      params: grant.params,
      onStage: (s) => stages.push(s),
    });
    assert.equal(res.com, 'COM12');
    assert.ok(stages.length > 0);
    assert.deepEqual(clientEmu.state.params, PARAMS_9600, 'параметры владельца у нашего конца пары');

    // «Приложение человека» пишет в свой порт → порт владельца → петля → назад.
    clientEmu.deviceData(Buffer.from('hello'));
    await waitFor(() => ownerEmu.state.writes.some((w) => w.toString() === 'hello')
      && clientEmu.state.writes.some((w) => w.toString() === 'hello'));

    // Линии владельца: CTS устройства → RTS нашего конца (человек видит CTS).
    // CTRL — комбинированный байт: RTS включить, DTR выключить.
    ownerEmu.setLines(MSR_CTS);
    await waitFor(() => clientEmu.state.ctrl === (CTRL_RTS_ON | CTRL_DTR_OFF));
    // Человек выставил RTS (у нас это CTS) → владельцу уходит CTRL.
    clientEmu.setLines(MSR_CTS);
    await waitFor(() => ownerEmu.state.ctrl === (CTRL_RTS_ON | CTRL_DTR_OFF));

    // Освобождение: пара убрана, насосы закрыты.
    await client.giveBack('node-B|com:COM12');
    assert.deepEqual(removed, [7]);
    assert.equal(clientEmu.state.closed, true);
    await waitFor(() => !owner.lends.get('com:COM12')?.session?.connected());
    await owner.stop();
    await client.stop();
  } finally {
    await server.stop();
  }
});

test('без com0com занять честно нельзя', async () => {
  const client = new SerialShare({
    config: fakeConfig(),
    supported: true,
    com0com: { present: () => false, createPair: async () => { throw new Error('не должно вызываться'); }, removePair: async () => true },
  });
  assert.match(client.borrowBlocker(), /com0com/);
  await assert.rejects(() => client.borrow({ key: 'k', host: '127.0.0.1', port: 1, token: 't' }), /com0com/);
});

// ------------------------------------------------------------------------ hub

test('hub: COM пробрасывается по доступности SerialShare, LPT — никогда', async () => {
  const unlended = [];
  const serial = {
    supported: true,
    server: {},
    lend: async (dev) => ({ port: 47814, token: 't', mode: 'serial', com: dev.key, params: null }),
    unlend: async (dev) => {
      unlended.push(dev.deviceId);
      return { ok: true };
    },
  };
  const mkHub = (withSerial) => new DeviceHub({
    backend: {},
    enabledTypes: () => ['com', 'lpt', 'net'],
    ...(withSerial ? { serial } : {}),
    slow: {
      signature: async () => 'S',
      load: async () => ({ ports: [
        { type: 'com', key: 'COM3', deviceId: 'com:COM3', title: 'COM3', description: 'порт', details: {}, present: true },
        { type: 'lpt', key: 'LPT1', deviceId: 'lpt:LPT1', title: 'LPT1', description: 'порт', details: {}, present: true },
      ], nets: [] }),
    },
  });

  const withIt = mkHub(true);
  const owned = await withIt.listLocal();
  assert.deepEqual(owned.map((d) => `${d.key}:${d.hasTransport}`), ['COM3:true', 'LPT1:false']);

  const without = mkHub(false);
  const bare = await without.listLocal();
  assert.deepEqual(bare.map((d) => `${d.key}:${d.hasTransport}`), ['COM3:false', 'LPT1:false']);

  const grant = await withIt.bind(owned[0], { holderId: 'n1' });
  assert.equal(grant.link.mode, 'serial');
  assert.equal(grant.link.com, 'COM3');
  const dev = { ...owned[0], hasTransport: true };
  await withIt.unbind(dev);
  assert.deepEqual(unlended, ['com:COM3']);
});

test('блокировки владельца: LPT и не-Windows отказываются, COM с каналом — нет', async () => {
  const share = new SerialShare({ config: fakeConfig(), supported: true });
  assert.match(share.lendBlocker({ type: 'lpt', key: 'LPT1' }), /последовательные/);
  assert.match(share.lendBlocker({ type: 'com', key: 'COM1' }), /канал/);
  share.server = {};
  assert.equal(share.lendBlocker({ type: 'com', key: 'COM1' }), null);
});
