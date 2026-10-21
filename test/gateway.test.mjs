// Шлюз: узел в двух сетях пересказывает каталог, а узел, видимый из нескольких
// сетей, остаётся одной записью с несколькими маршрутами.
//   node --test test/gateway.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PeerRegistry } from '../src/cluster/peers.js';
import { TunnelServer } from '../src/net/tunnels.js';

const NET_A = '10.0.3.0/24';
const NET_B = '10.0.6.0/24';

function registry(nodeId, networkOf) {
  const reg = new PeerRegistry({
    nodeId, realms: { keyFor: () => '' }, peerTimeoutMs: 12000, peerForgetMs: 60000,
    announceIntervalMs: 3000, gossipIntervalMs: 20000, remotePollIntervalMs: 20000, networkOf,
  });
  reg.refreshPeerState = () => {};
  return reg;
}
const announce = (reg, nodeId, address, network) => reg.onAnnounce({
  nodeId, name: nodeId.toUpperCase(), address, realm: 'open', apiPort: 47812, usbipPort: 3240,
  trafficPort: 47813, netLinkPort: 47814, stateHash: 'h', next: 3000, network,
});
const gwNetworkOf = (ip) => (ip.startsWith('10.0.3.') ? NET_A : ip.startsWith('10.0.6.') ? NET_B : null);

test('шлюз рассказывает сети B о тех, кого слышит в сети A, и не наоборот', () => {
  const gw = registry('gw', gwNetworkOf);
  announce(gw, 'a1', '10.0.3.5', NET_A);
  announce(gw, 'b1', '10.0.6.5', NET_B);

  const forB = gw.directoryEntries('open', { forNetwork: NET_B }).map((e) => e.nodeId);
  const forA = gw.directoryEntries('open', { forNetwork: NET_A }).map((e) => e.nodeId);
  assert.deepEqual(forB, ['a1']);
  assert.deepEqual(forA, ['b1']);
  assert.notEqual(gw.gatewayShape(NET_B), '', 'сети B есть что рассказать — отпечаток непустой');
});

test('узел, слышный шлюзу в обеих сетях, никому из них не пересказывается', () => {
  const gw = registry('gw', gwNetworkOf);
  announce(gw, 'x', '10.0.3.7', NET_A);
  announce(gw, 'x', '10.0.6.7', NET_B);
  assert.deepEqual(gw.directoryEntries('open', { forNetwork: NET_A }), []);
  assert.deepEqual(gw.directoryEntries('open', { forNetwork: NET_B }), []);
});

test('пересказанный узел получает маршрут через шлюз; услышанный напрямую — второй маршрут к той же записи', () => {
  const me = registry('me', () => NET_B);
  const via = { nodeId: 'gw', name: 'GW', address: '10.0.6.1', apiPort: 47812 };
  me.onDirectory([{ nodeId: 'a1', name: 'A1', address: '10.0.3.5', apiPort: 47812, usbipPort: 3240, network: NET_A }],
    { origin: 'relay', realm: 'open', viaNodeId: 'gw', viaName: 'GW', via });
  const peer = me.get('a1');
  assert.equal(peer.address, '10.0.3.5');
  assert.equal(peer.routes.size, 1);
  assert.equal(me.routesOf(peer)[0].via.name, 'GW');

  announce(me, 'a1', '10.0.6.9', NET_B);          // узел оказался и в нашей сети
  assert.equal(me.get('a1').origin, 'local');
  assert.equal(me.get('a1').address, '10.0.6.9');
  const routes = me.routesOf(me.get('a1'));
  assert.equal(routes.length, 2, 'одна запись, два адреса');
  assert.deepEqual(routes.map((r) => r.address).sort(), ['10.0.3.5', '10.0.6.9']);
  assert.equal(routes.find((r) => r.primary).address, '10.0.6.9', 'основной — услышанный напрямую');
  assert.equal(me.peers.size, 1);
});

test('endpoint: прямой маршрут отдаёт адрес узла, а маршрут через туннель — шлюз', async () => {
  const me = registry('me', () => NET_B);
  me.onDirectory([{ nodeId: 'a1', name: 'A1', address: '10.0.3.5', apiPort: 47812, usbipPort: 3240, network: NET_A }],
    { origin: 'relay', realm: 'open', viaNodeId: 'gw', via: { nodeId: 'gw', name: 'GW', address: '10.0.6.1', apiPort: 47812 } });
  const peer = me.get('a1');
  const route = me.primaryRoute(peer);
  route.mode = 'direct';
  assert.deepEqual(await me.endpoint(peer, 3240), { host: '10.0.3.5', port: 3240, tunnel: false });

  route.mode = 'tunnel';
  me.tunnelCache.set(`gw|10.0.3.5|3240`, { host: '10.0.6.1', port: 51000, until: Date.now() + 60000 });
  assert.deepEqual(await me.endpoint(peer, 3240), { host: '10.0.6.1', port: 51000, tunnel: true });
});

test('туннель пропускает только того, кто его просил, и соединяет с целью', async () => {
  const target = net.createServer((s) => s.on('data', (d) => s.write(`эхо:${d}`)));
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const tunnels = new TunnelServer({ host: '127.0.0.1' });
  try {
    const okPort = await tunnels.open({ targetHost: '127.0.0.1', targetPort: target.address().port, allowAddress: '::ffff:127.0.0.1' });
    const reply = await new Promise((resolve, reject) => {
      const c = net.connect(okPort, '127.0.0.1', () => c.write('привет'));
      c.once('data', (d) => { c.destroy(); resolve(String(d)); });
      c.once('error', reject);
    });
    assert.equal(reply, 'эхо:привет');

    const otherPort = await tunnels.open({ targetHost: '127.0.0.1', targetPort: target.address().port, allowAddress: '10.9.9.9' });
    const closed = await new Promise((resolve) => {
      const c = net.connect(otherPort, '127.0.0.1');
      c.on('close', () => resolve(true));
      c.on('error', () => {});
      setTimeout(() => resolve(false), 1500);
    });
    assert.equal(closed, true, 'чужому адресу туннель не отвечает');
  } finally {
    await tunnels.stop();
    target.close();
  }
});
