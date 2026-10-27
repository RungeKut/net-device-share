// Нечитаемый config.json не должен пропадать: BOM снимается, битый файл уходит в копию.
//   node --test test/config-recovery.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nds-cfg-'));
const copiesOf = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('config.json.bad-'));

test('файл с BOM читается, настройки и nodeId сохраняются', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  const networks = [{ id: 'n1', label: 'Цех', key: 'ключ-цеха-1234' }];
  fs.writeFileSync(file, '﻿' + JSON.stringify({ nodeId: 'node-from-file', name: 'Узел', networks }), 'utf8');

  const config = new Config(file);

  assert.equal(config.get('nodeId'), 'node-from-file');
  assert.equal(config.get('name'), 'Узел');
  assert.deepEqual(config.get('networks'), networks);
  assert.deepEqual(copiesOf(dir), []);
});

test('битый файл сохраняется копией, исходное содержимое не теряется', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  const broken = '{"nodeId":"old-node","networks":[{"id":"n1","key":"секрет-ключ-1234"}],"name":"Об';
  fs.writeFileSync(file, broken, 'utf8');

  const config = new Config(file);

  const copies = copiesOf(dir);
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), broken);
  assert.ok(config.get('nodeId'));
  assert.notEqual(config.get('nodeId'), 'old-node');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
});

test('корень файла не объект (массив) тоже считается битым и сохраняется', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '[1,2,3]', 'utf8');

  new Config(file);

  const copies = copiesOf(dir);
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), '[1,2,3]');
});

test('отсутствующий файл копий не плодит', () => {
  const dir = tmpDir();
  new Config(path.join(dir, 'config.json'));
  assert.deepEqual(copiesOf(dir), []);
});
