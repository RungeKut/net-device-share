// Разбор идентификаторов в атрибутах кнопок интерфейса.
//   node --test test/ui-ids.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachKey } from '../src/core/attachManager.js';

const src = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');

function grab(name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `в интерфейсе нет функции ${name}`);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('нет конца функции');
}

const splitLast = new Function(`${grab('splitLast')}; return splitLast;`)();

test('кнопка «Копировать драйвер»: идентификатор занятия содержит «|», устройство — последний кусок', () => {
  const attachmentId = attachKey('c4d96879-cf14-4be5-adfa-087024eb0ac6', 'usb:1-1');
  const value = `${attachmentId}|usb:1-1`;                    // как в data-driver
  assert.deepEqual(splitLast(value), [attachmentId, 'usb:1-1']);
  // старое поведение — делить по всем «|» — теряло занятие:
  assert.notEqual(value.split('|')[0], attachmentId);
});

test('то же для «Настроек IP» занятой карты', () => {
  const attachmentId = attachKey('node-1', 'net:Ethernet_2');
  assert.deepEqual(splitLast(`${attachmentId}|net:Ethernet_2`), [attachmentId, 'net:Ethernet_2']);
});

test('в интерфейсе нет других мест, где составной идентификатор занятия делится по всем «|»', () => {
  // data-attach/take/ask собираются из узла и цели — у них «|» ровно один, они в порядке;
  // а вот всё, что строится из id занятия, обязано идти через splitLast.
  const bad = src.split('\n').filter((l) => /dataset\.(driver|heldIp)\.split\('\|'\)/.test(l));
  assert.deepEqual(bad, []);
});
