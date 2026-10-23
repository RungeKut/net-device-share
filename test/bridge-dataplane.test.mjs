// Путь кадров в общем мосту, целиком: TAP держателя → канал → порт коммутатора → «провод».
//   node --test test/bridge-dataplane.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { LinkServer, LinkClient, newToken } from '../src/net/tapLink.js';
import { VSwitch, SocketPort } from '../src/net/vswitch.js';
import { plugRelay } from '../src/net/relayKeeper.js';
import { FrameCutter } from '../src/net/tapRelay.js';

/** Посредник TAP без PowerShell: что в него записали — в received, что надо «прислать из адаптера» — emit(). */
class FakeRelay extends EventEmitter {
  constructor() { super(); this.sink = null; this.received = []; this.cutter = new FrameCutter(); }
  setSink(s) { this.sink = s; }
  writeFrames(f) { this.received.push(Buffer.from(f)); return true; }
  backlog() { return 0; }
  onceDrain(cb) { cb(); }
  /** Кадр «из адаптера» (с префиксом длины) — получателю. */
  emit2(frame) {
    const b = Buffer.alloc(2 + frame.length);
    b.writeUInt16BE(frame.length, 0);
    frame.copy(b, 2);
    this.sink?.write(b);
  }
}

const eth = (dst, src, len = 60) => {
  const f = Buffer.alloc(len);
  Buffer.from(dst).copy(f, 0);
  Buffer.from(src).copy(f, 6);
  f.writeUInt16BE(0x0806, 12);
  return f;
};
const framesOf = (bufs) => {
  const out = [];
  for (const b of bufs) {
    for (let i = 0; i + 2 <= b.length;) { const n = b.readUInt16BE(i); out.push(b.subarray(i + 2, i + 2 + n)); i += 2 + n; }
  }
  return out;
};
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
};

test('ARP-обмен держателя с прибором через коммутатор моста: запрос уходит в провод, ответ возвращается', async () => {
  const MAC_H = [2, 0, 0, 0, 0, 0x0a];     // TAP держателя
  const MAC_I = [0, 0xe0, 0x33, 1, 0xa4, 0xd9];   // прибор в сети карты

  const server = new LinkServer({ port: 0, host: '127.0.0.1' });
  await server.start();
  const port = server.server.address().port;

  const sw = new VSwitch({ id: 'join', name: 'nic' });
  const wireRelay = new FakeRelay();
  plugRelay(sw, 'wire', wireRelay, 'провод');
  const holderPort = new SocketPort(sw, 'holder:h1', 'держатель');
  const session = server.open({ relay: holderPort, allowAddress: null, label: 'тест', deviceId: 'net:x' });

  const holderTap = new FakeRelay();
  const client = new LinkClient({ relay: holderTap, host: '127.0.0.1', port, token: session.token, label: 'клиент' });
  await client.start();

  try {
    // 1. Держатель спрашивает «кто 10.0.6.134?» — широковещательный ARP.
    holderTap.emit2(eth([255, 255, 255, 255, 255, 255], MAC_H));
    assert.ok(await until(() => framesOf(wireRelay.received).length === 1), 'запрос дошёл до провода');

    // 2. Прибор отвечает держателю лично.
    wireRelay.emit2(eth(MAC_H, MAC_I));
    assert.ok(await until(() => framesOf(holderTap.received).length === 1), 'ответ дошёл до держателя');

    // 3. Дальше обмен идёт напрямую, и крупные кадры (TCP сегмент) тоже проходят.
    holderTap.emit2(eth(MAC_I, MAC_H, 1514));
    wireRelay.emit2(eth(MAC_H, MAC_I, 1514));
    assert.ok(await until(() => framesOf(wireRelay.received).length === 2 && framesOf(holderTap.received).length === 2));
    assert.equal(framesOf(wireRelay.received)[1].length, 1514);
  } finally {
    client.stop();
    session.close();
    await server.stop();
  }
});

