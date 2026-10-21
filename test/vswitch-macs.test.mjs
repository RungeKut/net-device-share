// Таблица адресов коммутатора ограничена: uplink не должен раздувать её без предела.
//   node --test test/vswitch-macs.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { VSwitch } from '../src/net/vswitch.js';

function frameFrom(srcIndex) {
  const body = Buffer.alloc(60);
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).copy(body, 0);                 // получатель: рассылка
  Buffer.from([0x02, 0, 0, (srcIndex >> 16) & 255, (srcIndex >> 8) & 255, srcIndex & 255]).copy(body, 6);
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

test('таблица адресов не растёт выше предела, новые адреса вытесняют давние', () => {
  const sw = new VSwitch({ id: 'sw', name: 'sw' });
  const port = sw.attach('uplink', { send() {}, backlog: () => 0, label: 'uplink' });
  for (let i = 0; i < 6000; i++) port.input(frameFrom(i));
  assert.equal(sw.macs.size, 4096, 'ровно предел');
  const keys = [...sw.macs.keys()].map(String);
  assert.ok(keys.some((k) => k.endsWith('00176f')), 'самый свежий адрес (5999) на месте');
  assert.ok(!keys.some((k) => k.endsWith('020000000000') || k.endsWith('000000')), 'самый давний адрес (0) вытеснен');
});

test('несколько держателей на одной карте: коммутатор сводит их друг с другом и с проводом', async () => {
  const { SocketPort } = await import('../src/net/vswitch.js');
  const sw = new VSwitch({ id: 'join' });
  const got = { wire: [], a: [], b: [] };
  const wire = sw.attach('wire', { send: (f) => got.wire.push(f), backlog: () => 0 });
  const mk = (name) => {
    const port = new SocketPort(sw, `holder:${name}`);
    port.setSink({ destroyed: false, writableLength: 0, write: (f) => got[name].push(f) });
    return port;
  };
  const a = mk('a');
  const b = mk('b');
  const frame = (dst, src) => {
    const body = Buffer.alloc(60);
    Buffer.from(dst).copy(body, 0);
    Buffer.from(src).copy(body, 6);
    const out = Buffer.alloc(62);
    out.writeUInt16BE(60, 0);
    body.copy(out, 2);
    return out;
  };
  const MAC_A = [2, 0, 0, 0, 0, 0xa];
  const MAC_B = [2, 0, 0, 0, 0, 0xb];

  assert.equal(a.writeFrames(frame([255, 255, 255, 255, 255, 255], MAC_A)), true);   // рассылка от A
  assert.equal(got.b.length, 1, 'B получил рассылку');
  assert.equal(got.wire.length, 1, 'провод получил рассылку');
  assert.equal(got.a.length, 0, 'отправителю свой кадр не возвращается');

  b.writeFrames(frame(MAC_A, MAC_B));                                                // B → A, адрес A уже известен
  assert.equal(got.a.length, 1, 'A получил кадр от B');
  assert.equal(got.wire.length, 1, 'провод чужой разговор не видит');

  wire.input(frame(MAC_B, [2, 0, 0, 0, 0, 0xc]));                                    // из провода → B
  assert.equal(got.b.length, 2);
  assert.equal(got.a.length, 1);

  a.close();
  b.writeFrames(frame([255, 255, 255, 255, 255, 255], MAC_B));
  assert.equal(got.a.length, 1, 'вышедший держатель кадров больше не получает');
});
