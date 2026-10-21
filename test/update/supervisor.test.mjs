// Проверки лаунчера на настоящих процессах: пробный запуск, откат,
// самовосстановление, перезапуск по коду 75. Приложение — заглушки с нужным
// поведением, подписанные тестовым ключом (канал «test»).
//   node --test test/update/supervisor.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRelease, packBundle } from '../../launcher/lib/release.js';

const SUP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'launcher', 'supervisor.mjs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-sup-'));
const pubFile = path.join(work, 'test.pub.pem');
fs.writeFileSync(pubFile, publicKey);

/** Свой каталог базы и настроек на каждый тест. */
function env() {
  const dir = fs.mkdtempSync(path.join(work, 't-'));
  const base = path.join(dir, 'base');
  const home = path.join(dir, 'home');
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { base, home, dir };
}

/** Заглушка приложения. `behavior` — тело main.js; доступны HOME и VERSION. */
function release(version, behavior) {
  const main = `
    import fs from 'node:fs';
    import path from 'node:path';
    const VERSION = ${JSON.stringify(version)};
    const HOME = process.env.NDS_HOME;
    const log = (s) => fs.appendFileSync(path.join(HOME, 'runs.log'), VERSION + ' ' + s + '\\n');
    ${behavior}
  `;
  const r = buildRelease({
    files: [
      { path: 'src/main.js', data: Buffer.from(main) },
      { path: 'package.json', data: Buffer.from(JSON.stringify({ name: 'x', version, type: 'module' })) },
    ],
    version, channel: 'test', keyId: 'test', privateKey, built: '2026-01-01T00:00:00.000Z',
  });
  return packBundle(r);
}

// Лаунчер проверяет, не отвечает ли на порту интерфейса уже работающее приложение. На
// этой машине оно может быть настоящим, поэтому проверки запускают лаунчер с портом,
// который заведомо никто не слушает.
const COMMANDS = ['--install-release', '--verify', '--stop', '--status', '--adopt'];
const UNUSED_PORT = '59871';

function run(ctx, args = [], extra = {}) {
  const full = COMMANDS.includes(args[0]) ? args : [...args, '--api-port', UNUSED_PORT];
  return spawnSync(process.execPath, [SUP, ...full], {
    env: {
      ...process.env,
      NDS_BASE: ctx.base,
      NDS_HOME: ctx.home,
      NDS_UPDATE_TEST_KEY: pubFile,
      NDS_HEALTH_TIMEOUT_MS: '1500',
      ...extra,
    },
    encoding: 'utf8',
    timeout: 60000,
  });
}

function install(ctx, bundle, name) {
  const f = path.join(ctx.dir, `${name}.ndsupd`);
  fs.writeFileSync(f, bundle);
  const r = run(ctx, ['--install-release', f]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
}

const runs = (ctx) => {
  try { return fs.readFileSync(path.join(ctx.home, 'runs.log'), 'utf8').trim().split('\n'); } catch { return []; }
};
const state = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.home, 'update', 'state.json'), 'utf8'));

const OK_EXIT = `log('start'); process.exit(0);`;
const HEALTHY = `log('start'); process.send?.({ type: 'healthy' }); setTimeout(() => process.exit(0), 300);`;
const CRASH = `log('start'); process.exit(3);`;
const SILENT = `log('start'); setTimeout(() => process.exit(0), 20000);`;

test('первая установка и запуск', () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  assert.equal(state(c).current, '1.0.0');
  const r = run(c);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(runs(c), ['1.0.0 start']);
});

test('новая версия: пробный запуск подтверждается и становится текущей', () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  install(c, release('2.0.0', HEALTHY), 'v2');
  assert.equal(state(c).pending, '2.0.0');
  const r = run(c);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const s = state(c);
  assert.equal(s.current, '2.0.0');
  assert.equal(s.previous, '1.0.0');
  assert.equal(s.pending, null);
  assert.equal(s.highestInstalled, '2.0.0');
  assert.ok(fs.existsSync(path.join(c.base, 'app', '1.0.0')), 'предыдущая версия сохранена');
});

