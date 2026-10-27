// Каталог: удалённого узла можно забрать заново, а шлюз с двумя сетями называет
// собеседнику адрес той сети, где собеседник.
//   node --test test/directory-pulled-self.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DirectoryService } from '../src/cluster/directory.js';
import { PeerRegistry } from '../src/cluster/peers.js';

const NET_A = { cidr: '10.0.3.0/24', address: '10.0.3.1', iface: 'a' };
const NET_B = { cidr: '10.0.6.0/24', address: '10.0.6.1', iface: 'b' };

function registry() {
  const reg = new PeerRegistry({
    nodeId: 'me', realms: { keyFor: () => '' }, peerTimeoutMs: 12000, peerForgetMs: 60000,
    announceIntervalMs: 3000, gossipIntervalMs: 20000, remotePollIntervalMs: 20000,
  });
  reg.refreshPeerState = () => {};
  return reg;
}
const selfEntry = () => ({ nodeId: 'me', name: 'ME', address: NET_A.address, network: NET_A.cidr, apiPort: 47812 });
function directory(peers, networks = [NET_A, NET_B]) {
  return new DirectoryService({
    seeds: () => [], realms: { serving: () => [{ realm: 'open', key: '', label: 'x', open: true }] }, peers,
    selfEntry, networks: () => networks, defaultPort: () => 47812, intervalMs: () => 20000,
  });
}
const tell = (reg) => reg.onDirectory(
  [{ nodeId: 'x', name: 'X', address: '10.0.9.5', apiPort: 47812, usbipPort: 3240 }],
  { origin: 'relay', realm: 'open', viaNodeId: 'gw', viaName: 'GW', via: { nodeId: 'gw', name: 'GW', address: '10.0.3.7', apiPort: 47812 } },
);

test('узел, рассказанный шлюзом, забыт по таймауту — каталог шлюза можно забрать снова', () => {
  const reg = registry();
  const dir = directory(reg);
  tell(reg);
  dir.pulled.set('gw', 'd1');

  reg.get('x').lastSeen = Date.now() - 10 * 60 * 1000;
  reg._sweep();
  assert.equal(reg.get('x'), undefined);
  assert.equal(dir.pulled.has('gw'), false, 'отпечаток шлюза сброшен');
});

test('узел лишь помечен офлайн — отпечаток шлюза остаётся: иначе мёртвый узел оживал бы пересказом', () => {
  const reg = registry();
  const dir = directory(reg);
  tell(reg);
  dir.pulled.set('gw', 'd1');

  reg.get('x').lastSeen = Date.now() - 70000;
  reg._sweep();
  assert.equal(reg.get('x').online, false);
  assert.equal(dir.pulled.get('gw'), 'd1');
});

test('круг убрали из настроек — отпечаток шлюза тоже сброшен', () => {
  const reg = registry();
  const dir = directory(reg);
  tell(reg);
  dir.pulled.set('gw', 'd1');
  reg.retainRealms(['other']);
  assert.equal(dir.pulled.has('gw'), false);
});

test('шлюз с двумя сетями отдаёт собеседнику адрес той сети, где тот находится', () => {
  const dir = directory(registry());

  assert.equal(dir.payload('open', NET_B.cidr).peers[0].address, NET_B.address, 'по сети собеседника');
  assert.equal(dir.payload('open', NET_B.cidr).peers[0].network, NET_B.cidr);
  assert.equal(dir.payload('open', null, '10.0.6.20').peers[0].address, NET_B.address, 'по адресу собеседника');
  assert.equal(dir.payload('open', null, '10.0.3.20').peers[0].address, NET_A.address);
  assert.equal(dir.payload('open', null, '172.16.0.5').peers[0].address, NET_A.address, 'издалека — как раньше, первая сеть');
  assert.equal(dir.payload('open', null, 'stend.local').peers[0].address, NET_A.address, 'имя вместо адреса не ломает выбор');
  assert.equal(dir.payload('open').peers[0].address, NET_A.address);
});

test('обмен с seed-ом из второй сети уносит адрес второй сети', async () => {
  let posted = null;
  const seed = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      posted = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ nodeId: 'seed', name: 'SEED', peers: [] }));
    });
  });
  await new Promise((r) => seed.listen(0, '127.0.0.1', r));
  const loop = { cidr: '127.0.0.0/8', address: '127.0.0.1', iface: 'lo' };
  const dir = directory(registry(), [NET_A, loop]);
  try {
    const port = seed.address().port;
    await dir._share(`127.0.0.1:${port}`, { host: '127.0.0.1', port }, 'me', { realm: 'open', key: '', label: 'x' }, {});
    assert.equal(posted.peers[0].address, '127.0.0.1');
    assert.equal(posted.network, loop.cidr);
  } finally {
    seed.close();
  }
});
