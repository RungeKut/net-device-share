// Скрипты чистки и закрепления ARP не должны содержать того, что роняет PowerShell целиком.
//   node --test test/neighbor-scripts.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { neighborFlushScript, neighborPinScript, LIVE_NEIGHBORS } from '../src/net/ipConfig.js';

/** Имена из перечисления NetNeighbor.State в Windows. */
const VALID_STATES = new Set(['Unreachable', 'Incomplete', 'Probe', 'Delay', 'Stale', 'Reachable', 'Permanent']);

const statesIn = (script) => [...script.matchAll(/-State\s+([A-Za-z,]+)/g)].flatMap((m) => m[1].split(','));
const compared = (script) => [...script.matchAll(/\$_\.State\s+-(?:ne|eq)\s+'(\w+)'/g)].map((m) => m[1]);

test('чистка: без параметра -State (он строгий и считает «нет записей» ошибкой), только IPv4, не трогает Permanent', () => {
  const s = neighborFlushScript(44);
  assert.ok(!/-State\b/.test(s), 'параметр -State не используется');
  assert.match(s, /-AddressFamily IPv4/);
  assert.match(s, /-InterfaceIndex 44/);
  assert.equal(LIVE_NEIGHBORS, "Where-Object { $_.State -ne 'Permanent' }");
  assert.ok(s.trim().endsWith("'ok' | ConvertTo-Json -Compress"), 'последняя команда успешна — код выхода 0, пока нет настоящей ошибки');
});

test('закрепление: Permanent, активное хранилище, адрес и MAC на каждую пару', () => {
  const s = neighborPinScript(44, [{ ip: '10.0.6.134', mac: '00-e0-33-01-a4-d9' }, { ip: '10.0.6.1', mac: '00-11-22-33-44-55' }]);
  assert.deepEqual(statesIn(s), ['Permanent', 'Permanent']);
  for (const st of [...statesIn(s), ...compared(s)]) assert.ok(VALID_STATES.has(st), `${st} есть в перечислении Windows`);
  assert.match(s, /-PolicyStore ActiveStore/);
  assert.ok(!/Deep/.test(s));
  assert.match(s, /New-NetNeighbor -InterfaceIndex 44 -IPAddress '10\.0\.6\.134' -LinkLayerAddress '00-e0-33-01-a4-d9'/);
});