test('версия, которая падает, откатывается и помечается плохой; настройки возвращаются', () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  fs.writeFileSync(path.join(c.home, 'config.json'), '{"name":"before"}');
  install(c, release('2.0.0', `
    fs.writeFileSync(path.join(HOME, 'config.json'), '{"name":"migrated-by-v2"}');
    log('start'); process.exit(3);`), 'v2');
  const r = run(c);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const s = state(c);
  assert.equal(s.current, '1.0.0', 'остались на прежней');
  assert.equal(s.pending, null);
  assert.ok(Object.keys(s.bad).some((k) => k.startsWith('2.0.0|')), 'версия помечена плохой');
  assert.deepEqual(runs(c), ['2.0.0 start', '2.0.0 start', '1.0.0 start'], 'две пробы, затем прежняя');
  assert.equal(fs.readFileSync(path.join(c.home, 'config.json'), 'utf8'), '{"name":"before"}', 'настройки возвращены');
  assert.match(r.stdout, /ОТКАТ/);
});

test('версия, которая молчит, тоже откатывается по таймауту', () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  install(c, release('2.0.0', SILENT), 'v2');
  const r = run(c);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(state(c).current, '1.0.0');
  assert.match(r.stdout, /не подтвердила/);
});

test('повреждённая версия восстанавливается из архива', () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  fs.appendFileSync(path.join(c.base, 'app', '1.0.0', 'src', 'main.js'), '\n// подмена\n');
  fs.writeFileSync(path.join(c.base, 'app', '1.0.0', 'src', 'stray.js'), 'x');
  const r = run(c);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /восстанавливаю из архива/);
  assert.deepEqual(runs(c), ['1.0.0 start']);
  assert.ok(!fs.existsSync(path.join(c.base, 'app', '1.0.0', 'src', 'stray.js')));
});

test('код 75 — переключение без паузы', () => {
  const c = env();
  install(c, release('1.0.0', `
    const marker = path.join(HOME, 'asked');
    log('start');
    if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); process.exit(75); }
    process.exit(0);`), 'v1');
  const r = run(c);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(runs(c), ['1.0.0 start', '1.0.0 start']);
});

test('установка: откат версии запрещён без явного разрешения, подделка отвергается', () => {
  const c = env();
  install(c, release('2.0.0', OK_EXIT), 'v2');
  const old = path.join(c.dir, 'old.ndsupd');
  fs.writeFileSync(old, release('1.0.0', OK_EXIT));
  let r = run(c, ['--install-release', old]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /не новее/);
  r = run(c, ['--install-release', old, '--allow-downgrade']);
  assert.equal(r.status, 0, r.stdout);

  // чужая подпись
  const other = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const forged = packBundle(buildRelease({
    files: [{ path: 'src/main.js', data: Buffer.from('evil') }], version: '9.0.0',
    channel: 'test', keyId: 'test', privateKey: other.privateKey,
  }));
  const f = path.join(c.dir, 'forged.ndsupd');
  fs.writeFileSync(f, forged);
  r = run(c, ['--install-release', f]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /подпись не сходится/);
  assert.ok(!fs.existsSync(path.join(c.base, 'app', '9.0.0')));
});

