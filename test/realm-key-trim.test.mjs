// Ключ сети из config.json обрезается так же, как в интерфейсе: пробел не меняет круг.
//   node --test test/realm-key-trim.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Realms } from '../src/net/realms.js';
import { realmOf } from '../src/net/protocol.js';

const KEY = 'общий-ключ-1234';
const realmsWith = (networks) => new Realms({ get: (k) => (k === 'networks' ? networks : undefined) });

test('пробелы и перевод строки вокруг ключа не меняют отпечаток круга', () => {
  const dirty = realmsWith([{ id: 'a', label: 'Цех', key: `  ${KEY}\r\n` }]).keyed()[0];

  assert.equal(dirty.key, KEY);
  assert.equal(dirty.realm, realmOf(KEY));
  assert.equal(dirty.realm, realmsWith([{ id: 'a', key: KEY }]).keyed()[0].realm);
});

test('ключ из одних пробелов сетью не считается', () => {
  assert.deepEqual(realmsWith([{ id: 'a', key: ' \n ' }]).keyed(), []);
});
