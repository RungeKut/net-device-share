#!/usr/bin/env node
// Сборка установщика для Windows (Inno Setup 6).
//
//   node scripts/build-installer.mjs            собрать комплект (если нужно) и установщик
//   node scripts/build-installer.mjs --skip-bundle   взять уже готовый dist/<комплект>
//
// Нужен Inno Setup 6 (https://jrsoftware.org/isinfo.php): путь к ISCC.exe —
// из ISCC_PATH или из обычных мест установки. Установщик собирается из того же
// подписанного комплекта, что и переносимый zip, поэтому состав файлов и
// версия у них одинаковые.
//
// Результат: dist/installer/net-device-share-setup-<версия>.exe и файл .sha256 рядом.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stampVersion } from './lib/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
stampVersion(ROOT);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const bundle = path.join(ROOT, 'dist', `${pkg.name}-${version}-win-x64`);
const outDir = path.join(ROOT, 'dist', 'installer');

function findIscc() {
  const candidates = [
    process.env.ISCC_PATH,
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || null;
}

const iscc = findIscc();
if (!iscc) {
  process.stderr.write('Не найден Inno Setup 6 (ISCC.exe).\n'
    + 'Установите его (https://jrsoftware.org/isdl.php) или задайте путь в ISCC_PATH.\n');
  process.exit(3);
}

if (!process.argv.includes('--skip-bundle') || !fs.existsSync(bundle)) {
  process.stdout.write('Сборка комплекта…\n');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-release.mjs'), '--no-zip'], { stdio: 'inherit' });
}
if (!fs.existsSync(path.join(bundle, 'launcher', 'supervisor.mjs'))) {
  process.stderr.write('Комплект собран без лаунчера (нет ключа подписи) — установщик из него не имеет смысла.\n'
    + 'Создайте ключ: node scripts/release-keygen.mjs --id k1\n');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const tpl = fs.readFileSync(path.join(ROOT, 'installer', 'nds.iss.tpl'), 'utf8');
const iss = tpl
  .replaceAll('@@VERSION@@', version)
  .replaceAll('@@SOURCE@@', bundle)
  .replaceAll('@@OUTDIR@@', outDir);
const issFile = path.join(outDir, 'nds.iss');
// BOM: без него Inno Setup читает файл как ANSI и портит русский текст.
fs.writeFileSync(issFile, '\ufeff' + iss.replace(/\r?\n/g, '\r\n'), 'utf8');

process.stdout.write(`Компиляция ${path.relative(ROOT, issFile)}…\n`);
const r = spawnSync(iscc, [issFile], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);

const exe = path.join(outDir, `net-device-share-setup-${version}.exe`);
const sum = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
fs.writeFileSync(`${exe}.sha256`, `${sum}  ${path.basename(exe)}\n`);
process.stdout.write(`\nГотово: ${path.relative(ROOT, exe)}\n  ${(fs.statSync(exe).size / 1048576).toFixed(1)} МБ\n  SHA-256 ${sum}\n`);
