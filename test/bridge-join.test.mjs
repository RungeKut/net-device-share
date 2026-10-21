// Подключение сетевой карты в общий мост: подключаться могут несколько узлов,
// карта при этом не «занята» и не отдаётся целиком.
//   node --test test/bridge-join.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { ShareManager } from '../src/core/shareManager.js';
import { BIND_STATE } from '../src/net/protocol.js';

function setup({ lease = 30000 } = {}) {
  const calls = [];
  const config = {
    get: (k) => ({ claimLeaseMs: lease, nodeId: 'owner' }[k]),
    data: {}, purposeOf: () => null, isShared: () => true,
  };
  const hub = {
    invalidateSlow() {},
    async bind(dev, holder) { calls.push(['bind', holder.holderId, holder.mode]); return { link: { port: 47814, token: `t-${holder.holderId}`, mode: 'bridge' } }; },
    async unbind(dev, holder) { calls.push(['unbind', holder?.holderId, holder?.mode]); },
  };
  const share = new ShareManager({ hub, config });
  const dev = {
    deviceId: 'net:Ethernet', type: 'net', key: 'Ethernet', title: 'Ethernet', shared: true, hasTransport: true,
    bindState: BIND_STATE.UNBOUND, meta: { bridgeJoin: true },
  };
  share.devices.set(dev.deviceId, dev);
  return { share, dev, calls };
}
const who = (id) => ({ holderId: id, holderName: id.toUpperCase(), holderAddress: '10.0.0.5' });

test('несколько узлов подключаются в мост одновременно, карта не «занята»', async () => {
  const { share, dev, calls } = setup();
  const a = await share.join('net:Ethernet', who('a'));
  await share.join('net:Ethernet', who('b'));
  assert.equal(a.mode, 'bridge');
  assert.equal(a.links[0].token, 't-a');
  assert.deepEqual(calls, [['bind', 'a', 'bridge'], ['bind', 'b', 'bridge']]);
  assert.equal(share.claims.size, 0, 'занятия нет');
  const dto = share.toDto(dev);
  assert.deepEqual(dto.joins.map((j) => j.holderId).sort(), ['a', 'b']);
  assert.equal(dto.claim, null, 'для остальных карта по-прежнему свободна');
});

test('пока в мосту кто-то есть, целиком карту не занять; владелец может забрать', async () => {
  const { share } = setup();
  await share.join('net:Ethernet', who('a'));
  await assert.rejects(share.claim('net:Ethernet', { holderId: 'c', holderName: 'C' }), (e) => e.code === 'busy' && /в мост/.test(e.message));
  await share.claim('net:Ethernet', { holderId: 'owner', holderName: 'OWNER', force: true });
  assert.equal(share.joins.size, 0, 'подключения сняты');
  assert.equal(share.claims.get('net:Ethernet').holderId, 'owner');
});

test('выход из моста: мост разбирается, только когда вышел последний', async () => {
  const { share, dev, calls } = setup();
  await share.join('net:Ethernet', who('a'));
  await share.join('net:Ethernet', who('b'));
  await share.release('net:Ethernet', 'a');
  assert.equal(dev.bindState, BIND_STATE.BOUND, 'второй ещё в мосту');
  assert.deepEqual(calls.at(-1), ['unbind', 'a', 'bridge']);
  await share.release('net:Ethernet', 'b');
  assert.equal(dev.bindState, BIND_STATE.UNBOUND);
  assert.equal(share.joins.size, 0);
});

test('владелец снимает всех принудительно; аренда продлевается, истёкшая — снимается', async () => {
  const { share, dev } = setup({ lease: 1000 });
  await share.join('net:Ethernet', who('a'));
  await share.join('net:Ethernet', who('b'));
  assert.ok(share.renew('net:Ethernet', 'a').ok);
  share.joins.get(dev.deviceId).get('b').expiresAt = Date.now() - 1;
  share._sweep();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([...share.joins.get(dev.deviceId).keys()], ['a']);
  await share.release('net:Ethernet', 'owner', { force: true });
  assert.equal(share.joins.size, 0);
});

test('нельзя: подключить свою карту, подключить занятую целиком, подключить не-карту', async () => {
  const { share, dev } = setup();
  await assert.rejects(share.join('net:Ethernet', who('owner')), (e) => e.code === 'not_joinable');
  await share.claim('net:Ethernet', { holderId: 'x', holderName: 'X' });
  await assert.rejects(share.join('net:Ethernet', who('a')), (e) => e.code === 'busy');
  share.devices.set('usb:1-1', { ...dev, deviceId: 'usb:1-1', type: 'usb', key: '1-1', title: '1-1' });
  await assert.rejects(share.join('usb:1-1', who('a')), (e) => e.code === 'not_joinable');
});
