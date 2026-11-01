// Прощание узла: без пересказа запись удаляется, с живым пересказом шлюза —
// переходит на relay и живёт, пока рассказчики подтверждают.
//   node --test test/peers-bye.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerRegistry } from '../src/cluster/peers.js';

const NET_A = '10.0.3.0/24';
const NET_B = '10.0.6.0/24';

function registry(nodeId = 'me') {
  const reg = new PeerRegistry({
    nodeId, realms: { keyFor: () => '' }, peerTimeoutMs: 12000, peerForgetMs: 60000,
    announceIntervalMs: 3000, gossipIntervalMs: 20000, remotePollIntervalMs: 20000,
    networkOf: (ip) => (ip.startsWith('10.0.3.') ? NET_A : ip.startsWith('10.0.6.') ? NET_B : null),
  });
  reg.refreshPeerState = () => {};
  return reg;
}
const announce = (reg, nodeId, address) => reg.onAnnounce({
  nodeId, name: nodeId.toUpperCase(), address, realm: 'open', apiPort: 47812, usbipPort: 3240,
  stateHash: 'h', next: 3000, network: null,
});

test('прощание узла без пересказа удаляет запись, как раньше', () => {
  const reg = registry();
  announce(reg, 'a1', '10.0.3.5');
  reg.onBye({ nodeId: 'a1', realm: 'open' });
  assert.equal(reg.get('a1'), undefined);
});

test('прощание в одном круге при живом другом — узел остаётся соседом', () => {
  const reg = registry();
  announce(reg, 'a1', '10.0.3.5');
  reg.onBye({ nodeId: 'a1', realm: 'open' });
  reg.onAnnounce({
    nodeId: 'a1', name: 'A1', address: '10.0.3.5', realm: 'keyed', apiPort: 47812,
    usbipPort: 3240, stateHash: 'h', next: 3000, network: null,
  });
  assert.equal(reg.get('a1').origin, 'local');
});

test('прощание узла, о котором ещё рассказывает шлюз, — запись переходит на пересказ', () => {
  const reg = registry();
  // шлюз рассказал о узле из другой сети
  reg.onDirectory(
    [{ nodeId: 'a1', name: 'A1', address: '10.0.6.9', apiPort: 47812, usbipPort: 3240, network: NET_B }],
    { origin: 'relay', realm: 'open', viaNodeId: 'gw', viaName: 'GW', via: { nodeId: 'gw', name: 'GW', address: '10.0.3.1', apiPort: 47812 } },
  );
  // узел оказался и в нашей подсети, а потом попрощался в ней
  announce(reg, 'a1', '10.0.3.5');
  assert.equal(reg.get('a1').origin, 'local');
  assert.equal(reg.get('a1').routes.size, 2, 'прямой маршрут и пересказанный');

  reg.onBye({ nodeId: 'a1', realm: 'open' });
  const peer = reg.get('a1');
  assert.ok(peer, 'запись не удалена: о узле ещё рассказывают');
  assert.equal(peer.origin, 'relay');
  assert.equal(peer.address, '10.0.6.9', 'основной адрес — пересказанный');
  assert.equal(peer.via, 'gw');
  assert.equal(peer.viaName, 'GW');
  assert.equal(peer.routeKey, '10.0.6.9|gw');
  assert.deepEqual(peer.realmSeen, {}, 'в нашей подсети узла больше не слышно');
  assert.ok(peer.timeoutMs > 0);
});

test('пересказ, о котором давно никто не рассказывал, прощание не спасает', () => {
  const reg = registry();
  reg.onDirectory(
    [{ nodeId: 'a1', name: 'A1', address: '10.0.6.9', apiPort: 47812, usbipPort: 3240, network: NET_B }],
    { origin: 'relay', realm: 'open', viaNodeId: 'gw', viaName: 'GW', via: { nodeId: 'gw', name: 'GW', address: '10.0.3.1', apiPort: 47812 } },
  );
  const peer = reg.get('a1');
  const stale = [...peer.routes.values()][0];
  stale.lastSeen = Date.now() - 24 * 3600 * 1000;   // рассказчик замолчал давно
  announce(reg, 'a1', '10.0.3.5');
  reg.onBye({ nodeId: 'a1', realm: 'open' });
  assert.equal(reg.get('a1'), undefined, 'зомби-запись не остаётся');
});
