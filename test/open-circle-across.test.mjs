// Открытый круг («без ключа») работает и между подсетями: ключ нужен для
// приватности, а не для самой возможности обмена узлами.
//   node --test test/open-circle-across.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryService } from '../src/cluster/directory.js';
import { Realms } from '../src/net/realms.js';

const realms = (cfg = {}) => new Realms({ get: (k) => cfg[k] });
const directory = (r) => new DirectoryService({
  seeds: () => ['10.9.9.9'], realms: r, peers: { bridged: () => [] }, selfEntry: () => ({ nodeId: 'me' }),
  defaultPort: () => 47812, intervalMs: () => 20000,
});

test('без ключей, но с галочками по умолчанию, обмен между сетями включён', () => {
  assert.equal(directory(realms()).blocked, false);
});

test('галочки сняты и ключа нет — узел изолирован, обмен выключен', () => {
  assert.equal(directory(realms({ seeOpen: false, showToOpen: false })).blocked, true);
});

test('приватность: ключ задан и галочки сняты — обслуживается только ключевой круг', () => {
  const r = realms({ seeOpen: false, showToOpen: false, networks: [{ id: 'a', key: 'секретный-ключ-1', label: 'Цех' }] });
  assert.equal(directory(r).blocked, false);
  assert.deepEqual(r.serving().map((c) => c.id), ['a']);
});

test('открытый круг идёт после ключевых, чтобы не перехватывать их вызовы', () => {
  const r = realms({ networks: [{ id: 'a', key: 'секретный-ключ-1', label: 'Цех' }] });
  assert.deepEqual(r.serving().map((c) => c.id), ['a', 'open']);
});
