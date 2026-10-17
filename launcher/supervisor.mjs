#!/usr/bin/env node
// Запускающий модуль («лаунчер»): корень доверия и страховка при обновлении.
//
// Он намеренно маленький и самостоятельный: не импортирует ничего из кода
// версий (который обновляется), только свою библиотеку рядом. Меняется лишь
// установщиком. Задачи:
//   — выбрать версию и убедиться, что она цела (подпись и суммы файлов);
//     повреждённую — восстановить из архива releases/<версия>/;
//   — запустить приложение и перезапускать его, если оно упало;
//   — пробный запуск новой версии: подтверждается сообщением «здоров» от
//     приложения; не подтвердилась (упала дважды или молчит) — откат на
//     предыдущую, версия помечается «плохой», настройки возвращаются;
//   — по коду выхода 75 переключиться на другую версию без паузы.
//
//   node launcher/supervisor.mjs [параметры приложения]
//   node launcher/supervisor.mjs --install-release <файл.ndsupd> [--allow-downgrade]
//   node launcher/supervisor.mjs --verify | --status | --stop
//
// Состояние — <каталог настроек>/update/state.json; код — <база>/app/<версия>/.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trustedKeys } from './lib/keys.js';
import { compareVersions } from './lib/semver.js';
import { unpackBundle, verifyManifest } from './lib/release.js';
import {
  appDir, readState, updateState, listInstalled, verifyInstalled, restoreFromArchive, installRelease,
  prune, badKey, rmSafe, configSnapshotFile,
} from './lib/layout.js';

export const RESTART_EXIT_CODE = 75;
/** Приложение уже работает: второй экземпляр не запускаем, открываем интерфейс первого. */
export const ALREADY_RUNNING_EXIT_CODE = 77;
const HEALTH_TIMEOUT_MS = Number(process.env.NDS_HEALTH_TIMEOUT_MS) || 120000;
const MAX_TRIAL_ATTEMPTS = 2;
const BACKOFF_MS = [5000, 30000, 120000];

const BASE = process.env.NDS_BASE
  ? path.resolve(process.env.NDS_BASE)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultHome() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'net-device-share');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'net-device-share');
}

/** installed.json кладёт установщик: признак «поставлено установщиком» и каталог данных. */
function installedInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BASE, 'installed.json'), 'utf8'));
  } catch {
    return null;
  }
}

const INSTALLED = installedInfo();
// Порядок: явное задание, затем каталог установщика, затем обычный каталог пользователя.
const HOME = process.env.NDS_HOME || (INSTALLED?.home ? path.resolve(INSTALLED.home) : defaultHome());

/**
 * Установленное приложение хранит данные в общем каталоге, а не в профиле
 * того, кто его ставил. При первом запуске переносим настройки оттуда, где
 * они лежали раньше (идентификатор узла сохраняется — для сети это тот же узел).
 */
function migrateLegacyConfig() {
  if (!INSTALLED?.home || process.env.NDS_HOME) return;
  const target = path.join(HOME, 'config.json');
  const legacy = path.join(defaultHome(), 'config.json');
  try {
    if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
    fs.mkdirSync(HOME, { recursive: true });
    fs.copyFileSync(legacy, target);
    say(`настройки перенесены из ${legacy}`);
  } catch (e) {
    // Без прав администратора каталог данных недоступен на запись: это не ошибка,
    // перенос сделает запуск с правами (так бывает у проверок вроде --status).
    if (!['EPERM', 'EACCES'].includes(e.code)) say(`настройки перенести не удалось: ${e.message}`);
  }
}
const KEYS = trustedKeys();

function say(m) {
  process.stdout.write(`[лаунчер] ${m}\n`);
}
const stopFlag = () => path.join(HOME, 'update', 'stop.flag');

if (process.env.NDS_UPDATE_TEST_KEY) {
  say('ВНИМАНИЕ: включён тестовый ключ обновлений (NDS_UPDATE_TEST_KEY). Рабочая сборка так запускаться не должна.');
}

// ------------------------------------------------------------------ команды

const argv = process.argv.slice(2);
migrateLegacyConfig();

if (argv[0] === '--status') {
  process.stdout.write(JSON.stringify({ base: BASE, home: HOME, state: readState(HOME), installed: listInstalled(BASE) }, null, 2) + '\n');
  process.exit(0);
}