test('без тестового ключа релиз канала test не принимается', () => {
  const c = env();
  const f = path.join(c.dir, 'v.ndsupd');
  fs.writeFileSync(f, release('1.0.0', OK_EXIT));
  const r = run(c, ['--install-release', f], { NDS_UPDATE_TEST_KEY: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /неизвестным ключом/);
});

test('остановка по флагу: приложение получает shutdown и выходит', () => {
  const c = env();
  install(c, release('1.0.0', `
    log('start');
    process.on('message', (m) => { if (m?.type === 'shutdown') { log('shutdown'); process.exit(0); } });
    setTimeout(() => process.exit(9), 30000);`), 'v1');
  // запускаем лаунчер асинхронно, ставим флаг, ждём выхода
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SUP, '--api-port', UNUSED_PORT], {
      env: { ...process.env, NDS_BASE: c.base, NDS_HOME: c.home, NDS_UPDATE_TEST_KEY: pubFile },
      stdio: 'ignore',
    });
    const t = setTimeout(() => { child.kill(); reject(new Error('лаунчер не остановился')); }, 20000);
    setTimeout(() => run(c, ['--stop']), 2500);
    child.on('exit', (code) => {
      clearTimeout(t);
      try {
        assert.equal(code, 0);
        assert.deepEqual(runs(c), ['1.0.0 start', '1.0.0 shutdown']);
        resolve();
      } catch (e) { reject(e); }
    });
  });
});


test('установленное приложение: данные из installed.json, перенос настроек, --adopt новой версии', () => {
  const c = env();
  const data = path.join(c.dir, 'ProgramData-NDS');
  const appdata = path.join(c.dir, 'AppData');
  fs.mkdirSync(path.join(appdata, 'net-device-share'), { recursive: true });
  fs.writeFileSync(path.join(appdata, 'net-device-share', 'config.json'), '{"nodeId":"keep-me"}');
  fs.writeFileSync(path.join(c.base, 'installed.json'), JSON.stringify({ home: data }));

  // NDS_HOME не задан: каталог данных берётся из installed.json
  const noHome = { NDS_HOME: '', APPDATA: appdata, XDG_CONFIG_HOME: appdata };
  const f1 = path.join(c.dir, 'v1.ndsupd');
  fs.writeFileSync(f1, release('1.0.0', OK_EXIT));
  let r = run(c, ['--install-release', f1], noHome);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(data, 'update', 'state.json')), 'состояние лежит в каталоге установщика');
  assert.equal(fs.readFileSync(path.join(data, 'config.json'), 'utf8'), '{"nodeId":"keep-me"}', 'настройки перенесены');

  // «Установщик» привёз версию новее: кладём её в app/ и просим принять
  const f2 = path.join(c.dir, 'v2.ndsupd');
  fs.writeFileSync(f2, release('2.0.0', HEALTHY));
  r = run(c, ['--install-release', f2], noHome);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run(c, ['--adopt'], noHome);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const st = JSON.parse(fs.readFileSync(path.join(data, 'update', 'state.json'), 'utf8'));
  assert.equal(st.current, '1.0.0');
  assert.equal(st.pending, '2.0.0');
});

test('запуск из исходников: нет app/ и нет каталога данных — приложение всё равно стартует', () => {
  const c = env();
  fs.mkdirSync(path.join(c.base, 'src'), { recursive: true });
  const home = path.join(c.dir, 'ещё-нет-такого-каталога');
  fs.writeFileSync(path.join(c.base, 'src', 'main.js'),
    `import fs from 'node:fs'; fs.writeFileSync(process.env.NDS_HOME + '/ran.txt', process.env.NDS_SUPERVISED || 'no');`);
  fs.writeFileSync(path.join(c.base, 'package.json'), '{"type":"module"}');
  const r = run({ ...c, home }, []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(home, 'ran.txt'), 'utf8'), 'no', 'без пометки «под лаунчером»: самообновления нет');
});

// ------------------------------------------------- «приложение уже запущено»

/** Подставное «приложение»: отвечает на /api/v1/session так же, как настоящее. */
function fakeApp(body = '{"access":"full","passwordRequired":false,"local":true}') {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url === '/api/v1/session' ? body : '{}');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** encoding: кодировка вывода; cscript печатает в OEM-кодовой странице, не в UTF-8. */
const runAsync = (cmd, args, env, { encoding = 'utf-8' } = {}) => new Promise((resolve) => {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  child.stderr.on('data', (d) => chunks.push(d));
  child.on('exit', (status) => resolve({ status, stdout: new TextDecoder(encoding).decode(Buffer.concat(chunks)) }));
});

