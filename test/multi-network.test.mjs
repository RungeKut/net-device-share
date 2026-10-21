// Узел в нескольких сетях: сосед, слышный с двух адресов, не прыгает между ними.
//   node --test test/multi-network.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerRegistry } from '../src/cluster/peers.js';
import { resolveNetworks } from '../src/net/interfaces.js';

function registry() {
  const reg = new PeerRegistry({
    nodeId: 'me', realms: { keyFor: () => '' }, peerTimeoutMs: 12000, peerForgetMs: 60000,
    announceIntervalMs: 3000, gossipIntervalMs: 20000, remotePollIntervalMs: 20000,
  });
  reg.refreshPeerState = () => {};     // состояние тянуть не у кого
  return reg;
}
const announce = (reg, address) => reg.onAnnounce({
  nodeId: 'p1', name: 'P1', address, realm: 'open', apiPort: 47812, usbipPort: 3240,
  stateHash: 'h', next: 3000, network: `${address.split('.').slice(0, 3).join('.')}.0/24`,
});

test('сосед, слышный с двух адресов, держит первый, пока он жив', () => {
  const reg = registry();
  announce(reg, '10.0.3.5');
  announce(reg, '10.0.6.5');
  announce(reg, '10.0.3.5');
  announce(reg, '10.0.6.5');
  assert.equal(reg.get('p1').address, '10.0.3.5');
});

test('прежний адрес замолчал — запись переезжает на живой', () => {
  const reg = registry();
  announce(reg, '10.0.3.5');
  reg.get('p1').seenAt['10.0.3.5'] = Date.now() - 60000;   // давно не слышали
  announce(reg, '10.0.6.5');
  assert.equal(reg.get('p1').address, '10.0.6.5');
});

test('resolveNetworks: явная сеть — одна, автовыбор не возвращает виртуальные', () => {
  const auto = resolveNetworks('auto');
  assert.ok(auto.length >= 1);
  assert.ok(auto.every((n) => !/VMware|vEthernet|TAP/i.test(n.iface)) || auto.length === 1);
  assert.deepEqual(resolveNetworks('203.0.113.0/24'), []);
});
