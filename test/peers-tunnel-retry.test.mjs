// Кэш туннелей сбрасывается ошибкой, а смена хеша во время запроса состояния не теряется.
//   node --test test/peers-tunnel-retry.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PeerRegistry } from '../src/cluster/peers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return false;
}
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
async function freePort() {
  const { server, port } = await listen(() => {});
  await new Promise((r) => server.close(r));
  return port;
}
const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function registry() {
  const reg = new PeerRegistry({
    nodeId: 'me', realms: { keyFor: () => '' }, peerTimeoutMs: 60000, peerForgetMs: 120000,
    announceIntervalMs: 60000, gossipIntervalMs: 60000, remotePollIntervalMs: 60000,
  });
  reg.refreshPeerState = () => {};
  return reg;
}

/** Узел, известный только через шлюз: адрес и порт прямого пути мёртвые. */
async function relayed(reg, gatewayPort) {
  const deadApi = await freePort();
  reg.onDirectory([{ nodeId: 'x', name: 'X', address: '127.0.0.1', apiPort: deadApi, usbipPort: 3240 }], {
    origin: 'relay', realm: 'open', viaNodeId: 'gw', viaName: 'GW',
    via: { nodeId: 'gw', name: 'GW', address: '127.0.0.1', apiPort: gatewayPort },
  });
  const peer = reg.get('x');
  return { peer, route: reg.primaryRoute(peer), deadApi };
}

test('ошибка пробы по туннелю сбрасывает кэш: следующая проба берёт свежий порт', async () => {
  let opened = 0;
  const owner = await listen((req, res) => json(res, { ok: true, stateHash: 'h' }));
  const gateway = await listen((req, res) => {
    if (req.url === '/api/v1/peer/tunnel') { opened++; json(res, { ok: true, port: owner.port }); } else { res.writeHead(404); res.end('{}'); }
  });
  const reg = registry();
  try {
    const { peer, route, deadApi } = await relayed(reg, gateway.port);
    const deadTunnel = await freePort();
    reg.tunnelCache.set(`gw|127.0.0.1|${deadApi}`, { host: '127.0.0.1', port: deadTunnel, until: Date.now() + 300000 });

    assert.equal(await reg.probeRoute(peer, route), null, 'в кэше мёртвый порт — проба не удалась');
    assert.ok(route.probeError, 'причина сохранена');
    assert.equal(reg.tunnelCache.size, 0, 'мёртвый туннель выброшен из кэша');
    assert.equal(opened, 0, 'шлюз пока не просили');

    assert.equal(await reg.probeRoute(peer, route), 'tunnel', 'следующая проба открывает туннель заново');
    assert.equal(opened, 1);
    assert.equal(route.probeError, null, 'удачная проба причину стирает');
  } finally {
    owner.server.close();
    gateway.server.close();
  }
});

test('причина сбоя пробы пишется в журнал не чаще раза в минуту', async () => {
  const gateway = await listen((req, res) => { res.writeHead(404); res.end('{"error":"not_found"}'); });
  const reg = registry();
  try {
    const { peer, route } = await relayed(reg, gateway.port);
    const key = `x|${route.key}`;
    await reg.probeRoute(peer, route);
    assert.ok(reg.probeLogged.has(key), 'первая ошибка записана');

    const stamp = Date.now() - 1000;
    reg.probeLogged.set(key, stamp);
    await reg.probeRoute(peer, route);
    assert.equal(reg.probeLogged.get(key), stamp, 'вторая подряд в журнал не идёт');

    reg.probeLogged.set(key, Date.now() - 61000);
    await reg.probeRoute(peer, route);
    assert.ok(reg.probeLogged.get(key) > Date.now() - 5000, 'через минуту снова пишем');
  } finally {
    gateway.server.close();
  }
});

test('ошибка запроса состояния по туннелю тоже сбрасывает его кэш', async () => {
  const reg = registry();
  const { peer, route, deadApi } = await relayed(reg, await freePort());
  route.mode = 'tunnel';
  const deadTunnel = await freePort();
  reg.tunnelCache.set(`gw|127.0.0.1|${deadApi}`, { host: '127.0.0.1', port: deadTunnel, until: Date.now() + 300000 });
  PeerRegistry.prototype.refreshPeerState.call(reg, peer, 'h');
  assert.ok(await until(() => peer.stateError), 'запрос по мёртвому туннелю не удался');
  assert.equal(reg.tunnelCache.size, 0);
});

test('хеш сменился, пока шёл запрос состояния, — после него состояние запрашивается ещё раз', async () => {
  const model = { hash: 'h1' };
  let requests = 0;
  const owner = await listen((req, res) => {
    if (req.url !== '/api/v1/peer/state') { res.writeHead(404); res.end('{}'); return; }
    requests++;
    const answer = { nodeId: 'p1', name: 'P1', stateHash: model.hash, devices: [{ deviceId: model.hash }], groups: [], requests: [] };
    setTimeout(() => json(res, answer), 150);        // ответ описывает момент запроса, а доходит позже
  });
  const real = new PeerRegistry({
    nodeId: 'me', realms: { keyFor: () => '' }, peerTimeoutMs: 60000, peerForgetMs: 120000,
    announceIntervalMs: 60000, gossipIntervalMs: 60000, remotePollIntervalMs: 60000,
  });
  try {
    real.onAnnounce({ nodeId: 'p1', name: 'P1', address: '127.0.0.1', realm: 'open', apiPort: owner.port, usbipPort: 3240, stateHash: 'h1', next: 60000 });
    const peer = real.get('p1');
    assert.ok(await until(() => requests === 1), 'первый запрос ушёл');

    model.hash = 'h2';
    real.onAnnounce({ nodeId: 'p1', name: 'P1', address: '127.0.0.1', realm: 'open', apiPort: owner.port, usbipPort: 3240, stateHash: 'h2', next: 60000 });
    assert.equal(requests, 1, 'второй параллельно не запускается');

    assert.ok(await until(() => peer.stateHash === 'h2'), 'смена хеша не потеряна');
    assert.equal(requests, 2);
    assert.equal(peer.devices[0].deviceId, 'h2');
  } finally {
    owner.server.close();
  }
});
