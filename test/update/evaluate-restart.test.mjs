// Когда узел с подготовленной версией решает перезапуститься.
//   node --test test/update/evaluate-restart.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Updater } from '../../src/update/updater.js';

const V = '2.2.0';

/** Минимум приложения, нужный updater.evaluate: настройки, список узлов, занятость. */
function setup({ peers = [], mode = 'auto', busy = false, canaryMin = 10, stepSec = 30 } = {}) {
  const config = {
    get: (k) => ({
      nodeId: 'me', updateMode: mode, updateCanaryMinutes: canaryMin, updateWaveStepSec: stepSec, updateSlots: 2,
    }[k]),
  };
  const app = {
    version: '2.1.0',
    config,
    peers: { list: () => peers },
    share: { claims: new Map(busy ? [['usb:1', { holderId: 'other' }]] : []) },
    attach: { attachments: new Map() },
    installer: { state: 'idle' },
    realms: { keyFor: () => '' },
  };
  const u = new Updater(app);
  u.staged = { version: V, sha256: 'x', at: Date.now() };
  const restarted = [];
  u.restartInto = (v) => { restarted.push(v); };
  return { u, restarted };
}

const peer = (nodeId, version, startedAt = Date.now() - 3600000) => ({ nodeId, name: nodeId, version, startedAt, online: true, origin: 'local' });

test('канарейка работает дольше срока, узел свободен — перезапуск', () => {
  const { u, restarted } = setup({ peers: [peer('canary', V, Date.now() - 11 * 60000)] });
  u._evaluateRestart({});
  assert.deepEqual(restarted, [V]);
});

test('канарейка работает меньше срока — узел ждёт и называет своё место в очереди', () => {
  const { u, restarted } = setup({ peers: [peer('canary', V, Date.now() - 60000)] });
  u._evaluateRestart({});
  assert.deepEqual(restarted, []);
  assert.equal(u.phase, 'waiting');
  assert.match(u.message, /очередь: \d+-й, перезапуск примерно через \d+ с/);
});

test('ни один узел не работает на новой версии (канарейка откатилась или пропала) — не перезапускаемся', () => {
  const { u, restarted } = setup({ peers: [peer('other-old', '2.1.0')] });
  u._evaluateRestart({});
  assert.deepEqual(restarted, [], 'версию никто не проверил в работе');
  assert.equal(u.phase, 'waiting');
  assert.match(u.message, /ни один узел сейчас не работает на этой версии/);

  const alone = setup({ peers: [] });
  alone.u._evaluateRestart({});
  assert.deepEqual(alone.restarted, []);
});

test('узел занят — ждёт, даже если очередь подошла', () => {
  const { u, restarted } = setup({ busy: true, peers: [peer('canary', V, Date.now() - 20 * 60000)] });
  u._evaluateRestart({});
  assert.deepEqual(restarted, []);
  assert.match(u.message, /заняты другими/);
});

test('режим «спрашивать»: без разрешения не перезапускается, с разрешением — да', () => {
  const { u, restarted } = setup({ mode: 'ask', peers: [peer('canary', V, Date.now() - 20 * 60000)] });
  u._evaluateRestart({});
  assert.deepEqual(restarted, []);
  assert.equal(u.phase, 'awaiting-approval');
  u.approved = V;
  u._evaluateRestart({});
  assert.deepEqual(restarted, [V]);
});

test('нулевая «канарейка» и шаг (настройка для проверок) — перезапуск сразу', () => {
  const { u, restarted } = setup({ canaryMin: 0, stepSec: 0, peers: [peer('canary', V, Date.now() - 1000)] });
  u._evaluateRestart({});
  assert.deepEqual(restarted, [V]);
});

test('очередь: у двух ожидающих узлов места разные, и позже идущий ждёт на шаг дольше', () => {
  // оба видят одну и ту же картину: канарейка, и два старых узла (me и other)
  const base = [peer('canary', V, Date.now() - 10 * 60000 + 5000), peer('other', '2.1.0')];
  const { u } = setup({ peers: base, stepSec: 30 });
  u._evaluateRestart({});
  const mine = u.eligibleAt;
  assert.ok(mine, 'время перезапуска рассчитано');
  // «me» занимает место 0 или 1: время — срок канарейки плюс 0 или 30 с
  const canaryReady = base[0].startedAt + 10 * 60000;
  assert.ok([0, 30000].includes(mine - canaryReady), `eligibleAt = канарейка + место × шаг (разница ${mine - canaryReady})`);
});

// ------------------------------- подготовленная версия не должна «приклеивать» узел

test('соседи показывают версию новее подготовленной — узел берёт новую, а не ждёт старую', async () => {
  const { u } = setup({ peers: [{ ...peer('canary', '2.3.0'), address: '127.0.0.1', apiPort: 1 }] });
  u.staged = { version: V, sha256: 'x', at: Date.now() };       // подготовлена 2.2.0, но у соседей уже 2.3.0
  await u.tick();
  assert.equal(u.staged, null, 'устаревшая подготовленная брошена');
  assert.equal(u.candidate?.version, '2.3.0');
});

test('подготовленная всё ещё самая новая — узел продолжает ждать её', async () => {
  const { u } = setup({ peers: [peer('canary', V, Date.now() - 60000)] });
  await u.tick();
  assert.equal(u.staged?.version, V);
  assert.equal(u.phase, 'waiting');
});

test('версию давно никто не раздаёт и не проверяет — подготовленную забываем', () => {
  const { u, restarted } = setup({ peers: [peer('other-old', '2.1.0')] });
  u._evaluateRestart({});
  assert.equal(u.staged?.version, V, 'сразу не забываем');
  u.noSourceSince = Date.now() - 61 * 60000;
  u._evaluateRestart({});
  assert.equal(u.staged, null);
  assert.equal(u.phase, 'idle');
  assert.deepEqual(restarted, []);
});

test('источник вернулся — отсчёт забывания сбрасывается', () => {
  const peers = [peer('other-old', '2.1.0')];
  const { u } = setup({ peers });
  u._evaluateRestart({});
  assert.ok(u.noSourceSince);
  peers.push(peer('canary', V, Date.now() - 60000));
  u._evaluateRestart({});
  assert.equal(u.noSourceSince, null);
});
