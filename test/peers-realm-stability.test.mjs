// Узел в двух кругах (с ключом и открытый) — одна запись с устойчивым кругом.
//   node --test test/peers-realm-stability.test.mjs
//
// Баг: realm записи перезаписывался каждым анонсом, а узел шлёт по анонсу на круг,
// и запись прыгала между кругами: подпись то ключом, то без, пересказ каталога то
// есть, то нет, туннель через шлюз — 404 из-за несовпавшего круга.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerRegistry } from '../src/cluster/peers.js';

const KEYED = 'k-1234abcd';

function registry() {
  const reg = new PeerRegistry({
    nodeId: 'me', realms: { keyFor: () => '' }, peerTimeoutMs: 12000, peerForgetMs: 60000,
    announceIntervalMs: 3000, gossipIntervalMs: 20000, remotePollIntervalMs: 20000,
  });
  reg.refreshPeerState = () => {};
  return reg;
}
const announce = (reg, realm, address = '10.0.3.5') => reg.onAnnounce({
  nodeId: 'p1', name: 'P1', address, realm, apiPort: 47812, usbipPort: 3240, stateHash: 'h', next: 3000,
});

test('круг с ключом не затирается анонсом открытого круга', () => {
  const reg = registry();
  announce(reg, KEYED);
  announce(reg, 'open');
  announce(reg, KEYED);
  announce(reg, 'open');
  assert.equal(reg.get('p1').realm, KEYED);
  assert.equal(reg.directoryEntries(KEYED).length, 1, 'пересказ каталога своего круга не пропадает');
  assert.equal(reg.directoryEntries('open').length, 0, 'а открытому кругу ключевой узел не пересказывается');
});

test('открытый анонс первым: круг уходит на ключевой, как только тот услышан', () => {
  const reg = registry();
  announce(reg, 'open');
  assert.equal(reg.get('p1').realm, 'open');
  announce(reg, KEYED);
  announce(reg, 'open');
  assert.equal(reg.get('p1').realm, KEYED);
});

test('ключевой круг замолчал — запись переходит на открытый', () => {
  const reg = registry();
  announce(reg, KEYED);
  reg.get('p1').realmSeen[KEYED] = Date.now() - 60000;
  announce(reg, 'open');
  assert.equal(reg.get('p1').realm, 'open');
});

test('прощание из одного круга не удаляет узел, слышный в другом', () => {
  const reg = registry();
  announce(reg, KEYED);
  announce(reg, 'open');

  reg.onBye({ nodeId: 'p1', realm: KEYED });
  assert.ok(reg.get('p1'), 'в открытом круге узел жив');
  assert.equal(reg.get('p1').realm, 'open');

  reg.onBye({ nodeId: 'p1', realm: 'open' });
  assert.equal(reg.get('p1'), undefined, 'попрощался во всех кругах — удалён');
});

test('прощание из открытого круга не сбрасывает ключевой', () => {
  const reg = registry();
  announce(reg, 'open');
  announce(reg, KEYED);
  reg.onBye({ nodeId: 'p1', realm: 'open' });
  assert.equal(reg.get('p1').realm, KEYED);
});

test('прощание единственного круга удаляет узел и сообщает об этом', () => {
  const reg = registry();
  const gone = [];
  reg.on('peer-gone', (p) => gone.push(p.nodeId));
  announce(reg, KEYED);
  reg.onBye({ nodeId: 'p1', realm: KEYED });
  assert.equal(reg.get('p1'), undefined);
  assert.deepEqual(gone, ['p1']);
});

test('ключ сети убрали — узел остаётся по открытому кругу, а не пропадает', () => {
  const reg = registry();
  announce(reg, KEYED);
  announce(reg, 'open');
  assert.equal(reg.retainRealms(['open']), 0);
  assert.equal(reg.get('p1').realm, 'open');

  const only = registry();
  announce(only, KEYED);
  assert.equal(only.retainRealms(['open']), 1, 'слышен был только в забытом круге — забыт');
});
