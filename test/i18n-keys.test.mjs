// Ключевая схема i18n: словари src/ui/i18n/*.js паритетны ru.js (ключи,
// значения, токены), t() ищет по ключу и подставляет {token}, реестр
// languages() и ключи из исходников сходятся со словарём. Пока en.js/ru.js
// не созданы параллельным потоком, «Cannot find module … i18n/en.js» — ожидаемо.
//   node --test test/i18n-keys.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { t, languages } from '../src/ui/i18n.js';
import ru from '../src/ui/i18n/ru.js';
import en from '../src/ui/i18n/en.js';

const tokens = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('каждый словарь i18n паритетен ru.js: ключи, непустые строки, токены', async () => {
  const dictDir = new URL('../src/ui/i18n/', import.meta.url);
  const ruKeys = Object.keys(ru).sort();
  const files = readdirSync(dictDir).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.length > 1, 'src/ui/i18n/ пуст — словари ещё не созданы');
  for (const file of files) {
    const dict = (await import(new URL(file, dictDir).href)).default;
    const where = `src/ui/i18n/${file}`;
    assert.ok(dict && typeof dict === 'object', `${where}: export default не объект`);
    assert.deepEqual(Object.keys(dict).sort(), ruKeys, `${where}: набор ключей не совпадает с ru.js`);
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${where}: «${key}» — не строка`);
      assert.ok(value.trim(), `${where}: пустое значение у «${key}»`);
      assert.deepEqual(tokens(value), tokens(ru[key]), `${where}: токены «${key}» не совпадают с ru.js`);
    }
  }
});

test('в en.js нет кириллицы', () => {
  assert.ok(Object.keys(en).length, 'en.js пуст');
  for (const [key, value] of Object.entries(en)) {
    assert.ok(!/[А-ЯЁа-яё]/.test(value), `en.js: «${key}» осталось по-русски: ${value}`);
  }
});

test('t(): ключ из словаря, неизвестный ключ, подстановка {token}', () => {
  const [key, enValue] = Object.entries(en)[0] ?? [];
  assert.ok(key, 'en.js пуст — нечего проверять');
  assert.equal(t(key), enValue);
  assert.equal(t('такого ключа нет нигде 404'), 'такого ключа нет нигде 404');
  assert.equal(t('тест {n} токен', { n: '5' }), 'тест 5 токен');
  assert.equal(t('тест {n} токен'), 'тест {n} токен');
  assert.equal(t('тест {a} и {b}', { a: '1' }), 'тест 1 и {b}');
});

test('languages(): 30 записей, имена непусты, rtl только у арабского', () => {
  const list = languages();
  assert.equal(list.length, 30);
  assert.ok(list.every((l) => l.dir === 'rtl' || l.dir === 'ltr'));
  assert.deepEqual(list.filter((l) => l.dir === 'rtl').map((l) => l.code), ['ar']);
  for (const l of list) assert.ok(l.name, `пустое имя у ${l.code}`);
});

test('ключи из исходников (t(…) и data-i18n*) существуют в ru.js', () => {
  const ruKeys = new Set(Object.keys(ru));
  const used = new Set();
  for (const file of ['app.js', 'net.js', 'index.html']) {
    const src = readFileSync(fileURLToPath(new URL(`../src/ui/${file}`, import.meta.url)), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*(['"])(.*?)\1/g)) if (!m[2].endsWith('.')) used.add(m[2]);
    for (const m of src.matchAll(/\bdata-i18n(?:-[\w-]+)?="([^"]*)"/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => k && !ruKeys.has(k));
  assert.deepEqual(missing, [], `нет в ru.js: ${missing.join(' | ')}`);
});
