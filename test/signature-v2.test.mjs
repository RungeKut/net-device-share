// Подпись HTTP-вызова v2: метод, путь, отправитель и время входят в подпись.
//   node --test test/signature-v2.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Realms } from '../src/net/realms.js';
import { sign, signRequest } from '../src/net/protocol.js';

const KEY = 'общий-ключ-1234';
const realms = (extra = {}) => new Realms({ get: (k) => ({ preSharedKey: KEY, ...extra }[k]) });

const call = (over = {}) => {
  const base = { payload: '{"a":1}', method: 'POST', path: '/api/v1/peer/release', nodeId: 'N1', ts: String(Date.now()) };
  const r = { ...base, ...over };
  return { ...r, signature: sign(r.payload, KEY), signature2: signRequest({ ...r, body: r.payload }, KEY) };
};

test('честный вызов v2 принимается', () => {
  assert.ok(realms().matchRequest(call()));
});

test('подмена отправителя, пути или метода ломает подпись', () => {
  const c = call();
  for (const tampered of [{ nodeId: 'EVIL' }, { path: '/api/v1/peer/claim' }, { method: 'GET' }]) {
    assert.equal(realms().matchRequest({ ...c, ...tampered }), null, JSON.stringify(tampered));
  }
});

test('устаревший вызов (повтор через час) отвергается', () => {
  assert.equal(realms().matchRequest(call({ ts: String(Date.now() - 3600_000) })), null);
});

test('узел прежней версии (только подпись тела) принимается, пока не включён строгий режим', () => {
  const c = call();
  const legacy = { ...c, signature2: '', ts: undefined };
  assert.ok(realms().matchRequest(legacy));
  assert.equal(realms({ strictSignatures: true }).matchRequest(legacy), null);
});

test('с неверным ключом не принимается ни та, ни другая подпись', () => {
  const wrong = Object.assign(call(), { signature: sign('{"a":1}', 'чужой-ключ-1234'), signature2: signRequest({ ts: Date.now(), method: 'POST', path: '/x', nodeId: 'N1', body: '{"a":1}' }, 'чужой-ключ-1234') });
  assert.equal(realms().matchRequest(wrong), null);
});
