// Чистка ARP: адрес в подключаемой подсети — на всех адаптерах.
//   node --test test/ip-prefix.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { ipInPrefix } from '../src/net/ipConfig.js';

test('адрес в подключаемой подсети: базовый адрес сети может быть любым адресом этой сети', () => {
  // Совет владельца — его собственный адрес, а не адрес сети: хостовые биты гасятся.
  assert.equal(ipInPrefix('10.0.6.134', '10.0.6.154/24'), true);
  assert.equal(ipInPrefix('10.0.6.1', '10.0.6.154/24'), true);
  assert.equal(ipInPrefix('10.0.6.154', '10.0.6.154/24'), true, 'сам адрес — тоже в своей сети');
});

test('чужие адреса и подсети не задеваются: рабочую сеть чистим только по её пересечению', () => {
  assert.equal(ipInPrefix('10.0.1.66', '10.0.6.154/24'), false, 'офисный узел вне /24');
  assert.equal(ipInPrefix('10.1.107.54', '10.0.6.154/24'), false);
  assert.equal(ipInPrefix('10.0.7.255', '10.0.6.154/24'), false);
  // пересечение сетей: /21 покрывает 10.0.6.x — при чистке такой записи тоже стирать
  assert.equal(ipInPrefix('10.0.6.134', '10.0.3.46/21'), true);
  assert.equal(ipInPrefix('10.0.8.1', '10.0.3.46/21'), false, '10.0.8.x за пределами /21');
});

test('мусор не признаётся попаданием', () => {
  assert.equal(ipInPrefix('не адрес', '10.0.6.154/24'), false);
  assert.equal(ipInPrefix('10.0.6.1', null), false);
  assert.equal(ipInPrefix('10.0.6.1', ''), false);
  assert.equal(ipInPrefix('10.0.6.1', '10.0.6.1/33'), false);
  assert.equal(ipInPrefix('10.0.6.1', '10.0.6.1/0'), false, 'подключаемая сеть всегда с маской');
  assert.equal(ipInPrefix('::1', '10.0.6.154/24'), false);
});
