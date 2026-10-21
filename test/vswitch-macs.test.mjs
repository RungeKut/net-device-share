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
