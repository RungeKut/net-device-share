// Исключение карты из обнаружения: автоматический выбор её пропускает, а проброс разрешается.
//   node --test test/discovery-exclude.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { resolveNetworks, listNetworks, isVirtualInterface, isPrivate } from '../src/net/interfaces.js';
import { NetShare } from '../src/core/netShare.js';

test('resolveNetworks: исключённая карта в автовыборе не возвращается', () => {
  const all = resolveNetworks('auto');
  assert.ok(all.length >= 1);
  const first = all[0].iface;
  const rest = resolveNetworks('auto', { exclude: [first] });
  assert.ok(!rest.some((n) => n.iface === first));
});

test('resolveNetworks: явная сеть исключением не затрагивается', () => {
  const some = listNetworks().find((n) => isPrivate(n.address) && !isVirtualInterface(n));
  if (!some) return;
  assert.equal(resolveNetworks(some.cidr, { exclude: [some.iface] }).length, 1);
});

function netShare({ network = 'auto', working = ['Ethernet 2'], exclude = [] } = {}) {
  const data = { network, discoveryExclude: exclude, tapAdapters: [] };
  const config = { get: (k) => data[k], set: () => {}, isShared: () => false };
  const net = new NetShare({ config, workingIface: () => working });
  net.supported = true;
  net.elevated = true;
  net.server = {};
  return net;
}
const nic = (title) => ({ title, deviceId: `net:${title}`, meta: { hardware: true, wireless: false, status: 'Up' } });

test('карта, через которую ищутся узлы (автовыбор): отказ с подсказкой, что делать', () => {
  const why = netShare().lendBlocker(nic('Ethernet 2'));
  assert.match(why, /ищет через эту карту узлы/);
  assert.match(why, /Не использовать для обнаружения/);
});

test('вручную выбранная основная сеть: другая карта пробрасывается, основная — нет', () => {
  const net = netShare({ network: '10.0.0.0/21', working: ['Ethernet 2'] });
  assert.match(net.lendBlocker(nic('Ethernet 2')), /работает само приложение/);
  assert.doesNotMatch(String(net.lendBlocker(nic('Ethernet 5'))), /приложение/);
});

test('decorate: помечает карту, задействованную в обнаружении, и исключённую', () => {
  const used = netShare().decorate({ ...nic('Ethernet 2'), meta: nic('Ethernet 2').meta });
  assert.equal(used.meta.discoveryUse, true);
  assert.equal(used.meta.discoveryAuto, true);
  const excl = netShare({ working: [], exclude: ['Ethernet 5'] }).decorate({ ...nic('Ethernet 5'), meta: nic('Ethernet 5').meta });
  assert.equal(excl.meta.discoveryUse, false);
  assert.equal(excl.meta.discoveryExcluded, true);
});

test('resolveNetworks: непубличная по RFC 1918 подсеть прямого кабеля — тоже сеть, основной остаётся частная; link-local — нет', () => {
  const mk = (iface, address, mac = 'a0:a3:f0:00:00:01') => ({ iface, address, netmask: '255.255.255.0', prefix: 24, cidr: `${address.replace(/\.\d+$/, '.0')}/24`, mac });
  const nets = [mk('Ethernet', '200.100.1.1'), mk('Ethernet 2', '10.0.3.46'), mk('Ethernet 3', '169.254.7.7'), mk('VMware Network Adapter VMnet1', '192.168.25.1', '00:50:56:c0:00:01')];
  const got = resolveNetworks('auto', { nets });
  assert.deepEqual(got.map((n) => n.iface), ['Ethernet 2', 'Ethernet']);
});
