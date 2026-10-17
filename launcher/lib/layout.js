// Раскладка установки и операции над ней.
//
//   <base>/launcher/            запускающий модуль и эта библиотека (меняются только установщиком)
//   <base>/app/<версия>/        распакованный код версии (+ release.json и release.sig рядом)
//   <base>/releases/<версия>/   архив версии: из него распаковывают и им делятся с соседями
//   <home>/update/state.json    какая версия текущая, предыдущая, пробная
//
// Ничего не перезаписывается на месте: новая версия собирается в соседнем
// каталоге и переименовывается одним действием. На Windows так надёжнее, чем
// подмена файлов: антивирус и индексатор любят держать файлы открытыми.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyManifest, verifyPayload, sha256, ReleaseError, RELEASE_FILES } from './release.js';
import { compareVersions, isVersion } from './semver.js';

export const appDir = (base, version) => path.join(base, 'app', version);
export const releaseDir = (base, version) => path.join(base, 'releases', version);
export const stateFile = (home) => path.join(home, 'update', 'state.json');

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Повторы на EPERM/EBUSY/EACCES: на Windows файл на мгновение занимает антивирус. */
export function retrySync(fn, { tries = 6, delayMs = 150 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      sleepSync(delayMs * (i + 1));
    }
  }
  throw last;
}

export function rmSafe(p) {
  try {
    retrySync(() => fs.rmSync(p, { recursive: true, force: true }));
    return true;
  } catch {
    return false;
  }
}

/** Запись через временный файл и rename: читатель видит старое или новое целиком, но не половину. */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    retrySync(() => fs.renameSync(tmp, file));
  } catch (e) {
    rmSafe(tmp);
    throw e;
  }
}

// ----------------------------------------------------------------- состояние

export function defaultState() {
  return {
    current: null,           // версия, которую запускаем
    previous: null,          // на неё откатываемся
    pending: null,           // пробный запуск: ещё не подтверждена
    attempts: 0,             // неудачные пробные запуски pending
    highestInstalled: null,  // выше этой версии по сети можно, ниже — нельзя
    bad: {},                 // "<версия>|<sha8>" → { reason, at }: на такие не обновляться
    configSnapshot: false,   // сняли ли копию config.json перед пробой
    trialSince: null,
  };
}

export function readState(home) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
    return { ...defaultState(), ...s, bad: { ...(s.bad || {}) } };
  } catch {
    return defaultState();
  }
}

export function writeState(home, state) {
  writeFileAtomic(stateFile(home), JSON.stringify(state, null, 2));
}

/** Изменить состояние под блокировкой-«спинлоком» из rename: два писателя (лаунчер и приложение) не затирают друг друга. */
export function updateState(home, mutate) {
  const state = readState(home);
  const next = mutate(state) || state;
  writeState(home, next);
  return next;
}

export const badKey = (version, sha) => `${version}|${String(sha || '').slice(0, 8)}`;

// -------------------------------------------------------------- установка

