#!/usr/bin/env node
// Проверка файловых инвариантов, которые легко сломать незаметно.
//
// Появилась не на пустом месте: пакетный файл дважды терял переводы строк
// CRLF после массового `sed -i` (sed в Git Bash срезает CR), и приложение
// переставало запускаться — при этом ни один обычный тест этого не ловил.
// Здесь проверяется то, что не видно в diff и не проявляется до запуска.
//
//   node scripts/check-files.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const checked = [];

function check(label, condition, detail) {
  checked.push(label);
  if (!condition) problems.push(`${label}: ${detail}`);
}

function walk(dir, ext, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, acc);
    else if (entry.name.endsWith(ext)) acc.push(full);
  }
  return acc;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function isValidUtf8(buf) {
  // Строгая проверка: CP866 почти всегда даёт недопустимые последовательности.
  return Buffer.compare(Buffer.from(buf.toString('utf8'), 'utf8'), buf) === 0;
}

// --- пакетные файлы Windows: CP866 + CRLF, без BOM ---
for (const file of walk(ROOT, '.bat')) {
  const buf = fs.readFileSync(file);
  const name = rel(file);

  let lf = 0;
  let bare = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    lf++;
    if (i === 0 || buf[i - 1] !== 0x0d) bare++;
  }
  check(`${name}: переводы строк CRLF`, bare === 0,
    `${bare} из ${lf} строк без CR — cmd разъедется на goto и блоках`);

  check(`${name}: без BOM`, !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf),
    'BOM в .bat печатается как мусор первой строкой');

  const hasHighBytes = buf.some((b) => b >= 0x80);
  if (hasHighBytes) {
    check(`${name}: кодировка CP866`, !isValidUtf8(buf),
      'файл похож на UTF-8; cmd прочтёт кириллицу как мусор, нужна CP866');
  }

  // Признак обрезанного файла. Перекодировка в CP866 обрывается на первом
  // символе, которого в ней нет (типографские кавычки, тире), — и файл
  // молча теряет хвост. Пусковой файл без запуска приложения бесполезен,
  // так что это надёжный и дешёвый признак целостности.
  check(`${name}: содержит запуск приложения или сборки`,
    /main\.js|supervisor\.mjs|build-installer\.mjs|publish-release\.mjs/.test(buf.toString('latin1')),
    'в файле нет вызова main.js, supervisor.mjs, build-installer.mjs или publish-release.mjs — похоже, он обрезан при перекодировке');
}

// --- скрипты Windows Script Host: UTF-16 LE с BOM ---
// WSH не читает UTF-8: кириллица в сообщениях превращается в мусор.
for (const file of walk(ROOT, '.vbs')) {
  const buf = fs.readFileSync(file);
  check(`${rel(file)}: UTF-16 LE с BOM`, buf[0] === 0xff && buf[1] === 0xfe,
    'без BOM UTF-16 Windows Script Host читает файл как ANSI');
}

// --- скрипты PowerShell: UTF-8 с BOM ---
for (const file of walk(ROOT, '.ps1')) {
  const buf = fs.readFileSync(file);
  const name = rel(file);
  const hasHighBytes = buf.some((b) => b >= 0x80);
  if (!hasHighBytes) continue; // чистый ASCII — BOM не нужен
  check(`${name}: UTF-8 с BOM`, buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    'без BOM PowerShell 5.1 читает файл как ANSI и портит кириллицу');
}

// --- скрипты для Unix: только LF ---
for (const file of walk(ROOT, '.sh')) {
  const buf = fs.readFileSync(file);
  check(`${rel(file)}: переводы строк LF`, !buf.includes(0x0d),
    'CR в shell-скрипте ломает shebang и строки на Linux');
}

// --- вложенные установщики соответствуют манифесту ---
const manifestPath = path.join(ROOT, 'installers', 'manifest.json');
if (fs.existsSync(manifestPath)) {
  const { createHash } = await import('node:crypto');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const c of manifest.components || []) {
    const file = path.join(ROOT, 'installers', c.file);
    if (!fs.existsSync(file)) {
      // Отсутствие файла — не нарушение: в публичной копии репозитория
      // чужих бинарников нет, они загружаются отдельно. Нарушением было бы
      // несовпадение суммы у файла, который есть.
      checked.push(`installers/${c.file}: не загружен`);
      process.stdout.write(`  · ${c.file} отсутствует — запустите node scripts/fetch-installers.mjs\n`);
      continue;
    }
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    check(`installers/${c.file}: SHA-256`, actual === String(c.sha256).toLowerCase(),
      `в манифесте ${c.sha256}, фактически ${actual}`);
  }
}

// --- числовые поля интерфейса: шаг не должен отсекать круглые значения ---
//
// Браузер отсчитывает допустимые значения не от нуля, а от min. При
// min="1" step="5" годятся 1, 6, 11, 16… — и привычные 30 или 60
// оказываются недопустимыми. Само по себе это полбеды, но поле, лежащее в
// свёрнутом разделе, браузер сфокусировать не может и молча отменяет
// отправку формы: обе кнопки диалога выглядят сломанными, и в консоли
// ничего нет. Уже наступали.
{
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8');
  for (const tag of html.match(/<input[^>]*type="number"[^>]*>/g) || []) {
    const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
    const step = Number(attr('step') ?? 1);
    const min = Number(attr('min') ?? 0);
    const id = attr('id') || tag.slice(0, 40);
    if (!Number.isFinite(step) || step <= 1) continue;
    check(`#${id}: шаг и нижняя граница согласованы`, Number.isFinite(min) && min % step === 0,
      `min=${min} не кратно step=${step} — круглые значения окажутся недопустимыми, `
      + 'и форма молча перестанет отправляться');
  }
}

// --- npm test: список тестов полный и без лишнего ---
//
// Скрипт тестов перечисляет файлы явно, потому что шаблон test/*.test.mjs
// на Node 20 не раскрывается (glob в аргументах --test появился в Node 21):
// прогон молча тестирует ноль файлов и выходит с кодом успеха. Цена явного
// списка — забыть вписать новый файл, поэтому полноту проверяем здесь.
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const listed = new Set((pkg.scripts.test || '').split(/\s+/).filter((w) => w.endsWith('.test.mjs')));
  const onDisk = walk(path.join(ROOT, 'test'), '.test.mjs').map(rel);
  for (const f of onDisk) {
    check(`npm test: ${f} перечислен`, listed.has(f), 'файл есть на диске, но в npm test не входит — запускаться не будет');
  }
  for (const f of listed) {
    check(`npm test: ${f} существует`, onDisk.includes(f), 'перечислен в npm test, но файла нет — прогон упадёт');
  }
}

// --- итог ---
if (problems.length) {
  process.stderr.write(`\nНайдены нарушения (${problems.length}):\n`);
  for (const p of problems) process.stderr.write(`  ✗ ${p}\n`);
  process.stderr.write('\n');
  process.exit(1);
}
process.stdout.write(`Проверено ${checked.length} инвариантов — нарушений нет.\n`);
