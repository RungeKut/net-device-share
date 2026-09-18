#!/usr/bin/env node
// Сборка переносимого комплекта для Windows x64.
//
// Что получается: каталог и zip, внутри которых лежит node.exe. На целевой
// машине не нужно ставить ни Node.js, ни npm — распаковал и запустил
// start.bat. Это главное требование к комплекту: он попадает на машины,
// где установка чего бы то ни было согласуется отдельно.
//
// Чего в комплекте НЕТ: установщиков usbipd-win и usbip-win2. Они под
// GPL-3.0, и класть чужие сборки в свой архив — значит принимать на себя
// обязательства по выдаче исходных текстов. Вместо них едут manifest.json
// и scripts/fetch-installers.mjs: файлы забираются у автора и проверяются
// по SHA-256. Подробности в installers/README.md.
//
//   node scripts/build-release.mjs            собрать каталог и zip
//   node scripts/build-release.mjs --no-zip   только каталог (быстрее)

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(DIST, '.cache');

// Версия Node зафиксирована вместе с контрольной суммой: комплект должен
// собираться одинаково сегодня и через год, а не подхватывать то, что
// сейчас лежит на nodejs.org. Сумма взята из SHASUMS256.txt этого релиза.
const NODE = {
  version: 'v24.21.0',
  url: 'https://nodejs.org/dist/v24.21.0/win-x64/node.exe',
  sha256: 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32',
  licenseUrl: 'https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE',
};

// Что кладём в комплект. Каталоги копируются целиком, поэтому новые файлы
// в src/ и docs/ попадают в сборку сами, без правки этого списка.
const DIRS = ['src', 'docs'];
const FILES = [
  'start.bat',
  'package.json',
  'README.md',
  'LICENSE',
  'installers/README.md',
  'installers/manifest.json',
  'scripts/autostart.bat',
  'scripts/check-files.mjs',
  'scripts/fetch-installers.mjs',
  'scripts/firewall-windows.ps1',
];

const noZip = process.argv.includes('--no-zip');
const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const name = `${pkg.name}-${pkg.version}-win-x64`;
const OUT = path.join(DIST, name);

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });
}

/** Загрузка с поддержкой переадресации — как в fetch-installers.mjs. */
function download(url, dest, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('слишком много переадресаций'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'net-device-share' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(res.headers.location, dest, depth + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    }).on('error', reject);
  });
}