if (argv[0] === '--verify') {
  const st = readState(HOME);
  const ver = st.current || listInstalled(BASE).at(-1);
  if (!ver) { say('установленных версий нет'); process.exit(1); }
  const r = verifyInstalled(BASE, ver, KEYS);
  say(r.ok ? `версия ${ver} цела` : `версия ${ver} повреждена: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}

if (argv[0] === '--stop') {
  fs.mkdirSync(path.dirname(stopFlag()), { recursive: true });
  fs.writeFileSync(stopFlag(), String(Date.now()));
  say('запрошена остановка');
  process.exit(0);
}

if (argv[0] === '--adopt') {
  // После установки поверх: если установщик привёз версию новее текущей —
  // запускаем её пробным запуском (с откатом), а не молча меняем.
  process.exit(adoptInstalled());
}

if (argv[0] === '--install-release') {
  process.exit(installFromFile(argv[1], argv.includes('--allow-downgrade')));
}

function adoptInstalled() {
  for (const v of listInstalled(BASE).reverse()) {
    const check = verifyInstalled(BASE, v, KEYS);
    if (!check.ok) { say(`версия ${v} не прошла проверку: ${check.reason}`); continue; }
    updateState(HOME, (s) => {
      if (!s.current) {
        s.current = v;
        s.highestInstalled = v;
      } else if (compareVersions(v, s.current) > 0) {
        s.pending = v;
        s.attempts = 0;
        s.configSnapshot = false;
      }
      return s;
    });
    const st = readState(HOME);
    say(st.pending ? `версия ${st.pending} станет текущей при запуске (пробный запуск)` : `текущая версия: ${st.current}`);
    return 0;
  }
  say('в app/ нет ни одной целой версии');
  return 1;
}

function installFromFile(file, allowDowngrade) {
  if (!file) { say('нужен путь к файлу .ndsupd'); return 2; }
  try {
    const bundle = unpackBundle(fs.readFileSync(file));
    const manifest = verifyManifest(bundle.manifestBytes, bundle.sig, KEYS);
    const st = readState(HOME);
    if (st.highestInstalled && compareVersions(manifest.version, st.highestInstalled) <= 0 && !allowDowngrade) {
      say(`версия ${manifest.version} не новее установленной (${st.highestInstalled}); для намеренного отката добавьте --allow-downgrade`);
      return 1;
    }
    installRelease(BASE, bundle, KEYS);
    updateState(HOME, (s) => {
      if (!s.current) {
        s.current = manifest.version;
        s.highestInstalled = manifest.version;
      } else if (s.current !== manifest.version) {
        s.pending = manifest.version;
        s.attempts = 0;
        s.configSnapshot = false;
      }
      return s;
    });
    say(`версия ${manifest.version} установлена${readState(HOME).pending ? ' — станет текущей при следующем запуске (пробный запуск)' : ''}`);
    return 0;
  } catch (e) {
    say(`установка не удалась: ${e.message}`);
    return 1;
  }
}

// ------------------------------------------------------------ выбор версии

/**
 * Какую версию запускать и в каком режиме. Проверяет целостность и при
 * необходимости чинит из архива. null — запускать нечего.
 */
function chooseLaunch() {
  const st = readState(HOME);
  const candidates = [];
  if (st.pending) candidates.push({ version: st.pending, trial: true });
  if (st.current) candidates.push({ version: st.current, trial: false });
  if (st.previous && st.previous !== st.current) candidates.push({ version: st.previous, trial: false });

  if (!candidates.length) {
    // Состояния нет (первый запуск комплекта): берём лучшую установленную.
    for (const v of listInstalled(BASE).reverse()) candidates.push({ version: v, trial: false, adopt: true });
  }

  for (const c of candidates) {
    let check = verifyInstalled(BASE, c.version, KEYS);
    if (!check.ok) {
      say(`версия ${c.version} повреждена (${check.reason}) — восстанавливаю из архива`);
      try {
        restoreFromArchive(BASE, c.version, KEYS);
        check = verifyInstalled(BASE, c.version, KEYS);
      } catch (e) {
        say(`восстановить не удалось: ${e.message}`);
      }
    }
    if (check.ok) return { ...c, manifest: check.manifest };

    if (c.trial) {
      // Пробную версию собрать не вышло — это тот же провал пробы.
      failTrial(c.version, `не прошла проверку целостности: ${check.reason}`, null);
    } else {
      say(`версия ${c.version} непригодна: ${check.reason}`);
    }
  }
  return null;
}

function failTrial(version, reason, manifest) {
  updateState(HOME, (s) => {
    s.bad[badKey(version, manifest?.payload?.sha256)] = { reason, at: new Date().toISOString() };
    s.bad[badKey(version, '')] = { reason, at: new Date().toISOString() };
    s.pending = null;
    s.attempts = 0;
    return s;
  });
  restoreConfigSnapshot();
  say(`ОТКАТ: версия ${version} отвергнута (${reason}). Продолжаю на предыдущей.`);
}

function snapshotConfig() {
  // Только один раз за пробу: вторая попытка увидела бы уже изменённый файл.
  if (readState(HOME).configSnapshot) return;
  const cfg = path.join(HOME, 'config.json');
  try {
    if (!fs.existsSync(cfg)) return;
    fs.mkdirSync(path.dirname(configSnapshotFile(HOME)), { recursive: true });
    fs.copyFileSync(cfg, configSnapshotFile(HOME));
    updateState(HOME, (s) => { s.configSnapshot = true; return s; });
  } catch (e) {
    say(`копию настроек снять не удалось: ${e.message}`);
  }
}

function restoreConfigSnapshot() {
  try {
    const snap = configSnapshotFile(HOME);
    if (readState(HOME).configSnapshot && fs.existsSync(snap)) {
      fs.copyFileSync(snap, path.join(HOME, 'config.json'));
      say('настройки возвращены к состоянию до пробного запуска');
    }
  } catch (e) {
    say(`настройки вернуть не удалось: ${e.message}`);
  }
  updateState(HOME, (s) => { s.configSnapshot = false; return s; });
}

function commitTrial(version, manifest) {
  updateState(HOME, (s) => {
    s.previous = s.current && s.current !== version ? s.current : s.previous;
    s.current = version;
    s.pending = null;
    s.attempts = 0;
    s.configSnapshot = false;
    if (!s.highestInstalled || compareVersions(version, s.highestInstalled) > 0) s.highestInstalled = version;
    return s;
  });
  const st = readState(HOME);
  const stuck = prune(BASE, [st.current, st.previous].filter(Boolean));
  if (stuck.length) say(`не удалось удалить старое (занято): ${stuck.join(', ')} — повторю позже`);
  rmSafe(configSnapshotFile(HOME));
  say(`версия ${version} подтверждена`);
}

// ------------------------------------------------------------------ запуск

let child = null;
let stopping = false;

function launch(choice, appArgs) {
  const { version, trial } = choice;
  const dir = appDir(BASE, version);
  fs.mkdirSync(HOME, { recursive: true });

  if (choice.adopt) {
    updateState(HOME, (s) => {
      s.current = version;
      s.highestInstalled = s.highestInstalled || version;
      return s;
    });
  }
  if (trial) {
    snapshotConfig();
    updateState(HOME, (s) => { s.attempts = (s.attempts || 0) + 1; s.trialSince = Date.now(); return s; });
    say(`пробный запуск версии ${version} (попытка ${readState(HOME).attempts} из ${MAX_TRIAL_ATTEMPTS})`);
  } else {
    say(`запуск версии ${version}`);
  }

  return new Promise((resolve) => {
    const started = Date.now();
    let healthy = !trial;
    let healthTimer = null;
    let killedForHealth = false;

    child = spawn(process.execPath, [path.join(dir, 'src', 'main.js'), ...appArgs], {
      // Рабочий каталог — каталог данных: каталог версии нельзя ни удалить,
      // ни переименовать, пока в нём работает процесс (Windows).
      cwd: HOME,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        NDS_BASE: BASE,
        NDS_HOME: HOME,
        NDS_SUPERVISED: '1',
        NDS_RUNNING_VERSION: version,
      },
    });

    child.on('message', (m) => {
      if (m?.type === 'healthy' && trial && !healthy) {
        healthy = true;
        clearTimeout(healthTimer);
        commitTrial(version, choice.manifest);
      }
    });

    if (trial) {
      healthTimer = setTimeout(() => {
        if (healthy) return;
        say(`версия ${version} не подтвердила работоспособность за ${Math.round(HEALTH_TIMEOUT_MS / 1000)} с — останавливаю`);
        killedForHealth = true;
        try { child.kill(); } catch { /* уже вышла */ }
      }, HEALTH_TIMEOUT_MS);
    }

    child.on('error', (e) => {
      say(`не удалось запустить: ${e.message}`);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(healthTimer);
      child = null;
      resolve({ code, signal, healthy, ranMs: Date.now() - started, killedForHealth });
    });
  });
}

/** Порт интерфейса: из параметра запуска, затем из настроек, иначе стандартный. */
function wantedApiPort() {
  const i = argv.indexOf('--api-port');
  if (i >= 0 && /^\d+$/.test(argv[i + 1] || '')) return Number(argv[i + 1]);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    if (Number.isInteger(cfg.apiPort)) return cfg.apiPort;
  } catch { /* настроек ещё нет */ }
  return 47812;
}

/**
 * Отвечает ли на этом порту наше приложение. Без этой проверки второй запуск
 * (ярлык, повторный двойной клик) падал бы на занятом порту, а лаунчер
 * перезапускал бы его каждые 5 секунд без конца.
 */
function probeRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/session', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('passwordRequired')));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function openUrl(url) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true });
    c.on('error', () => {});
    c.unref();
  } catch { /* браузер не открылся — адрес уже напечатан */ }
}

async function main() {
  const port = wantedApiPort();
  if (await probeRunning(port)) {
    const url = `http://127.0.0.1:${port}/`;
    say(`приложение уже запущено — второй экземпляр не нужен. Интерфейс: ${url}`);
    if (!argv.includes('--no-open')) openUrl(url);
    return ALREADY_RUNNING_EXIT_CODE;
  }

  // Ctrl+C в консоли получают оба процесса. Приложение завершится само,
  // а мы дождёмся его выхода и выйдем следом — но не перезапустим.
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGBREAK', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; try { child?.kill('SIGTERM'); } catch { /* */ } });

  // Остановка из другой консоли (установщик, --stop): флаг-файл, потому что
  // на Windows нет мягкого сигнала завершения.
  try { fs.rmSync(stopFlag(), { force: true }); } catch { /* */ }
  const flagTimer = setInterval(() => {
    if (!fs.existsSync(stopFlag())) return;
    stopping = true;
    try { child?.send({ type: 'shutdown' }); } catch { /* */ }
    try { fs.rmSync(stopFlag(), { force: true }); } catch { /* */ }
  }, 1000);
  flagTimer.unref();

  let crashes = 0;
  for (;;) {
    const choice = chooseLaunch();
    if (!choice) {
      // Раскладки нет — запуск «из исходников» или старый комплект: код лежит в базе.
      const legacy = path.join(BASE, 'src', 'main.js');
      if (fs.existsSync(legacy)) {
        say('версий в app/ нет — запускаю код из каталога установки (самообновление выключено)');
        const r = await runLegacy(legacy);
        if (r.code === RESTART_EXIT_CODE && !stopping) continue;
        return r.code ?? 0;
      }
      say('нечего запускать: нет ни одной целой версии. Переустановите приложение.');
      return 1;
    }

    const r = await launch(choice, argv);

    if (stopping) return r.code ?? 0;
    if (r.code === 0) {
      if (choice.trial) updateState(HOME, (s) => { s.attempts = Math.max(0, (s.attempts || 0) - 1); return s; });
      return 0;                                    // пользователь остановил приложение
    }
    if (r.code === RESTART_EXIT_CODE) {
      say('приложение запросило перезапуск');
      crashes = 0;
      continue;
    }

    if (choice.trial && !r.healthy) {
      const st = readState(HOME);
      const reason = r.killedForHealth ? 'не подтвердила работоспособность вовремя' : `упала (код ${r.code ?? r.signal})`;
      if ((st.attempts || 0) >= MAX_TRIAL_ATTEMPTS) failTrial(choice.version, reason, choice.manifest);
      else say(`пробная версия ${reason}; пробую ещё раз`);
      continue;
    }

    // Упала стабильная версия: пауза нарастает, чтобы не крутиться впустую.
    crashes = r.ranMs > 300000 ? 0 : crashes + 1;
    const wait = BACKOFF_MS[Math.min(crashes - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1);
    say(`приложение завершилось с кодом ${r.code ?? r.signal}; перезапуск через ${Math.round(wait / 1000)} с`);
    await new Promise((res) => setTimeout(res, wait));
    if (stopping) return 0;
  }
}

function runLegacy(entry) {
  // Каталог данных может ещё не существовать (первый запуск): он же — рабочий каталог процесса.
  fs.mkdirSync(HOME, { recursive: true });
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [entry, ...argv], {
      cwd: HOME,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      // Без NDS_SUPERVISED: у кода «из каталога установки» (исходники, старый комплект)
      // самообновления нет — менять чужой каталог разработчика нельзя.
      env: { ...process.env, NDS_BASE: BASE, NDS_HOME: HOME },
    });
    child = c;
    c.on('exit', (code, signal) => { child = null; resolve({ code, signal }); });
  });
}

main().then((code) => process.exit(code ?? 0), (e) => {
  say(`сбой лаунчера: ${e.stack || e.message}`);
  process.exit(1);
});

