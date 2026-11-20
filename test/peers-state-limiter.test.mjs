// Лимит одновременных запросов состояния и нарастающий откат после отказа.
//   node --test test/peers-state-limiter.test.mjs
//
// Без лимита сотни узлов на старте устраивали лавину connect (замер 2026-11-12):
// каждый анонс молчащего/перегруженного соседа запускал новый запрос, и шторм
// отказов усиливал сам себя. Здесь проверяем: очередь держит параллелизм, отказ
// откладывает следующий запрос к узлу, успех снимает откат, молчун проверяется
// ping'ом раньше порога.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PeerRegistry } from '../src/cluster/peers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function registry(extra = {}) {
  return new PeerRegistry({
    nodeId: 'me', realms: { keyFor: () => '' }, peerTimeoutMs: 60000, peerForgetMs: 120000,
    announceIntervalMs: 60000, gossipIntervalMs: 60000, remotePollIntervalMs: 60000, ...extra,
  });
}

// stateHash null: анонс сам запрос состояния не запускает, его делает тест.
const announce = (port, nodeId = 'owner') => ({
  nodeId, name: nodeId.toUpperCase(), address: '127.0.0.1', apiPort: port, usbipPort: 3240, realm: 'open',
  version: '2.2.0', startedAt: Date.now(), deviceCount: 0, busyCount: 0, stateHash: null, next: 60000,
});

test('одновременных запросов состояния не больше stateSlots', async () => {
  let active = 0;
  let max = 0;
  const server = await listen((req, res) => {
    active++;
    max = Math.max(max, active);
    setTimeout(() => { active--; json(res, { ok: true, stateHash: 'h1' }); }, 80);
  });
  const reg = registry({ stateConcurrency: 2 });
  const peers = [];
  try {
    for (let i = 0; i < 6; i++) {
      const id = `n${i}`;
      reg.onAnnounce(announce(server.address().port, id));
      peers.push(reg.get(id));
    }
    await Promise.all(peers.map((p) => reg.refreshPeerState(p, 'h1').catch(() => {})));
    assert.equal(max, 2);
    assert.equal(reg.stateActive, 0);
    assert.equal(reg.stateWaiters.length, 0);
  } finally {
    server.close();
  }
});

test('после отказа запрос откладывается, успех снимает откат', async () => {
  let hits = 0;
  const server = await listen((req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(500); res.end('boom'); return; }
    json(res, { ok: true, stateHash: 'h2' });
  });
  const reg = registry();
  try {
    reg.onAnnounce(announce(server.address().port));
    const peer = reg.get('owner');
    await reg.refreshPeerState(peer, 'h1');            // отказ: HTTP 500
    assert.ok(peer.stateError);
    assert.ok(peer.stateBackoffMs >= 1000);
    const before = hits;
    await reg.refreshPeerState(peer, 'h1');            // в откате — без запроса
    assert.equal(hits, before);
    await sleep(1100);                                 // откат первой ступени — 1 с
    await reg.refreshPeerState(peer, 'h1');            // откат истёк — успех
    assert.equal(peer.stateHash, 'h2');
    assert.equal(peer.stateError, null);
    assert.equal(peer.stateBackoffMs, null);
    const after = hits;
    await reg.refreshPeerState(peer, 'h2');            // отката нет — сразу
    assert.equal(hits, after + 1);
  } finally {
    server.close();
  }
});

test('откат удваивается на каждом отказе и ограничен сверху', async () => {
  const server = await listen((req, res) => { res.writeHead(500); res.end('boom'); });
  const reg = registry();
  try {
    reg.onAnnounce(announce(server.address().port));
    const peer = reg.get('owner');
    for (let i = 1; i <= 8; i++) {
      await reg.refreshPeerState(peer, 'h1');
      const expected = i === 1 ? 1000 : Math.min(1000 * 2 ** (i - 1), 60000);
      assert.equal(peer.stateBackoffMs, expected, `отказ ${i}`);
      peer.stateBackoffUntil = 0;                      // не ждать между отказами в тесте
    }
  } finally {
    server.close();
  }
});

test('замолчавший сосед: живой отвечает, мёртвый уходит в офлайн со второй неудачи', async () => {
  const live = await listen((req, res) => {
    if (req.url === '/api/v1/peer/ping') { json(res, { ok: true, stateHash: 'h1' }); return; }
    res.writeHead(404); res.end('{}');
  });
  const reg = registry({ peerTimeoutMs: 800, announceIntervalMs: 500 });
  try {
    reg.start();
    // next 500 → порог узла 500×3+2000 = 3500; окно ping-проверки (800, 3500].
    reg.onAnnounce({ ...announce(live.address().port), next: 500 });
    const peer = reg.get('owner');
    peer.lastSeen = Date.now() - 900;
    reg._sweep();
    await sleep(150);
    assert.equal(peer.online, true);                   // живой: ping ответил
    assert.ok(Date.now() - peer.lastSeen < 900);       // счётчик молчания обнулён ответом

    const dead = await listen(() => {});
    const deadPort = dead.address().port;
    await new Promise((r) => dead.close(r));           // порт умер: connect отклоняется
    reg.onAnnounce({ ...announce(deadPort, 'ghost'), next: 500 });
    const ghost = reg.get('ghost');
    ghost.lastSeen = Date.now() - 900;
    reg._sweep();                                      // первая неудача
    await sleep(120);
    assert.equal(ghost.online, true, 'одной неудачи мало');
    reg._sweep();                                      // вторая неудача подряд
    await sleep(120);
    assert.equal(ghost.online, false);                 // мёртвый: офлайн раньше порога 3500
    await reg.stop();
  } finally {
    live.close();
  }
});

test('анонс, пришедший во время ping, отменяет пометку офлайн', async () => {
  // ping не отвечает, но ответ задержан: за это время сосед успевает анонсироваться.
  const slow = await listen((req, res) => {
    setTimeout(() => { res.writeHead(500); res.end('boom'); }, 250);
  });
  const reg = registry({ peerTimeoutMs: 800, announceIntervalMs: 500 });
  try {
    reg.onAnnounce({ ...announce(slow.address().port, 'laggy'), next: 500 });
    const peer = reg.get('laggy');
    peer.lastSeen = Date.now() - 900;
    const done = reg._checkSilent(peer);               // ping ещё висит
    await sleep(50);
    reg.onAnnounce({ ...announce(slow.address().port, 'laggy'), next: 500 }); // анонс: сосед жив
    await done;
    assert.equal(peer.online, true, 'анонс во время ping — сосед не мёртв');
    assert.equal(peer.silentPingFails ?? 0, 0);
  } finally {
    slow.close();
  }
});