test('второй запуск: приложение уже отвечает — второй экземпляр не стартует, лаунчер не зацикливается', async () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  const { server, port } = await fakeApp();
  try {
    const r = await runAsync(process.execPath, [SUP, '--api-port', String(port), '--no-open'], {
      NDS_BASE: c.base, NDS_HOME: c.home, NDS_UPDATE_TEST_KEY: pubFile,
    });
    assert.equal(r.status, 77, r.stdout);
    assert.match(r.stdout, /уже запущено/);
    assert.deepEqual(runs(c), [], 'приложение не запускалось');
  } finally {
    server.close();
  }
});

test('порт занят чужой программой: это не «уже запущено», приложение стартует как обычно', async () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  const { server, port } = await fakeApp('{"что-то":"чужое"}');
  try {
    const r = await runAsync(process.execPath, [SUP, '--api-port', String(port), '--no-open'], {
      NDS_BASE: c.base, NDS_HOME: c.home, NDS_UPDATE_TEST_KEY: pubFile,
    });
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(runs(c), ['1.0.0 start']);
  } finally {
    server.close();
  }
});

test('ярлык (open.vbs): работает — открыть адрес; не работает — запустить без окна', { skip: process.platform !== 'win32' }, async () => {
  const c = env();
  const VBS = path.join(path.dirname(SUP), 'open.vbs');
  const vbs = (port) => {
    fs.writeFileSync(path.join(c.home, 'config.json'), JSON.stringify({ apiPort: port }));
    return runAsync('cscript.exe', ['//nologo', VBS, '/dry'], { NDS_HOME: c.home }, { encoding: 'ibm866' });
  };

  const { server, port } = await fakeApp();
  const other = await fakeApp('{"что-то":"чужое"}');
  // Закрытие в finally: упавший assert иначе оставляет слушающий сокет, и
  // node --test после отчёта не выходит.
  try {
    let r = await vbs(port);
    assert.match(r.stdout, new RegExp(`OPEN http://127.0.0.1:${port}/`), r.stdout);
    assert.doesNotMatch(r.stdout, /START/, 'второй экземпляр не запускается');
    server.close();

    r = await vbs(port);                       // теперь никто не слушает
    assert.match(r.stdout, /START .*supervisor\.mjs"? --no-open|START .* --no-open/, r.stdout);
    assert.match(r.stdout, new RegExp(`WAIT-AND-OPEN http://127.0.0.1:${port}/`));

    r = await vbs(other.port);
    assert.match(r.stdout, /MESSAGE .*занят другой программой/, r.stdout);
  } finally {
    server.close();
    other.server.close();
  }
});

// ---------------------------------------- откат ПОДТВЕРЖДЁННОЙ версии (падает позже пробы)

const FAST = { NDS_BACKOFF_MS: '20,20,20' };
const stateOf = (c) => JSON.parse(fs.readFileSync(path.join(c.home, 'update', 'state.json'), 'utf8'));
/** Версия подтверждается сразу, а потом падает — как ошибка, которую проба не поймала. */
const HEALTHY_THEN_CRASH = `log('start'); process.send?.({ type: 'healthy' }); setTimeout(() => process.exit(3), 100);`;

test('подтверждённая версия падает несколько раз подряд — лаунчер откатывается на предыдущую', () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  install(c, release('2.0.0', HEALTHY_THEN_CRASH), 'v2');
  const r = run(c, [], FAST);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(runs(c), ['2.0.0 start', '2.0.0 start', '2.0.0 start', '1.0.0 start'], 'три падения, затем предыдущая');
  const s = stateOf(c);
  assert.equal(s.current, '1.0.0');
  assert.equal(s.previous, null);
  assert.equal(s.highestInstalled, '2.0.0', 'по сети ту же версию заново не поставят');
  const bad = Object.entries(s.bad).find(([k]) => k.startsWith('2.0.0|'));
  assert.ok(bad, 'версия помечена плохой');
  assert.equal(bad[1].committed, true);
  assert.match(r.stdout, /ОТКАТ: подтверждённая версия 2\.0\.0/);
});

