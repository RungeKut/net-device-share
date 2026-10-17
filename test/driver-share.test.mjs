// Выбор пакетов драйвера и разбор INF.
//   node --test test/driver-share.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCandidates, versionDate, parseInf } from '../src/core/driverShare.js';

const c = (inf, version, how) => ({ inf, version, how });
const SCAN = 'найден в хранилище по коду устройства';
const BOUND = 'привязан к устройству';

test('привязанный к устройству пакет важнее найденных по коду', () => {
  const r = chooseCandidates([
    c('oem1.inf', '1.0 (01/01/2020)', SCAN),
    c('oem2.inf', '2.0 (01/01/2025)', BOUND),
    c('oem3.inf', '3.0 (01/01/2026)', SCAN),
  ]);
  assert.deepEqual(r.map((x) => x.inf), ['oem2.inf']);
});

test('из найденных по коду берётся самый свежий по дате', () => {
  const r = chooseCandidates([
    c('oem10.inf', '3.9.2024.09 (09/16/2024)', SCAN),
    c('oem12.inf', '2.1.2025.07 (07/19/2025)', SCAN),
  ]);
  assert.deepEqual(r.map((x) => x.inf), ['oem12.inf']);
});

test('один пакет и пустой список — как есть', () => {
  assert.equal(chooseCandidates([]).length, 0);
  assert.equal(chooseCandidates([c('a.inf', null, SCAN)]).length, 1);
});

test('дата версии: американский порядок, мусор — ноль', () => {
  assert.equal(versionDate('1.0 (07/19/2025)'), Date.UTC(2025, 6, 19));
  assert.equal(versionDate('без даты'), 0);
  assert.equal(versionDate(null), 0);
});

test('INF: поставщик из [Strings], версия и класс', () => {
  const t = '[Version]\r\nClass=MEDIA\r\nProvider=%Mfg%\r\nDriverVer=05/01/2024,4.5.6.7\r\n[Strings]\r\nMfg="Focusrite Audio Engineering"\r\n';
  assert.deepEqual(parseInf(t), { provider: 'Focusrite Audio Engineering', class: 'MEDIA', version: '4.5.6.7 (05/01/2024)' });
});
