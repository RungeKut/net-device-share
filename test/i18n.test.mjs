// Словарь и переводчик интерфейса. DOM в тестах не поднимается: проверяется
// чистая функция translateText и целостность словаря.
//   node --test test/i18n.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateText, dictEntries, getLang, missingStrings } from '../src/ui/i18n.js';

test('по умолчанию английский, перевод кнопок и пилюль работает', () => {
  assert.equal(getLang(), 'en');
  assert.equal(translateText('Занять'), 'Take');
  assert.equal(translateText('только бронь'), 'booking only');
  assert.equal(translateText('свободно'), 'free');
  assert.equal(translateText('владелец офлайн'), 'owner offline');
});

test('динамическая строка собирается из кусков: пилюля с именем и временем', () => {
  assert.equal(translateText('занято: Иван · 3 мин назад'), 'taken: Иван · 3 min ago');
  // Отдельные слова переводятся, где словарь знает слово; целые фразы —
  // целиком (см. transportPill в словаре).
  assert.equal(translateText('кто занял устройство'), 'кто took устройство');
  assert.match(
    translateText('Проброса нет: приложение учитывает, кто занял устройство, но данные по сети не передаёт. Подключаться к нему нужно физически.'),
    /^No forwarding: the app records/,
  );
});

test('замены не заходят внутрь слов и не ломают падежи', () => {
  // «занято» не срабатывает внутри «занятое», «сеть» — внутри «сетевой»
  assert.equal(translateText('занятое место'), 'занятое место');
  assert.equal(translateText('сетевой экран'), 'сетевой экран');
});

test('единицы: скорость, объём, длительности', () => {
  assert.equal(translateText('3,2 МБ/мин'), '3,2 MB/min');
  assert.equal(translateText('256 КБ'), '256 KB');
  assert.equal(translateText('2 ч 14 мин'), '2 h 14 min');
  assert.equal(translateText('4 дн'), '4 d');
  // «5 с» — длительность; «с серверами» — предлог, не трогается
  assert.equal(translateText('5 с'), '5 sec');
  assert.equal(translateText('соединения с серверами'), 'соединения с серверами');
});

test('длинные фразы настроек переводятся целиком', () => {
  assert.equal(
    translateText('Устройства и группы, доступные в сети'),
    'Devices and groups available on the network',
  );
  assert.match(translateText('Запускать как службу при загрузке системы'), /^Run as a service/);
});

test('нет перевода — строка попадает в список пропущенных, но не меняется', () => {
  const before = missingStrings().length;
  const out = translateText('совершенно новая фраза интерфейса');
  assert.equal(out, 'совершенно новая фраза интерфейса');
  assert.ok(missingStrings().includes('совершенно новая фраза интерфейса'));
  assert.ok(missingStrings().length > before);
});

test('словарь корректен: значения непусты, без кириллицы, без повторов', () => {
  const seen = new Set();
  for (const [ru, en] of dictEntries()) {
    assert.ok(!seen.has(ru), `дубль ключа: ${ru}`);
    seen.add(ru);
    assert.ok(en && en.trim(), `пустой перевод у «${ru}»`);
    assert.ok(!/[А-ЯЁа-яё]/.test(en), `перевод «${ru}» остался по-русски: ${en}`);
    // Пробелы по краям намеренны: ключи-фрагменты стоят перед динамикой
    // («Настройки IP — …», «2 ч…»), поэтому не проверяются.
  }
});