/** Скачивает файл в кэш и сверяет сумму; повторная сборка не качает заново. */
async function cached(url, file, expected) {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest) && (!expected || await sha256(dest) === expected)) {
    process.stdout.write(`  из кэша: ${file}\n`);
    return dest;
  }
  await fsp.mkdir(CACHE, { recursive: true });
  process.stdout.write(`  загрузка: ${file}\n    ${url}\n`);
  const tmp = `${dest}.part`;
  try {
    await download(url, tmp);
    if (expected) {
      const actual = await sha256(tmp);
      if (actual !== expected) {
        throw new Error(`SHA-256 не совпадает: ожидалось ${expected}, получено ${actual}`);
      }
      process.stdout.write('    сумма совпадает\n');
    }
    await fsp.rename(tmp, dest);
    return dest;
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

const START_TXT = `Net Device Share ${pkg.version} - переносимый комплект для Windows x64

ЗАПУСК
  Двойной клик по start.bat. Windows спросит права администратора: без них
  можно смотреть каталог и менять настройки, но опубликовать своё
  устройство не выйдет - привязка USB требует прав.
  Браузер откроется сам на http://127.0.0.1:47812

  Node.js ставить не нужно: node.exe лежит рядом и используется в первую
  очередь, даже если в системе установлен другой.

ПРОВЕРКА ОКРУЖЕНИЯ
  start.bat --doctor
  Покажет сеть, найденные устройства и состояние USB/IP.

ДРАЙВЕРЫ USB/IP
  Передача устройств по сети работает на usbipd-win (раздача своих) и
  usbip-win2 (подключение чужих). В комплект они не входят: это чужие
  программы под GPL-3.0. Кнопка "Установить" в интерфейсе ставит их из
  каталога installers\\windows, а наполнить его можно так:

      node.exe scripts\\fetch-installers.mjs

  Машине без интернета проще скопировать готовый каталог installers\\windows
  с другой машины - контрольные суммы проверяются в любом случае.
  Без этих драйверов приложение работает как каталог устройств: список,
  занятость, запросы, - но устройство не появится в Диспетчере устройств.

НАСТРОЙКИ
  Лежат в %APPDATA%\\net-device-share. Чтобы держать их рядом с программой
  (флешка, сменный носитель), задайте переменную NDS_HOME:

      set NDS_HOME=%~dp0data

СЕТЬ
  Нужны порты 47811/UDP (обнаружение), 47812/TCP (интерфейс и обмен),
  47813/TCP (учёт трафика). Правила брандмауэра создаёт
  scripts\\firewall-windows.ps1, запущенный от администратора.

ЛИЦЕНЗИИ
  LICENSE           - само приложение, MIT
  NODE-LICENSE.txt  - вложенный node.exe ${NODE.version}, MIT

Документация - в каталоге docs, начните с README.md.
`;

// --- сборка ---

process.stdout.write(`Сборка ${name}\n\n`);

const nodeExe = await cached(NODE.url, `node-${NODE.version}-win-x64.exe`, NODE.sha256);
const nodeLicense = await cached(NODE.licenseUrl, `node-${NODE.version}-LICENSE.txt`, null);

process.stdout.write('\n  подготовка каталога\n');
await fsp.rm(OUT, { recursive: true, force: true });
await fsp.mkdir(OUT, { recursive: true });

for (const dir of DIRS) {
  await fsp.cp(path.join(ROOT, dir), path.join(OUT, dir), { recursive: true });
}
for (const file of FILES) {
  const src = path.join(ROOT, file);
  if (!fs.existsSync(src)) throw new Error(`нет файла ${file} — список в build-release.mjs устарел`);
  const dest = path.join(OUT, file);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
}

await fsp.copyFile(nodeExe, path.join(OUT, 'node.exe'));
await fsp.copyFile(nodeLicense, path.join(OUT, 'NODE-LICENSE.txt'));
// BOM: иначе «Блокнот» на Windows 10 читает файл как ANSI и портит кириллицу.
await fsp.writeFile(path.join(OUT, 'START.txt'), '﻿' + START_TXT.replace(/\n/g, '\r\n'), 'utf8');

// Пусковой файл обязан остаться в CP866 с CRLF. Копирование этого не меняет,
// но проверить дешевле, чем потом искать, почему комплект не запускается.
const started = await fsp.readFile(path.join(OUT, 'start.bat'));
if (!/main\.js/.test(started.toString('latin1'))) throw new Error('start.bat в комплекте обрезан');
if (started.includes(0x0a) && !started.includes(0x0d)) throw new Error('start.bat в комплекте с LF');

let count = 0;
let bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else { count++; bytes += fs.statSync(full).size; }
  }
})(OUT);
process.stdout.write(`  файлов: ${count}, объём: ${(bytes / 1048576).toFixed(1)} МБ\n`);

if (noZip) {
  process.stdout.write(`\nГотово: ${path.relative(ROOT, OUT)}\n`);
  process.exit(0);
}

process.stdout.write('  упаковка в zip\n');
const zip = path.join(DIST, `${name}.zip`);
await fsp.rm(zip, { force: true });
// Compress-Archive есть в любой Windows 10 — отдельный архиватор не нужен.
execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}' -CompressionLevel Optimal`],
  { stdio: 'inherit' });

const zipSize = fs.statSync(zip).size;
process.stdout.write(`\nГотово: ${path.relative(ROOT, zip)}\n`);
process.stdout.write(`  ${(zipSize / 1048576).toFixed(1)} МБ\n`);
process.stdout.write(`  SHA-256 ${await sha256(zip)}\n`);
