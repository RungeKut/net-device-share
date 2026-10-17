// Релиз: подписанный архив версии.
//
// Состав:
//   release.json     манифест (версия, контрольные суммы, совместимость)
//   release.sig      подпись Ed25519 над ТОЧНЫМИ байтами release.json — без
//                    канонизации, чтобы не зависеть от порядка ключей и пробелов
//   payload.tar.gz   файлы версии
//
// Всё доверие держится на подписи. Транспорт (HMAC круга, адрес в подсети)
// ничего не гарантирует: подпись запроса не покрывает путь и метод, а в
// открытом кругу её нет вовсе. Поэтому всё, что пришло от соседа, считается
// чужим, пока не пройдёт verifyManifest и verifyPayload.

import crypto from 'node:crypto';
import { packTar, unpackTar, gzip, gunzip, pathProblem } from './tar.js';
import { isVersion, compareVersions } from './semver.js';

export const PRODUCT = 'net-device-share';
export const SCHEMA = 1;
/** Версия интерфейса между приложением и лаунчером/обновлением. */
export const UPDATE_API = 1;
export const LAUNCHER_API = 1;

export class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export { sha256 };

/** Метка времени сборки — единственное «нестабильное» поле, задаётся снаружи. */
export function buildRelease({
  files, version, channel = 'stable', keyId, privateKey, passphrase,
  built = new Date().toISOString(),
  compat = {}, revokes = [], mtime = 0,
}) {
  if (!isVersion(version)) throw new ReleaseError('bad_version', `некорректная версия: ${version}`);
  for (const f of files) {
    const why = pathProblem(f.path);
    if (why) throw new ReleaseError('bad_path', `${f.path}: ${why}`);
  }
  const payload = gzip(packTar(files, { mtime }));
  const manifest = {
    schema: SCHEMA,
    product: PRODUCT,
    version,
    channel,
    built,
    keyId,
    payload: { sha256: sha256(payload), size: payload.length },
    files: [...files]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => ({ path: f.path, sha256: sha256(f.data), size: f.data.length })),
    compat: {
      proto: 'nds/1',
      updateApi: UPDATE_API,
      minLauncher: 1,
      minNode: '20.6.0',
      platforms: ['win32', 'linux'],
      ...compat,
    },
    revokes,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const key = crypto.createPrivateKey({ key: privateKey, format: 'pem', passphrase });
  const sig = crypto.sign(null, manifestBytes, key);
  return { manifestBytes, sig, payload, manifest };
}

/**
 * Проверка манифеста и подписи.
 *
 * @param {Buffer} manifestBytes
 * @param {Buffer|string} sig  подпись (Buffer или base64)
 * @param {Array<{keyId: string, publicKey: string, channels: string[]}>} trustedKeys
 */
export function verifyManifest(manifestBytes, sig, trustedKeys) {
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length > 1024 * 1024) {
    throw new ReleaseError('bad_manifest', 'манифест отсутствует или слишком велик');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new ReleaseError('bad_manifest', 'манифест не разбирается');
  }
  if (!manifest || manifest.schema !== SCHEMA || manifest.product !== PRODUCT) {
    throw new ReleaseError('bad_manifest', 'это не манифест Net Device Share');
  }
  if (!isVersion(manifest.version)) throw new ReleaseError('bad_manifest', 'некорректная версия в манифесте');

  const trusted = trustedKeys.find((k) => k.keyId === manifest.keyId);
  if (!trusted) throw new ReleaseError('unknown_key', `подписан неизвестным ключом «${manifest.keyId}»`);
  if (!trusted.channels.includes(manifest.channel)) {
    throw new ReleaseError('bad_channel', `ключ «${trusted.keyId}» не вправе подписывать канал «${manifest.channel}»`);
  }
  const sigBuf = Buffer.isBuffer(sig) ? sig : Buffer.from(String(sig || ''), 'base64');
  let ok = false;
  try {
    ok = crypto.verify(null, manifestBytes, crypto.createPublicKey(trusted.publicKey), sigBuf);
  } catch {
    ok = false;
  }
  if (!ok) throw new ReleaseError('bad_signature', 'подпись не сходится');

  if (!manifest.payload || !/^[0-9a-f]{64}$/.test(manifest.payload.sha256 || '') || !(manifest.payload.size > 0)) {
    throw new ReleaseError('bad_manifest', 'в манифесте нет сведений о нагрузке');
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    throw new ReleaseError('bad_manifest', 'в манифесте нет списка файлов');
  }
  return manifest;
}

