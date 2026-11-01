// Снимок состояния: узел отдаётся без внутренностей реестра, а звание шлюза
// пересчитывается по составу живых сетей, а не по их числу.
//   node --test test/app-snapshot.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/core/app.js';

const peer = {
  nodeId: 'p1', name: 'P1', address: '10.0.3.5', apiPort: 47812,
  platform: 'win32', version: '1', startedAt: 1, online: true, lastSeen: 2,
  devices: [{ deviceId: 'usb:1', claim: null }, { deviceId: 'usb:2', claim: { holderId: 'x' } }],
  stateError: null, origin: 'local', network: '10.0.3.0/24', viaName: null,
  nets: 2, realm: 'open',
  // внутренности, которые не должны выехать в снимок:
  seenAt: { '10.0.3.5': 2 }, realmSeen: { open: 2 }, dir: 'abc', announceEvery: 3000,
  timeoutMs: 12000, stateHash: 'h', routes: new Map(),
};

const app = {
  peers: { routesOf: () => [{ key: 'k', address: '10.0.3.5', kind: 'direct', mode: 'direct' }] },
  realms: { labelFor: () => 'без ключа' },
};

test('_peerView: пользовательские поля на месте, внутренности записи не едут', () => {
  const view = App.prototype._peerView.call(app, peer);
  assert.equal(view.nodeId, 'p1');
  assert.equal(view.busyCount, 1);
  assert.equal(view.nets, 2);
  assert.deepEqual(view.routes, [{ key: 'k', address: '10.0.3.5', kind: 'direct', mode: 'direct' }]);
  for (const inner of ['seenAt', 'realmSeen', 'dir', 'announceEvery', 'timeoutMs', 'stateHash']) {
    assert.equal(inner in view, false, `${inner} — внутренность, в снимке ей не место`);
  }
});

test('_syncGateway: пересчитывает звание при смене СОСТАВА живых сетей, не только их числа', () => {
  const mk = (live) => ({
    liveNetworks: () => live.map((cidr) => ({ cidr })),
    _liveSeen: undefined,
    discovery: { refreshes: 0, refresh() { this.refreshes++; } },
  });

  const a = mk([]);
  App.prototype._syncGateway.call(a);
  App.prototype._syncGateway.call(a);
  assert.equal(a.discovery.refreshes, 1, 'пусто осталось пустым — второй раз молчим');

  const b = mk(['10.0.0.0/21']);
  App.prototype._syncGateway.call(b);
  assert.equal(b.discovery.refreshes, 1, 'пусто → одна сеть — объявляемся');

  // сети поменялись местами: число то же (одна), состав другой
  const c = mk(['10.0.0.0/21']);
  App.prototype._syncGateway.call(c);
  c.liveNetworks = () => [{ cidr: '200.100.1.0/24' }];
  App.prototype._syncGateway.call(c);
  assert.equal(c.discovery.refreshes, 2, 'состав живых сетей сменился при том же числе — объявляемся');
});
