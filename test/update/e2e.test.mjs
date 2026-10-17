// Сквозная проверка самообновления: три настоящих узла на одной машине.
//
// A — на новой версии 1.1.0, B и C — на старой 1.0.0. Приложение — настоящий
// код из репозитория (с подставленной версией), под настоящим лаунчером,
// релизы подписаны тестовым ключом. A отдаёт всего один слот: второй из
// узлов B/C вынужден ждать и, скорее всего, скачивает уже у первого, как
// только тот подготовил версию — это и есть раздача цепочкой.
//
// Своя UDP-порт обнаружения (47911) отделяет эти узлы от настоящих в сети.
//   node --test test/update/e2e.test.mjs      (около минуты)

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packBundle } from '../../launcher/lib/release.js';
import { buildAndSign } from '../../scripts/build-update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-e2e-'));
const pubFile = path.join(work, 'test.pub.pem');
fs.writeFileSync(pubFile, publicKey);

// Каталог теста общий для всех проверок файла: убираем его один раз в конце.
after(() => fs.rmSync(work, { recursive: true, force: true }));

const bundle = (version, compat) => packBundle(buildAndSign({ version, channel: 'test', keyId: 'test', privateKey, compat }));

let nextPort = 48100 + Math.floor(Math.random() * 400) * 10;

function makeNode(name, version, extraConfig = {}, compat) {
  const dir = path.join(work, `${name}-${nextPort}`);
  const base = path.join(dir, 'base');
  const home = path.join(dir, 'home');
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const p = nextPort;
  nextPort += 10;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    name,
    apiPort: p,
    trafficPort: p + 1,
    netLinkPort: p + 2,
    usbipPort: p + 3,
    discoveryPort: 47911,
    announceIntervalMs: 1000,
    announceIdleIntervalMs: 2000,
    autoInstall: false,
    updateMode: 'auto',
    updateCanaryMinutes: 0,
    updateWaveStepSec: 1,
    ...extraConfig,
  }));
  const env = {
    ...process.env,
    NDS_BASE: base,
    NDS_HOME: home,
    NDS_UPDATE_TEST_KEY: pubFile,
    NDS_UPDATE_TICK_MS: '2000',
    NDS_UPDATE_HEALTHY_MS: '4000',
    NDS_HEALTH_TIMEOUT_MS: '60000',
  };
  // Как в установке: лаунчер лежит в базе, и приложение находит его библиотеку там.
  fs.cpSync(path.join(ROOT, 'launcher'), path.join(base, 'launcher'), { recursive: true });
  const f = path.join(dir, 'v.ndsupd');
  fs.writeFileSync(f, bundle(version, compat));
  const r = spawnSync(process.execPath, [path.join(base, 'launcher', 'supervisor.mjs'), '--install-release', f], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { name, dir, base, home, env, log: '', child: null, port: p };
}

function startNode(n) {
  n.child = spawn(process.execPath, [path.join(n.base, 'launcher', 'supervisor.mjs'), '--backend', 'mock', '--no-open'], { env: n.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const on = (d) => { n.log += d.toString(); };
  n.child.stdout.on('data', on);
  n.child.stderr.on('data', on);
}

const state = (n) => JSON.parse(fs.readFileSync(path.join(n.home, 'update', 'state.json'), 'utf8'));

async function waitFor(cond, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`не дождались: ${what}`);
}

test('B и C получают версию от A цепочкой и обновляются сами', { timeout: 240000 }, async (t) => {
  const A = makeNode('A', '1.1.0', { updateSlots: 1 });
  const B = makeNode('B', '1.0.0');
  const C = makeNode('C', '1.0.0');
  const all = [A, B, C];
  t.after(() => {
    for (const n of all) { try { n.child?.kill(); } catch { /* */ } }
  });

  for (const n of all) startNode(n);

  try {
    await waitFor(() => [B, C].every((n) => {
      try { const s = state(n); return s.current === '1.1.0' && !s.pending; } catch { return false; }
    }), 200000, 'B и C на версии 1.1.0 и подтверждены');
  } catch (e) {
    for (const n of all) process.stdout.write(`\n===== ${n.name} =====\n${n.log.slice(-3500)}\n`);
    throw e;
  }

  for (const n of [B, C]) {
    const s = state(n);
    assert.equal(s.current, '1.1.0');
    assert.equal(s.previous, '1.0.0');
    assert.equal(s.highestInstalled, '1.1.0');
    assert.ok(fs.existsSync(path.join(n.base, 'app', '1.1.0', 'src', 'main.js')));
    assert.ok(fs.existsSync(path.join(n.base, 'releases', '1.1.0', 'payload.tar.gz')), 'архив сохранён для раздачи дальше');
    assert.match(n.log, /пробный запуск версии 1.1.0/);
    assert.match(n.log, /версия 1.1.0 подтверждена/);
  }
  const got = all.flatMap((n) => [...n.log.matchAll(/версия 1\.1\.0 получена от «(\w)»/g)].map((m) => `${n.name}←${m[1]}`));
  process.stdout.write(`\nкто у кого скачал: ${got.join(', ')}\n`);
  assert.ok(got.length >= 2);
  // A ни разу не перезапускался: он и был источником
  assert.ok(!/пробный запуск/.test(A.log));
});

const apiState = (n) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: n.port, path: '/api/v1/state', headers: { 'x-nds-ui': '1' } }, (r) => {
    let b = '';
    r.on('data', (d) => { b += d; });
    r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

test('версия, которая ставится только установщиком: узел показывает, у кого его взять', { timeout: 120000 }, async (t) => {
  // A на 1.1.0, которой нужен лаунчер «из будущего», и раздаёт установщик; B на 1.0.0.
  const A = makeNode('A', '1.1.0', {}, { minLauncher: 99 });
  fs.mkdirSync(path.join(A.base, 'download'), { recursive: true });
  fs.writeFileSync(path.join(A.base, 'download', 'net-device-share-setup-1.1.0.exe'), 'установщик');
  const B = makeNode('B', '1.0.0');
  t.after(() => {
    for (const n of [A, B]) { try { n.child?.kill(); } catch { /* */ } }
  });
  startNode(A);
  startNode(B);

  let snap = null;
  try {
    await waitFor(() => { apiState(B).then((s) => { snap = s.update; }).catch(() => {}); return snap?.phase === 'needs-installer'; }, 60000, 'B сообщает «нужен установщик»');
  } catch (e) {
    for (const n of [A, B]) process.stdout.write(`
===== ${n.name} =====
${n.log.slice(-2500)}
`);
    throw e;
  }

  assert.equal(snap.installer.version, '1.1.0');
  assert.match(snap.installer.reason, /установщик/);
  assert.match(snap.installer.url, new RegExp(`^http://[0-9.]+:${A.port}/download$`));
  assert.equal(snap.installer.from, 'A');
  assert.equal(state(B).current, '1.0.0', 'версия не поставилась и не скачивалась');
  assert.ok(!fs.existsSync(path.join(B.base, 'app', '1.1.0')));
  // ссылка действительно ведёт на страницу раздачи
  const page = await new Promise((resolve, reject) => {
    http.get(snap.installer.url, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve(b)); }).on('error', reject);
  });
  assert.match(page, /net-device-share-setup-1.1.0.exe/);
});
