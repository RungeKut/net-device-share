// Соседи сообщают об откатах: что узел делает с этими сведениями.
//   node --test test/update/reports.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Updater } from '../../src/update/updater.js';
import { Seeder } from '../../src/update/seeder.js';
import { buildRelease } from '../../launcher/lib/release.js';
import { installRelease, writeState, defaultState } from '../../launcher/lib/layout.js';

const V = '2.2.0';

/** Сосед, который отвечает на /peer/update-status заданным списком. */
function fakePeer(bad) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/v1/peer/update-status' && bad !== null) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ running: '2.1.0', bad }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not_found"}');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const peerRec = (nodeId, port, version = '2.1.0', startedAt = Date.now() - 3600000) => ({
  nodeId, name: nodeId.toUpperCase(), address: '127.0.0.1', apiPort: port, version, startedAt, online: true, origin: 'local',
});

function setup(peers, { mode = 'auto' } = {}) {
  const app = {
    version: '2.1.0',
    config: { get: (k) => ({ nodeId: 'me', updateMode: mode, updateCanaryMinutes: 0, updateWaveStepSec: 0, updateGraceSec: 0, updateSlots: 2 }[k]) },
    peers: { list: () => peers },
    share: { claims: new Map() },
    attach: { attachments: new Map() },
    installer: { state: 'idle' },
    realms: { keyFor: () => '' },
  };
  const u = new Updater(app);
  u.home = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-rep-'));
  const restarted = [];
  u.restartInto = (v) => { restarted.push(v); };
  return { u, restarted, app };
}

const bad = (version, reason = 'не подтвердила работоспособность вовремя') => ({ version, reason, at: new Date().toISOString() });

test('опрос соседей: считаем, сколько узлов сообщили о версии; молчащие и старые узлы не мешают', async () => {
  const a = await fakePeer([bad(V), { version: 'мусор', reason: 'x' }]);
  const b = await fakePeer([bad(V, 'упала 3 раза'), bad('2.0.5')]);
  const old = await fakePeer(null);                      // старый узел без этой ручки
  const peers = [peerRec('a', a.port), peerRec('b', b.port), peerRec('old', old.port), peerRec('dead', 1)];
  const { u } = setup(peers);
  await u._pollPeers();
  assert.equal(u._reporters(V), 2);
  assert.equal(u._reporters('2.0.5'), 1);
  assert.equal(u._reporters('мусор'), 0);
  assert.deepEqual(u.reported.get(V).map((x) => x.name).sort(), ['A', 'B']);
  for (const p of [a, b, old]) p.server.close();
});

test('двое соседей откатили версию — подготовленная бросается, кандидатом она не становится', async () => {
  const a = await fakePeer([bad(V)]);
  const b = await fakePeer([bad(V)]);
  const peers = [peerRec('a', a.port, V), peerRec('b', b.port, V)];
  const { u, restarted } = setup(peers);
  u.staged = { version: V, sha256: 'x', at: Date.now() };
  await u._pollPeers();
  assert.equal(u.staged, null);
  assert.equal(u.phase, 'idle');
  assert.deepEqual(restarted, []);
  assert.equal(u._pickCandidate({ highestInstalled: null }), null, 'двух сообщений достаточно, чтобы не брать версию');
  for (const p of [a, b]) p.server.close();
});

test('один сосед откатил версию — узел не ставит её без вашего слова, в любом режиме', async () => {
  const a = await fakePeer([bad(V, 'упала 3 раза за 5 мин')]);
  const peers = [peerRec('a', a.port, V, Date.now() - 20 * 60000)];
  const { u, restarted } = setup(peers);
  u.staged = { version: V, sha256: 'x', at: Date.now() };
  await u._pollPeers();
  assert.equal(u.staged?.version, V, 'один отчёт — ещё не приговор');
  u._evaluateRestart({});
  assert.deepEqual(restarted, [], 'очередь подошла и узел свободен, но отчёт есть');
  assert.equal(u.phase, 'awaiting-approval');
  assert.match(u.message, /сосед «A» откатил версию 2\.2\.0: упала 3 раза/);

  u.approved = V;                                        // вы разрешили
  u._evaluateRestart({});
  assert.deepEqual(restarted, [V]);
  a.server.close();
});

