// Подбор адресов для держателя: что опрашивать и какой свободный взять следующим.
//   node --test test/net-scan.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTargets, suggestNextIp } from '../src/net/netScan.js';

test('scanTargets: /24 — 253 адреса без сети, широковещательного и самой карты', () => {
  const t = scanTargets('10.0.3.46', 24);
  assert.equal(t.length, 253);
  assert.ok(!t.includes('10.0.3.0') && !t.includes('10.0.3.255') && !t.includes('10.0.3.46'));
  assert.equal(t[0], '10.0.3.1');
});

test('scanTargets: подсеть шире /22 сужается до /24 карты, /30 даёт один соседний адрес', () => {
  assert.equal(scanTargets('10.20.30.40', 16).length, 253);
  assert.equal(scanTargets('10.20.30.40', 16)[0], '10.20.30.1');
  assert.deepEqual(scanTargets('192.168.0.1', 30), ['192.168.0.2']);
  assert.deepEqual(scanTargets('192.168.0.1', 31), []);
});

test('suggestNextIp: первый свободный после адреса владельца', () => {
  const next = suggestNextIp({ address: '10.0.3.46', prefixLength: 24, used: ['10.0.3.47', '10.0.3.48'], reserved: ['10.0.3.49'] });
  assert.equal(next, '10.0.3.50');
});

test('suggestNextIp: после конца подсети берёт свободный с начала', () => {
  const used = [];
  for (let i = 1; i < 254; i++) if (i !== 5) used.push(`10.0.3.${i}`);
  assert.equal(suggestNextIp({ address: '10.0.3.254', prefixLength: 24, used }), '10.0.3.5');
});

test('suggestNextIp: подсеть заполнена — null', () => {
  const used = [];
  for (let i = 1; i < 31; i++) used.push(`10.0.3.${i}`);
  assert.equal(suggestNextIp({ address: '10.0.3.1', prefixLength: 27, used }), null);
});
