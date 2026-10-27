// Причина 401 на межузловом вызове видна в тексте ответа: часы, нет подписи, неверный ключ.
//   node --test test/signature-diagnose.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ApiServer } from '../src/api/httpServer.js';
import { Realms } from '../src/net/realms.js';
import { sign, signRequest, diagnoseRequest, REQUEST_SKEW_MS } from '../src/net/protocol.js';
import { AUTH_HEADER, AUTH2_HEADER, TS_HEADER, NODE_HEADER } from '../src/net/rpc.js';

const KEY = 'общий-ключ-1234';
const PATH = '/api/v1/peer/ping';

const config = { get: (k) => ({ preSharedKey: KEY, seeOpen: false, showToOpen: false }[k]) };
const server = () => new ApiServer({
  config,
  realms: new Realms(config),
  isInWorkingNetwork: () => true,
});

// Вызывает настоящий _handlePeer с подделанными req/res и возвращает ответ.
async function peerCall({ key = KEY, ts = Date.now(), signed = true, srv = server() } = {}) {
  const headers = { [NODE_HEADER]: 'N1' };
  if (signed) {
    headers[AUTH_HEADER] = sign('', key);
    headers[AUTH2_HEADER] = signRequest({ ts, method: 'GET', path: PATH, nodeId: 'N1', body: '' }, key);
    headers[TS_HEADER] = String(ts);
  }
  const req = new EventEmitter();
  Object.assign(req, { headers, method: 'GET', url: PATH });
  let status; let payload;
  const res = {
    writeHead: (s) => { status = s; },
    end: (body) => { payload = JSON.parse(body); },
  };
  const done = srv._handlePeer(req, res, PATH, '10.0.0.7');
  queueMicrotask(() => req.emit('end'));
  await done;
  return { status, ...payload };
}

test('расхождение часов: 401, в тексте сдвиг в минутах', async () => {
  const r = await peerCall({ ts: Date.now() - 3600_000 });
  assert.equal(r.status, 401);
  assert.equal(r.error, 'bad_signature');
  assert.match(r.message, /часов/);
  assert.match(r.message, /60 мин/);
});

test('вызов без подписи: 401, в тексте — что подпись отсутствует', async () => {
  const r = await peerCall({ signed: false });
  assert.equal(r.status, 401);
  assert.equal(r.error, 'bad_signature');
  assert.match(r.message, /без подписи/);
});

test('неверный ключ при свежих часах: 401, в тексте — ключ или круг', async () => {
  const r = await peerCall({ key: 'чужой-ключ-1234' });
  assert.equal(r.status, 401);
  assert.equal(r.error, 'bad_signature');
  assert.match(r.message, /ключ/);
  assert.doesNotMatch(r.message, /часов/);
});

test('три причины различаются, а допуск часов совпадает с проверкой подписи', () => {
  const now = Date.now();
  const sig = 'x';
  assert.equal(diagnoseRequest({ ts: now, signature: '', signature2: '' }).reason, 'no_signature');
  assert.equal(diagnoseRequest({ ts: now, signature: sig, signature2: sig }).reason, 'bad_key');
  assert.equal(diagnoseRequest({ ts: now - REQUEST_SKEW_MS - 60_000, signature: sig, signature2: sig }).reason, 'clock_skew');
  assert.equal(diagnoseRequest({ ts: now + REQUEST_SKEW_MS + 60_000, signature: sig, signature2: sig }).reason, 'clock_skew');
});

test('предупреждение о часах не чаще раза в пять минут на адрес', () => {
  const srv = server();
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    for (let i = 0; i < 5; i++) srv._warnClockSkew('10.0.0.7', PATH, 'расхождение часов');
    srv._warnClockSkew('10.0.0.8', PATH, 'расхождение часов');
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(lines.filter((l) => l.includes('10.0.0.7')).length, 1);
  assert.equal(lines.filter((l) => l.includes('10.0.0.8')).length, 1);
});