/** Версии, для которых в base/app есть каталог. */
export function listInstalled(base) {
  try {
    return fs.readdirSync(path.join(base, 'app'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && isVersion(e.name))
      .map((e) => e.name)
      .sort(compareVersions);
  } catch {
    return [];
  }
}

/**
 * Сохранить проверенный релиз в releases/<версия>/ — архив, из которого
 * потом можно распаковать код и которым можно делиться.
 */
export function storeRelease(base, { manifestBytes, sig, payload }, manifest) {
  const dir = releaseDir(base, manifest.version);
  const staging = `${dir}.staging-${crypto.randomBytes(3).toString('hex')}`;
  fs.mkdirSync(staging, { recursive: true });
  try {
    fs.writeFileSync(path.join(staging, RELEASE_FILES.manifest), manifestBytes);
    fs.writeFileSync(path.join(staging, RELEASE_FILES.sig), sig.toString('base64'));
    fs.writeFileSync(path.join(staging, RELEASE_FILES.payload), payload);
    rmSafe(dir);
    retrySync(() => fs.renameSync(staging, dir));
  } catch (e) {
    rmSafe(staging);
    throw e;
  }
  return dir;
}

export function readStoredRelease(base, version) {
  const dir = releaseDir(base, version);
  const manifestBytes = fs.readFileSync(path.join(dir, RELEASE_FILES.manifest));
  const sig = Buffer.from(fs.readFileSync(path.join(dir, RELEASE_FILES.sig), 'utf8').trim(), 'base64');
  const payload = fs.readFileSync(path.join(dir, RELEASE_FILES.payload));
  return { manifestBytes, sig, payload };
}

/**
 * Распаковать версию в base/app/<версия>/. Файлы берутся из уже проверенных
 * записей в памяти. Каталог собирается рядом и переименовывается целиком.
 */
export function extractVersion(base, entries, { manifestBytes, sig }, version) {
  const dir = appDir(base, version);
  const staging = `${dir}.staging-${crypto.randomBytes(3).toString('hex')}`;
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const e of entries) {
      const target = path.join(staging, ...e.path.split('/'));
      if (!target.startsWith(staging + path.sep)) throw new ReleaseError('bad_path', `путь выходит из каталога: ${e.path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data);
    }
    fs.writeFileSync(path.join(staging, RELEASE_FILES.manifest), manifestBytes);
    fs.writeFileSync(path.join(staging, RELEASE_FILES.sig), sig.toString('base64'));
    rmSafe(dir);
    retrySync(() => fs.renameSync(staging, dir));
  } catch (e) {
    rmSafe(staging);
    throw e;
  }
  return dir;
}

/** Полная установка: проверить, сохранить архив, распаковать. */
export function installRelease(base, bundle, trustedKeys) {
  const manifest = verifyManifest(bundle.manifestBytes, bundle.sig, trustedKeys);
  const entries = verifyPayload(bundle.payload, manifest);
  storeRelease(base, bundle, manifest);
  extractVersion(base, entries, bundle, manifest.version);
  return manifest;
}

function walkFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(dir, r));
    else out.push(r);
  }
  return out;
}

/**
 * Цела ли распакованная версия: подпись манифеста, суммы всех файлов, нет лишних.
 * @returns {{ok: true, manifest: object} | {ok: false, reason: string}}
 */
export function verifyInstalled(base, version, trustedKeys) {
  const dir = appDir(base, version);
  try {
    const manifestBytes = fs.readFileSync(path.join(dir, RELEASE_FILES.manifest));
    const sig = Buffer.from(fs.readFileSync(path.join(dir, RELEASE_FILES.sig), 'utf8').trim(), 'base64');
    const manifest = verifyManifest(manifestBytes, sig, trustedKeys);
    if (manifest.version !== version) return { ok: false, reason: 'версия в манифесте не совпадает с каталогом' };

    const want = new Map(manifest.files.map((f) => [f.path, f]));
    const have = walkFiles(dir).filter((p) => p !== RELEASE_FILES.manifest && p !== RELEASE_FILES.sig);
    for (const p of have) {
      if (!want.has(p)) return { ok: false, reason: `лишний файл: ${p}` };
    }
    for (const f of manifest.files) {
      let data;
      try {
        data = fs.readFileSync(path.join(dir, ...f.path.split('/')));
      } catch {
        return { ok: false, reason: `нет файла: ${f.path}` };
      }
      if (data.length !== f.size || sha256(data) !== f.sha256) return { ok: false, reason: `файл изменён: ${f.path}` };
    }
    return { ok: true, manifest };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Починить версию из её архива в releases/. */
export function restoreFromArchive(base, version, trustedKeys) {
  const bundle = readStoredRelease(base, version);
  return installRelease(base, bundle, trustedKeys);
}

/** Удалить всё, кроме перечисленных версий. Возвращает, что осталось не удалённым. */
export function prune(base, keep) {
  const stuck = [];
  for (const sub of ['app', 'releases']) {
    const root = path.join(base, sub);
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      const ver = n.replace(/\.staging-.*$/, '');
      if (keep.includes(n)) continue;
      if (!n.includes('.staging-') && !isVersion(ver)) continue;   // чужое не трогаем
      if (!rmSafe(path.join(root, n))) stuck.push(path.join(sub, n));
    }
  }
  return stuck;
}

/** Куда положить снимок config.json перед пробным запуском новой версии. */
export const configSnapshotFile = (home) => path.join(home, 'update', 'config.json.snapshot');
