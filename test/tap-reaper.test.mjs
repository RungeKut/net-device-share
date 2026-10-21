// Свободные TAP-адаптеры проброса удаляются после простоя, занятые и чужие — нет.
//   node --test test/tap-reaper.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { NetShare } from '../src/core/netShare.js';

function setup(records, { idleMs = 1000 } = {}) {
  const data = { tapAdapters: records, tapIdleMs: idleMs };
  const config = { get: (k) => data[k], set: (patch) => Object.assign(data, patch) };
  const net = new NetShare({ config, workingIface: () => null });
  net.elevated = true;
  const removed = [];
  net._removeTap = async (guid) => { removed.push(guid); };
  return { net, data, removed };
}

test('свободные адаптеры проброса удаляются после простоя, адаптеры коммутатора и занятые — нет', async () => {
  const { net, data, removed } = setup([
    { guid: 'S1', role: 'server' }, { guid: 'C1', role: 'client' }, { guid: 'V1', role: 'vnic' },
    { guid: 'U1', role: 'uplink' }, { guid: 'B1', role: 'client' },
  ]);
  net.busyTaps.add('B1');
  const t0 = Date.now();
  for (const g of ['S1', 'C1', 'V1', 'U1', 'B1']) net.idleSince.set(g, t0 - 5000);

  await net._reapTaps();
  assert.deepEqual(removed.sort(), ['C1', 'S1']);
  assert.deepEqual(data.tapAdapters.map((r) => r.guid).sort(), ['B1', 'U1', 'V1']);
  assert.ok(net.busyTaps.has('B1') && !net.busyTaps.has('S1'), 'отметка «занят» на время удаления снята');
});

test('адаптер, освободившийся только что, не удаляется; нулевой срок — не удалять никогда', async () => {
  const fresh = setup([{ guid: 'S1', role: 'server' }]);
  fresh.net._releaseTap('S1');
  await fresh.net._reapTaps();
  assert.deepEqual(fresh.removed, []);

  const never = setup([{ guid: 'S1', role: 'server' }], { idleMs: 0 });
  never.net.idleSince.set('S1', Date.now() - 1e9);
  await never.net._reapTaps();
  assert.deepEqual(never.removed, []);
});

test('сбой удаления не теряет запись и повторяется не раньше срока простоя', async () => {
  const { net, data } = setup([{ guid: 'S1', role: 'server' }]);
  net._removeTap = async () => { throw new Error('драйвер занят'); };
  net.idleSince.set('S1', Date.now() - 5000);
  await net._reapTaps();
  assert.equal(data.tapAdapters.length, 1);
  assert.ok(Date.now() - net.idleSince.get('S1') < 1000, 'срок отсчитывается заново');
});