/**
 * Совместима ли версия с тем, что запущено здесь. Причина — по-русски,
 * её увидит человек: «нужен установщик» должно быть понятно без расшифровки.
 * @returns {string|null}
 */
export function compatProblem(manifest, { launcherApi = LAUNCHER_API, nodeVersion = process.versions.node, platform = process.platform } = {}) {
  const c = manifest.compat || {};
  if (c.platforms && !c.platforms.includes(platform)) return `версия не предназначена для ${platform}`;
  if (c.minLauncher && c.minLauncher > launcherApi) {
    return 'версии нужен более новый запускающий модуль — обновление возможно только установщиком';
  }
  if (c.minNode && compareVersions(`${nodeVersion}`.replace(/^v/, ''), c.minNode) < 0) {
    return `версии нужен Node.js ${c.minNode} или новее (сейчас ${nodeVersion}) — обновите Node.js установщиком`;
  }
  return null;
}

/** Сверка полученных файлов со списком из подписанного манифеста: ровно те же, с теми же суммами. */
export function verifyTree(entries, manifest) {
  const want = new Map(manifest.files.map((f) => [f.path, f]));
  if (want.size !== manifest.files.length) throw new ReleaseError('bad_manifest', 'повторы в списке файлов');
  if (entries.length !== want.size) throw new ReleaseError('bad_payload', 'состав архива не совпадает с манифестом');
  for (const e of entries) {
    const f = want.get(e.path);
    if (!f) throw new ReleaseError('bad_payload', `лишний файл в архиве: ${e.path}`);
    if (e.data.length !== f.size || sha256(e.data) !== f.sha256) {
      throw new ReleaseError('bad_payload', `файл повреждён или подменён: ${e.path}`);
    }
  }
}

/**
 * Проверка нагрузки: размер и сумма из подписанного манифеста, затем состав.
 * Распаковка идёт из того же буфера, который проверили, — файл на диске
 * между проверкой и распаковкой подменить нельзя.
 * @returns {Array<{path: string, data: Buffer}>}
 */
export function verifyPayload(payload, manifest) {
  if (payload.length !== manifest.payload.size) throw new ReleaseError('bad_payload', 'размер нагрузки не совпадает с манифестом');
  if (sha256(payload) !== manifest.payload.sha256) throw new ReleaseError('bad_payload', 'сумма нагрузки не совпадает с манифестом');
  let entries;
  try {
    entries = unpackTar(gunzip(payload));
  } catch (e) {
    throw new ReleaseError('bad_payload', e.message);
  }
  verifyTree(entries, manifest);
  return entries;
}

// ---------------------------------------------------- файл для переноса вручную

/** Один файл .ndsupd — для установщика и для переноса на флешке. */
export function packBundle({ manifestBytes, sig, payload }) {
  return packTar([
    { path: 'release.json', data: manifestBytes },
    { path: 'release.sig', data: Buffer.from(sig.toString('base64'), 'utf8') },
    { path: 'payload.tar.gz', data: payload },
  ]);
}

export function unpackBundle(buf) {
  const files = new Map(unpackTar(buf).map((e) => [e.path, e.data]));
  const manifestBytes = files.get('release.json');
  const sig = files.get('release.sig');
  const payload = files.get('payload.tar.gz');
  if (!manifestBytes || !sig || !payload) throw new ReleaseError('bad_bundle', 'в файле обновления не хватает частей');
  return { manifestBytes, sig: Buffer.from(sig.toString('utf8').trim(), 'base64'), payload };
}

/** Опубликованный набор: что лежит в releases/<версия>/. */
export const RELEASE_FILES = Object.freeze({ manifest: 'release.json', sig: 'release.sig', payload: 'payload.tar.gz' });