test('отчётов нет — всё как раньше', async () => {
  const a = await fakePeer([]);
  const peers = [peerRec('a', a.port, V, Date.now() - 20 * 60000)];
  const { u, restarted } = setup(peers);
  u.staged = { version: V, sha256: 'x', at: Date.now() };
  await u._pollPeers();
  u._evaluateRestart({});
  assert.deepEqual(restarted, [V]);
  a.server.close();
});

test('отчёт снят (сосед нажал «Повторить») — подготовленная снова допускается', async () => {
  const state = { list: [bad(V)] };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ running: '2.1.0', bad: state.list }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const peers = [peerRec('a', server.address().port, V, Date.now() - 20 * 60000)];
  const { u, restarted } = setup(peers);
  u.staged = { version: V, sha256: 'x', at: Date.now() };
  await u._pollPeers();
  u._evaluateRestart({});
  assert.deepEqual(restarted, []);
  state.list = [];
  await u._pollPeers();
  u._evaluateRestart({});
  assert.deepEqual(restarted, [V]);
  server.close();
});

test('то, что мы сообщаем соседям: свои откаты по версиям, без дублей', () => {
  const { u } = setup([]);
  const st = defaultState();
  st.bad['2.2.0|abcd1234'] = { reason: 'старое', at: '2026-01-01T00:00:00.000Z' };
  st.bad['2.2.0|'] = { reason: 'новее', at: '2026-02-01T00:00:00.000Z', committed: true };
  st.bad['2.1.9|'] = { reason: 'другая', at: '2026-01-15T00:00:00.000Z' };
  writeState(u.home, st);
  const out = u.statusForPeers();
  assert.equal(out.running, '2.1.0');
  assert.deepEqual(out.bad.map((b) => b.version).sort(), ['2.1.9', '2.2.0']);
  const b220 = out.bad.find((b) => b.version === '2.2.0');
  assert.equal(b220.reason, 'новее');
  assert.equal(b220.committed, true);
});

test('работающая версия числится испорченной у соседей — это видно в снимке, но сама она не откатывается', async () => {
  const a = await fakePeer([bad('2.1.0', 'падает после запуска')]);
  const { u } = setup([peerRec('a', a.port)]);
  const st = defaultState();
  st.current = '2.1.0';
  st.previous = '2.0.0';
  writeState(u.home, st);
  await u._pollPeers();
  const snap = u.snapshot();
  assert.equal(snap.reportedRunning.version, '2.1.0');
  assert.deepEqual(snap.reportedRunning.nodes, ['A']);
  assert.equal(snap.canRollback, true);
  assert.notEqual(u.phase, 'restarting', 'сам по слову соседа узел не откатывается');
  a.server.close();
});

test('«Откатить»: просьба записывается в состояние для лаунчера; без предыдущей версии — отказ', async () => {
  const { u } = setup([]);
  assert.throws(() => u.rollbackNow(), /предыдущей версии нет/);

  const st = defaultState();
  st.current = '2.1.0';
  st.previous = '2.0.0';
  writeState(u.home, st);
  const asked = new Promise((resolve) => process.once('nds:restart', resolve));
  u.rollbackNow('по просьбе пользователя');
  const saved = JSON.parse(fs.readFileSync(path.join(u.home, 'update', 'state.json'), 'utf8'));
  assert.equal(saved.rollbackRequest.reason, 'по просьбе пользователя');
  assert.equal(u.phase, 'restarting');
  await asked;                                         // приложение действительно просит перезапуск
});

test('раздача: версию, о которой сообщили как об испорченной, соседям не отдаём', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keys = [{ keyId: 'k1', publicKey, channels: ['stable'] }];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-rep-seed-'));
  for (const v of ['2.0.0', '2.1.0']) {
    installRelease(base, buildRelease({
      files: [{ path: 'src/main.js', data: Buffer.from(v) }, { path: 'package.json', data: Buffer.from(`{"version":"${v}"}`) }],
      version: v, keyId: 'k1', privateKey,
    }), keys);
  }
  let blocked = false;
  const seeder = new Seeder({ base, keys, isBad: (v) => blocked && v === '2.1.0' });
  assert.equal(seeder.describe().version, '2.1.0');
  blocked = true;
  seeder.invalidate();
  assert.equal(seeder.describe().version, '2.0.0');
});
