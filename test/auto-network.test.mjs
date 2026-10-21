// Автовыбор рабочей сети не должен падать на виртуальный адаптер или TAP чужой карты.
//   node --test test/auto-network.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { isVirtualInterface } from '../src/net/interfaces.js';

test('виртуальные адаптеры и TAP чужой карты узнаются', () => {
  assert.ok(isVirtualInterface({ iface: 'Ethernet 3 на KULESHOV-KV-ISP', mac: '00:ff:89:c3:7f:7c' }), 'взятая чужая карта');
  assert.ok(isVirtualInterface({ iface: 'VMware Network Adapter VMnet1', mac: '00:50:56:c0:00:01' }));
  assert.ok(isVirtualInterface({ iface: 'vEthernet (WSL)', mac: '00:15:5d:00:00:01' }));
  assert.ok(isVirtualInterface({ iface: 'Ethernet 7', mac: '00:ff:12:34:56:78' }), 'TAP-Windows по MAC');
});

test('настоящая карта виртуальной не считается', () => {
  assert.equal(isVirtualInterface({ iface: 'Ethernet 2', mac: 'd8:5e:d3:90:fe:56' }), false);
  assert.equal(isVirtualInterface({ iface: 'Подключение по локальной сети', mac: 'a0:a3:f0:d0:e5:00' }), false);
});