test('падения из-за окружения (порт занят) не относятся к версии — откат не делаем', () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  install(c, release('2.0.0', `
    const counter = path.join(HOME, 'n');
    const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
    fs.writeFileSync(counter, String(n));
    log('start');
    process.send?.({ type: 'healthy' });
    if (n >= 5) process.exit(0);
    setTimeout(() => { console.error('Запуск не удался: listen EADDRINUSE: address already in use 0.0.0.0:47812'); process.exit(1); }, 100);`), 'v2');
  const r = run(c, [], FAST);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(runs(c).filter((x) => x === '2.0.0 start').length, 5);
  assert.ok(!runs(c).includes('1.0.0 start'), 'на старую не откатывались');
  assert.equal(stateOf(c).current, '2.0.0');
  assert.match(r.stdout, /проблему окружения/);
});

test('версия давно подтверждена — по тройке падений не откатываем (скорее виновато окружение)', () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  // 1-й запуск подтверждает версию и выходит; запуски 2-5 падают; 6-й выходит чисто
  install(c, release('2.0.0', `
    const counter = path.join(HOME, 'n');
    const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
    fs.writeFileSync(counter, String(n));
    log('start');
    process.send?.({ type: 'healthy' });
    if (n === 1 || n >= 6) process.exit(0);
    setTimeout(() => process.exit(3), 100);`), 'v2');
  let r = run(c, [], FAST);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(stateOf(c).current, '2.0.0');

  // «состарим» подтверждение на двое суток и запустим снова: пойдут падения
  const sf = path.join(c.home, 'update', 'state.json');
  const st = stateOf(c);
  st.committedAt = Date.now() - 48 * 3600 * 1000;
  fs.writeFileSync(sf, JSON.stringify(st));
  fs.rmSync(path.join(c.home, 'runs.log'), { force: true });
  r = run(c, [], FAST);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(runs(c).filter((x) => x === '2.0.0 start').length, 5, 'четыре падения и чистый выход');
  assert.ok(!runs(c).includes('1.0.0 start'), 'на старую не откатывались');
  assert.equal(stateOf(c).current, '2.0.0');
});

test('просьба откатиться (кнопка в интерфейсе) выполняется при следующем запуске', () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  install(c, release('2.0.0', HEALTHY), 'v2');
  let r = run(c);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(stateOf(c).current, '2.0.0');

  const sf = path.join(c.home, 'update', 'state.json');
  const st = stateOf(c);
  st.rollbackRequest = { reason: 'по просьбе пользователя', at: Date.now() };
  fs.writeFileSync(sf, JSON.stringify(st));
  fs.rmSync(path.join(c.home, 'runs.log'), { force: true });
  r = run(c);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(runs(c), ['1.0.0 start']);
  const after = stateOf(c);
  assert.equal(after.current, '1.0.0');
  assert.equal(after.rollbackRequest, null);
  assert.ok(Object.keys(after.bad).some((k) => k.startsWith('2.0.0|')));
});

test('откатываться некуда (предыдущей нет) — просьба снимается, приложение работает как работало', () => {
  const c = env();
  install(c, release('1.0.0', OK_EXIT), 'v1');
  const sf = path.join(c.home, 'update', 'state.json');
  const st = stateOf(c);
  st.rollbackRequest = { reason: 'x', at: Date.now() };
  fs.writeFileSync(sf, JSON.stringify(st));
  const r = run(c);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /некуда/);
  assert.equal(stateOf(c).rollbackRequest, null);
  assert.deepEqual(runs(c), ['1.0.0 start']);
});
