#!/usr/bin/env node
// Сборка и подпись релиза (артефакта обновления).
//
//   node scripts/build-update.mjs                    собрать и подписать текущую версию
//   node scripts/build-update.mjs --version 2.1.0    другая версия (не трогая package.json)
//   node scripts/build-update.mjs --channel test --key <pem> --key-id test   тестовый релиз
//
// Ключ берётся из NDS_SIGNING_KEY (путь к PEM; по умолчанию
// ~/.net-device-share-signing/k1.pem), пароль — из NDS_SIGNING_PASS. Закрытый
// ключ в репозитории не хранится и из этого скрипта никуда не копируется.
//
// Результат — dist/release/<версия>/: release.json, release.sig, payload.tar.gz
// и всё вместе одним файлом <имя>-<версия>.ndsupd (для переноса на флешке и
// для `launcher/supervisor.mjs --install-release`). Сборка воспроизводима:
// одни и те же файлы дают те же байты и ту же сумму.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRelease, packBundle, verifyManifest, verifyPayload } from '../launcher/lib/release.js';
import { TRUSTED_KEYS } from '../launcher/lib/keys.js';
import { stampVersion } from './lib/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Что входит в нагрузку. Каталоги — целиком, чтобы новые файлы попадали сами. */
const DIRS = ['src', 'docs'];
const FILES = [
  'package.json', 'README.md', 'LICENSE',
  // Всё, что запускается из кода версии. Пусковые файлы (start.bat,
  // autostart.bat) и лаунчер — не здесь: их меняет только установщик.
  'scripts/tap-relay.ps1', 'scripts/net-bridge.ps1', 'scripts/tap-device.ps1',
  'scripts/firewall-windows.ps1',
];

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}

/**
 * Файлы версии. Читаются как есть, без правки переводов строк: байты
 * должны совпадать с теми, что лежат в репозитории.
 * @param {string} root
 * @param {{version?: string}} [opts]  подставить версию в package.json (для тестов)
 */
export function collectFiles(root = ROOT, { version } = {}) {
  const files = [];
  for (const d of DIRS) {
    for (const rel of walk(root, d)) files.push(rel);
  }
  for (const f of FILES) {
    if (!fs.existsSync(path.join(root, f))) throw new Error(`нет файла ${f} — список в build-update.mjs устарел`);
    files.push(f);
  }
  return files.map((rel) => {
    let data = fs.readFileSync(path.join(root, rel));
    if (version && rel === 'package.json') {
      const pkg = JSON.parse(data.toString('utf8'));
      pkg.version = version;
      data = Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
    }
    return { path: rel, data };
  });
}

export function buildAndSign({ root = ROOT, version, channel = 'stable', keyId, privateKey, passphrase, compat }) {
  const files = collectFiles(root, { version });
  const pkgVersion = JSON.parse(files.find((f) => f.path === 'package.json').data.toString('utf8')).version;
  return buildRelease({ files, version: version || pkgVersion, channel, keyId, privateKey, passphrase, compat });
}

// ------------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? def : args[i + 1];
  };

  const keyId = opt('key-id', 'k1');
  const keyFile = opt('key', process.env.NDS_SIGNING_KEY || path.join(os.homedir(), '.net-device-share-signing', `${keyId}.pem`));
  const channel = opt('channel', 'stable');
  if (!fs.existsSync(keyFile)) {
    process.stderr.write(`Нет закрытого ключа ${keyFile}.\nСоздайте: node scripts/release-keygen.mjs --id ${keyId}\n`);
    process.exit(1);
  }

  if (!opt('version', undefined)) stampVersion(ROOT);
  const result = buildAndSign({
    version: opt('version', undefined),
    channel,
    keyId,
    privateKey: fs.readFileSync(keyFile, 'utf8'),
    passphrase: process.env.NDS_SIGNING_PASS || undefined,
  });
  const { manifest } = result;

  // Сразу проверяем собранное тем же кодом, что проверит узел: ошибку лучше
  // найти здесь, а не на сотне машин.
  const keys = channel === 'stable'
    ? TRUSTED_KEYS
    : [{ keyId, publicKey: fs.readFileSync(opt('pub', keyFile.replace(/\.pem$/, '.pub.pem')), 'utf8'), channels: [channel] }];
  const checked = verifyManifest(result.manifestBytes, result.sig, keys);
  verifyPayload(result.payload, checked);

  const out = path.join(ROOT, 'dist', 'release', manifest.version);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'release.json'), result.manifestBytes);
  fs.writeFileSync(path.join(out, 'release.sig'), result.sig.toString('base64'));
  fs.writeFileSync(path.join(out, 'payload.tar.gz'), result.payload);
  const bundle = path.join(out, `net-device-share-${manifest.version}.ndsupd`);
  fs.writeFileSync(bundle, packBundle(result));

  process.stdout.write(`Релиз ${manifest.version} (${channel}), ключ ${keyId}\n`);
  process.stdout.write(`  файлов: ${manifest.files.length}, архив ${(manifest.payload.size / 1024).toFixed(0)} КБ\n`);
  process.stdout.write(`  SHA-256 архива ${manifest.payload.sha256}\n`);
  process.stdout.write(`  ${path.relative(ROOT, bundle)}\n`);
}