test('кадр больше обычного (1522 с VLAN-меткой) не должен ломать порт и терять соседние кадры', async () => {
  const sw = new VSwitch({ id: 'join2', name: 'nic' });
  const got = [];
  sw.attach('wire', { send: (f) => got.push(Buffer.from(f)), backlog: () => 0 });
  const a = sw.attach('a', { send() {}, backlog: () => 0 });
  const big = eth([255, 255, 255, 255, 255, 255], [2, 0, 0, 0, 0, 1], 1522);
  const small = eth([255, 255, 255, 255, 255, 255], [2, 0, 0, 0, 0, 1], 60);
  const pack = (f) => { const b = Buffer.alloc(2 + f.length); b.writeUInt16BE(f.length, 0); f.copy(b, 2); return b; };
  a.input(Buffer.concat([pack(small), pack(big), pack(small)]));
  assert.equal(framesOf(got).length, 3, 'все три кадра пересланы');
});

test('кадр длиннее предела пропускается сам, соседние по пачке пересылаются', () => {
  const sw = new VSwitch({ id: 'join3', name: 'nic' });
  const got = [];
  sw.attach('wire', { send: (f) => got.push(Buffer.from(f)), backlog: () => 0 });
  const a = sw.attach('a', { send() {}, backlog: () => 0 });
  const mk = (len) => { const f = len >= 14 ? eth([255, 255, 255, 255, 255, 255], [2, 0, 0, 0, 0, 1], len) : Buffer.alloc(len); const b = Buffer.alloc(2 + len); b.writeUInt16BE(len, 0); f.copy(b, 2); return b; };
  a.input(Buffer.concat([mk(60), mk(3000), mk(60), mk(10), mk(60)]));      // 3000 — выше предела, 10 — короче Ethernet-заголовка
  assert.equal(framesOf(got).length, 3);
  assert.equal(sw.diag().ports.find((p) => p.id === 'a').drops, 2, 'два негодных кадра посчитаны');
});

test('трасса и счётчики видов кадров: видно ARP-запрос, ответ и ICMP', () => {
  const sw = new VSwitch({ id: 'join4', name: 'nic' });
  sw.enableTrace();
  const wire = sw.attach('wire', { send() {}, backlog: () => 0 });
  const h = sw.attach('holder:h1', { send() {}, backlog: () => 0 });
  const pack = (f) => { const b = Buffer.alloc(2 + f.length); b.writeUInt16BE(f.length, 0); f.copy(b, 2); return b; };
  const arp = (op, src, spa, tpa) => {
    const f = Buffer.alloc(60);
    Buffer.from([255, 255, 255, 255, 255, 255]).copy(f, 0);
    Buffer.from(src).copy(f, 6);
    f.writeUInt16BE(0x0806, 12);
    f.writeUInt16BE(1, 14); f.writeUInt16BE(0x0800, 16); f[18] = 6; f[19] = 4;
    f.writeUInt16BE(op, 20);
    Buffer.from(src).copy(f, 22);
    Buffer.from(spa).copy(f, 28);
    Buffer.from(tpa).copy(f, 38);
    return f;
  };
  h.input(pack(arp(1, [2, 0, 0, 0, 0, 0xa], [10, 0, 6, 155], [10, 0, 6, 134])));
  wire.input(pack(arp(2, [0, 0xe0, 0x33, 1, 0xa4, 0xd9], [10, 0, 6, 134], [10, 0, 6, 155])));
  const d = sw.diag();
  assert.deepEqual(d.trace.map((t) => t.kind), ['arp-request', 'arp-reply']);
  assert.match(d.trace[0].text, /10\.0\.6\.155 спрашивает, кто 10\.0\.6\.134/);
  assert.equal(d.ports.find((p) => p.id === 'holder:h1').kinds['arp-request'], 1);
  assert.ok(d.macs.some((m) => m.mac === '00-e0-33-01-a4-d9' && m.port === 'wire'), 'MAC прибора выучен за проводом');
});
