// isVirtualInterface: границы слов в именах (Laptop/Desktop — не TAP), реальные виртуальные узнаются.
//   node --test test/virtual-iface-names.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { isVirtualInterface } from '../src/net/interfaces.js';

const real = 'a0:a3:f0:d0:e5:00';

test('настоящие карты с «tap» и «на» внутри слов не считаются виртуальными', () => {
  for (const iface of ['Laptop Wi-Fi', 'Desktop Ethernet', 'Ethernet 2', 'Беспроводная сеть на втором этаже', 'Подключение по локальной сети', 'Wi-Fi']) {
    assert.equal(isVirtualInterface({ iface, mac: real }), false, iface);
  }
});

test('реальные виртуальные адаптеры узнаются по имени', () => {
  for (const iface of ['TAP-Windows Adapter V9', 'Ethernet 4 TAP', 'vEthernet (Default Switch)', 'Docker NAT', 'DockerNAT',
    'WSL', 'vEthernet (WSL)', 'Hyper-V Virtual Ethernet', 'VMware Network Adapter VMnet8', 'VirtualBox Host-Only Network',
    'Bluetooth Network Connection', 'OpenVPN TAP-Windows6', 'Ethernet 3 на KULESHOV-KV-ISP', 'Подключение по локальной сети 2 на PC-01']) {
    assert.equal(isVirtualInterface({ iface, mac: real }), true, iface);
  }
});
