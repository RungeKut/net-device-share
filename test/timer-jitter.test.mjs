// Разброс периодических таймеров: анонсы, опрос соседей, обмен каталогом, heartbeat.
//   node --test test/timer-jitter.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { jittered } from '../src/core/jitter.js';
import { Discovery } from '../src/net/discovery.js';
import { PeerRegistry } from '../src/cluster/peers.js';
import { DirectoryService } from '../src/cluster/directory.js';
import { AttachManager } from '../src/core/attachManager.js';

/** Перехват setTimeout: что и на сколько взводит код, не ожидая настоящего времени. */
async function captureTimeouts(fn) {
  const real = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (cb, ms) => { delays.push(ms); return { unref() {}, ref() {}, hasRef: () => false }; };
  try { await fn(); } finally { globalThis.setTimeout = real; }
  return delays;
}

test('jittered: границы ±доли, середина без смещения, ноль и мусор — без разброса', () => {
  assert.equal(jittered(10000, 0.15, () => 0), 8500);
  assert.equal(jittered(10000, 0.15, () => 1), 11500);
  assert.equal(jittered(10000, 0.15, () => 0.5), 10000);
  assert.equal(jittered(10000, 0, () => 0), 10000, 'ноль выключает разброс');
  assert.equal(jittered(10000, undefined, () => 0), 10000, 'не задано — как раньше');
  assert.equal(jittered(10000, 'мусор', () => 0), 10000);
  assert.equal(jittered(10000, -1, () => 0), 10000);
  assert.equal(jittered(10000, 5, () => 0), 5000, 'доля больше половины ужимается до половины');
  assert.equal(jittered(1, 0.5, () => 0), 1, 'период не бывает нулевым');
});

test('jittered: настоящая случайность укладывается в границы и действительно разбрасывает', () => {
  const seen = new Set();
  let sum = 0;
  for (let i = 0; i < 2000; i++) {
    const v = jittered(20000, 0.15);
    assert.ok(v >= 17000 && v <= 23000, `вне границ: ${v}`);
    seen.add(v);
    sum += v;
  }
  assert.ok(seen.size > 500, 'значения разные, а не одно и то же число');
  assert.ok(Math.abs(sum / 2000 - 20000) < 400, 'среднее около периода: разброс не сдвигает темп');
});

test('анонсы: следующий тик ждёт период с разбросом, а в пакете объявлен ровный', () => {
  const NET = { iface: 'Ethernet', address: '10.99.99.5', prefix: 24, cidr: '10.99.99.0/24' };
  const make = (extra) => {
    const d = new Discovery({
      nodeId: 'me', networks: [NET], port: 0, multicastAddress: '239.0.0.1',
      realms: { announcing: () => [{ realm: 'open', key: '' }], keyFor: () => '' },
      announceIntervalMs: 3000, announceIdleIntervalMs: 30000, announceTransport: 'both',
      getSnapshot: () => ({ stateHash: 'h1', name: 'me', version: '1' }),
      ...extra,
    });
    d.transport = 'both';
    d.socket = { close() {} };
    d.packets = [];
    d._send = (b) => d.packets.push(b);
    const delays = [];
    d._reschedule = (ms) => delays.push(ms);
    return { d, delays };
  };

  const low = make({ timerJitter: 0.15, random: () => 0 });
  low.d.announce('change');
  assert.deepEqual(low.delays, [2550]);
  assert.equal(low.d.packets[0].next, 3000, 'соседу объявлен ровный период — его таймаут считан от него');

  const high = make({ timerJitter: 0.15, random: () => 1 });
  high.d.announce('change');
  assert.deepEqual(high.delays, [3450]);

  const off = make({ timerJitter: 0, random: () => 0 });
  off.d.announce('change');
  assert.deepEqual(off.delays, [3000]);
});

test('анонсы: перенос из-за MIN_GAP не разбрасывается — это не период', () => {
  const NET = { iface: 'Ethernet', address: '10.99.99.5', prefix: 24, cidr: '10.99.99.0/24' };
  const d = new Discovery({
    nodeId: 'me', networks: [NET], port: 0, multicastAddress: '239.0.0.1',
    realms: { announcing: () => [{ realm: 'open', key: '' }], keyFor: () => '' },
    announceIntervalMs: 3000, announceIdleIntervalMs: 30000, announceTransport: 'both',
    timerJitter: 0.5, random: () => 0,
    getSnapshot: () => ({ stateHash: 'h1', name: 'me', version: '1' }),
  });
  d.transport = 'both';
  d.socket = { close() {} };
  d._send = () => {};
  const delays = [];
  d._reschedule = (ms) => delays.push(ms);
  d.announce('change');
  d.lastSentAt = Date.now() - 10;
  d.announce('tick');
  assert.equal(delays.length, 2);
  assert.ok(delays[1] <= 500 && delays[1] > 0, `ожидание добирает остаток зазора, а не период: ${delays[1]}`);
});

test('опрос узлов из других сетей: следующий опрос взводится с разбросом', async () => {
  const reg = new PeerRegistry({
    nodeId: 'me', realms: { keyFor: () => '' }, peerTimeoutMs: 60000, peerForgetMs: 120000,
    announceIntervalMs: 60000, gossipIntervalMs: 60000, remotePollIntervalMs: 15000,
    timerJitter: 0.2, random: () => 1,
  });
  const delays = await captureTimeouts(() => reg._scheduleRemotePoll());
  reg.stop();
  assert.deepEqual(delays, [18000]);
});

test('обмен каталогом: следующий круг взводится с разбросом', async () => {
  const reg = new PeerRegistry({
    nodeId: 'me', realms: { keyFor: () => '' }, peerTimeoutMs: 60000, peerForgetMs: 120000,
    announceIntervalMs: 60000, gossipIntervalMs: 60000, remotePollIntervalMs: 60000,
  });
  const dir = new DirectoryService({
    peers: reg, seeds: () => [], realms: { keyFor: () => '' }, intervalMs: () => 20000,
    defaultPort: () => 47812, selfEntry: () => ({ nodeId: 'me' }), networks: () => [],
    timerJitter: 0.1, random: () => 1,
  });
  const delays = await captureTimeouts(() => dir._round());
  dir.stop?.();
  assert.ok(delays.includes(22000), `в таймерах нет 22000: ${delays}`);
});

test('heartbeat аренды: цикл взводится с разбросом, stop() останавливает цепочку', async () => {
  const cfg = { nodeId: 'me', heartbeatIntervalMs: 10000, timerJitter: 0.15 };
  const mgr = new AttachManager({
    backend: { listAttached: async () => [] }, config: { get: (k) => cfg[k] }, share: {}, keyFor: () => '',
  });
  mgr.random = () => 0;
  const delays = await captureTimeouts(() => mgr._scheduleHeartbeat());
  assert.deepEqual(delays, [8500]);

  mgr.stop();
  const after = await captureTimeouts(() => mgr._scheduleHeartbeat());
  assert.deepEqual(after, [], 'после stop() таймер больше не взводится');
});

test('без timerJitter в настройках всё как раньше: ровные периоды', async () => {
  const cfg = { nodeId: 'me', heartbeatIntervalMs: 10000 };
  const mgr = new AttachManager({
    backend: { listAttached: async () => [] }, config: { get: (k) => cfg[k] }, share: {}, keyFor: () => '',
  });
  const delays = await captureTimeouts(() => mgr._scheduleHeartbeat());
  mgr.stop();
  assert.deepEqual(delays, [10000]);
});
