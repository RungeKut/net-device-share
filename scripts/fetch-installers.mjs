#!/usr/bin/env node
// Загрузка вложенных установщиков по манифесту.
//
// В публичной копии репозитория чужих бинарников нет: usbipd-win и
// usbip-win2 распространяются под GPL-3.0, и выкладывать их сборки у себя
// значит принимать на себя обязательства по выдаче исходных текстов.
// Проще и честнее брать файлы там, где их публикует автор.
//
// Манифест остаётся в репозитории целиком: в нём и адреса, и контрольные
// суммы, поэтому загруженное проверяется ровно так же, как проверялось бы
// вложенное. Подменить файл по дороге не получится.
//
//   node scripts/fetch-installers.mjs

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.NDS_INSTALLERS_DIR
  ? path.resolve(process.env.NDS_INSTALLERS_DIR)
  : path.join(ROOT, 'installers');

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });
}

/** Загрузка с поддержкой переадресации: релизы GitHub всегда через неё. */
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

const manifestPath = path.join(DIR, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  process.stderr.write(`Не найден ${manifestPath}\n`);
  process.exit(1);
}

const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
let failed = 0;

for (const c of manifest.components || []) {
  const dest = path.join(DIR, c.file);
  const name = c.file;

  if (fs.existsSync(dest)) {
    const actual = await sha256(dest);
    if (actual === String(c.sha256).toLowerCase()) {
      process.stdout.write(`  уже на месте: ${name}\n`);
      continue;
    }
    process.stdout.write(`  сумма не сходится, перекачиваем: ${name}\n`);
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  process.stdout.write(`  загрузка: ${name}\n    ${c.sourceUrl}\n`);
  const tmp = `${dest}.part`;
  try {
    await download(c.sourceUrl, tmp);
    const actual = await sha256(tmp);
    if (actual !== String(c.sha256).toLowerCase()) {
      // Файл не совпал с манифестом: не подсовываем его приложению,
      // которое запустит его от администратора.
      await fsp.rm(tmp, { force: true });
      throw new Error(`SHA-256 не совпадает: ожидалось ${c.sha256}, получено ${actual}`);
    }
    await fsp.rename(tmp, dest);
    process.stdout.write('    сумма совпадает\n');
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    process.stderr.write(`    ОШИБКА: ${e.message}\n`);
    failed++;
  }
}

if (failed) {
  process.stderr.write(`\nНе загружено файлов: ${failed}. `
    + 'Скачайте их вручную по адресам из manifest.json и положите в installers/windows.\n');
  process.exit(1);
}
process.stdout.write('\nГотово: установщики на месте и проверены.\n');
