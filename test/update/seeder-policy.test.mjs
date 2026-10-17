// Раздача (слоты, токены) и политика безопасного перезапуска.
//   node --test test/update/seeder-policy.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRelease } from '../../launcher/lib/release.js';
import { installRelease } from '../../launcher/lib/layout.js';
import { Seeder } from '../../src/update/seeder.js';
import { safeToRestart, waveSchedule, orderSources } from '../../src/update/policy.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEYS = [{ keyId: 'k1', publicKey, channels: ['stable'] }];

function seederWith(versions, slots = 2) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-seed-'));
  for (const v of versions) {
    installRelease(base, buildRelease({
      files: [{ path: 'src/main.js', data: Buffer.from(`// ${v}`) }, { path: 'package.json', data: Buffer.from(`{"version":"${v}"}`) }],
      version: v, keyId: 'k1', privateKey,
    }), KEYS);
  }
  return { base, seeder: new Seeder({ base, keys: KEYS, slots }) };
}

test('раздача: отдаёт самую новую целую версию', () => {
  const { seeder } = seederWith(['2.0.0', '2.1.0']);
  const d = seeder.describe();
  assert.equal(d.version, '2.1.0');
  assert.equal(d.slotsFree, 2);
});

test('раздача: повреждённая версия не раздаётся, берётся предыдущая', () => {
  const { base, seeder } = seederWith(['2.0.0', '2.1.0']);
  fs.writeFileSync(path.join(base, 'releases', '2.1.0', 'payload.tar.gz'), 'мусор');
  assert.equal(seeder.describe().version, '2.0.0');
});

test('раздача: пусто — делиться нечем', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-seed-'));
  assert.equal(new Seeder({ base, keys: KEYS }).describe(), null);
});

test('слоты: лишним «занято», на один адрес — один слот, токен привязан к узлу и адресу', () => {
  const { seeder } = seederWith(['2.1.0'], 2);
  const d = seeder.describe();
  const ask = (callerId, ip) => seeder.reserve({ callerId, ip, version: d.version, sha256: d.sha256 });

  const a = ask('A', '10.0.0.1');
  assert.ok(a.granted);
  assert.deepEqual(ask('A', '10.0.0.1').token, a.token, 'повтор от того же узла — тот же слот');
  assert.ok(ask('A2', '10.0.0.1').busy, 'второй узел с того же адреса не получает слот');
  const b = ask('B', '10.0.0.2');
  assert.ok(b.granted);
  const c = ask('C', '10.0.0.3');
  assert.ok(c.busy);
  assert.ok(c.retryAfterSec >= 5 && c.retryAfterSec <= 15);

  assert.equal(seeder.begin({ token: a.token, callerId: 'B', ip: '10.0.0.1' }).error, 'forbidden', 'чужой узел');
  assert.equal(seeder.begin({ token: a.token, callerId: 'A', ip: '10.0.0.9' }).error, 'forbidden', 'чужой адрес');
  assert.equal(seeder.begin({ token: 'нет', callerId: 'A', ip: '10.0.0.1' }).error, 'forbidden');

  const t = seeder.begin({ token: a.token, callerId: 'A', ip: '10.0.0.1' });
  assert.equal(t.sha256, d.sha256);
  assert.equal(seeder.activeCount, 1);
  t.done();
  assert.ok(ask('C', '10.0.0.3').granted, 'слот освободился');
});

test('слоты: чужая сборка отвергается', () => {
  const { seeder } = seederWith(['2.1.0']);
  assert.equal(seeder.reserve({ callerId: 'A', ip: 'x', version: '2.1.0', sha256: '0'.repeat(64) }).error, 'other_build');
  assert.equal(seeder.reserve({ callerId: 'A', ip: 'x', version: '9.9.9', sha256: '0'.repeat(64) }).error, 'other_build');
});

const app = (over = {}) => ({
  config: { get: (k) => ({ nodeId: 'me', netLent: null, ...over.config }[k]) },
  share: { claims: new Map(over.claims || []) },
  attach: { attachments: new Map(over.attachments || []) },
  installer: { state: over.installer || 'idle' },
});

test('политика: свободный узел можно перезапускать', () => {
  assert.deepEqual(safeToRestart(app()), { ok: true, reasons: [] });
});

test('политика: чужие аренды, свои подключения, карта, установка, раздача — причины по-русски', () => {
  const r = safeToRestart(app({
    claims: [['usb:1', { holderId: 'other' }], ['usb:2', { holderId: 'me' }]],
    attachments: [['a', {}]],
    config: { netLent: { nic: 'x' } },
    installer: 'running',
  }), { transfersActive: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 5);
  assert.match(r.reasons[0], /заняты другими \(1\)/);
});

test('волна: канарейка, порядок по хешу, у каждой версии свой', () => {
  const waiting = [{ nodeId: 'n1' }, { nodeId: 'n2' }, { nodeId: 'n3' }];
  const sources = [{ nodeId: 'src', startedAt: 1_000_000 }];
  const w = (selfId, version = '2.1.0') => waveSchedule({
    selfId, version, sources, waiting, canaryMs: 600000, stepMs: 30000,
  });

  const ranks = ['n1', 'n2', 'n3'].map((id) => w(id).rank).sort();
  assert.deepEqual(ranks, [0, 1, 2], 'у каждого узла своё место, без повторов');
  for (const id of ['n1', 'n2', 'n3']) {
    assert.equal(w(id).eligibleAt, 1_000_000 + 600000 + w(id).rank * 30000);
  }
  // для другой версии порядок другой (хотя бы для одной из нескольких версий)
  const base = ['n1', 'n2', 'n3'].map((id) => w(id).rank).join();
  const differs = ['2.2.0', '2.3.0', '2.4.0', '3.0.0'].some((v) => ['n1', 'n2', 'n3'].map((id) => w(id, v).rank).join() !== base);
  assert.ok(differs, 'порядок зависит от версии');

  // источников нет — канарейка ещё не показала себя
  assert.equal(waveSchedule({ selfId: 'n1', version: '2.1.0', sources: [], waiting, canaryMs: 1, stepMs: 1 }).eligibleAt, null);
});

test('источники: свои подсети раньше чужих, порядок у каждого узла свой', () => {
  const peers = [
    { nodeId: 'far', origin: 'seed' },
    { nodeId: 'a', origin: 'local' }, { nodeId: 'b', origin: 'local' }, { nodeId: 'c', origin: 'local' },
  ];
  const o1 = orderSources('x', '2.1.0', peers).map((p) => p.nodeId);
  assert.equal(o1.at(-1), 'far');
  const orders = new Set(['x', 'y', 'z', 'w', 'v'].map((s) => orderSources(s, '2.1.0', peers).map((p) => p.nodeId).join()));
  assert.ok(orders.size > 1, 'узлы не выстраиваются в одну и ту же очередь к одному источнику');
});
