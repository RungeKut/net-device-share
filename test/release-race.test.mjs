// Гонки при освобождении: третий узел не должен успеть занять устройство,
// пока старый держатель отдаёт его драйверу.
//   node --test test/release-race.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { ShareManager } from '../src/core/shareManager.js';
import { BIND_STATE, CLAIM_MODE } from '../src/net/protocol.js';

function setup() {
  let finishUnbind;
  const unbindDone = new Promise((r) => { finishUnbind = r; });
  const calls = [];
  const config = {
    get: (k) => ({ claimLeaseMs: 30000, nodeId: 'owner' }[k]),
    data: {},
    purposeOf: () => null,
    isShared: () => true,
  };
  const hub = {
    invalidateSlow() {},
    async unbind() { calls.push('unbind:start'); await unbindDone; calls.push('unbind:end'); },
    async bind() { calls.push('bind'); return {}; },
  };
  const share = new ShareManager({ hub, config });
  const dev = { deviceId: 'usb:1-1', type: 'usb', key: '1-1', title: 'Zynq', shared: true, hasTransport: true, bindState: BIND_STATE.BOUND };
  share.devices.set(dev.deviceId, dev);
  share.claims.set(dev.deviceId, {
    holderId: 'A', holderName: 'A', since: Date.now(), renewedAt: Date.now(),
    expiresAt: Date.now() + 60000, mode: CLAIM_MODE.REMOTE, groupId: null,
  });
  return { share, dev, calls, finishUnbind };
}

test('release: пока идёт unbind, чужое занятие отклоняется, а bind не обгоняет unbind', async () => {
  const { share, calls, finishUnbind } = setup();
  const releasing = share.release('usb:1-1', 'A');
  await new Promise((r) => setTimeout(r, 20));

  await assert.rejects(
    share.claim('usb:1-1', { holderId: 'C', holderName: 'C' }),
    (e) => e.code === 'busy',
  );
  assert.ok(!calls.includes('bind'), 'bind не вызывался до конца unbind');

  finishUnbind();
  await releasing;
  assert.equal(share.preparing.size, 0, 'отметка «готовится» снята');
  await share.claim('usb:1-1', { holderId: 'C', holderName: 'C' });
  assert.equal(share.claims.get('usb:1-1').holderId, 'C');
});

test('согласие на запрос: бронь стоит уже во время unbind', async () => {
  const { share, finishUnbind } = setup();
  const { id } = share.createRequest({ target: 'usb:1-1', requesterId: 'B', requesterName: 'B', message: '' });
  const answering = share.answerRequest(id, 'A', true);
  await new Promise((r) => setTimeout(r, 20));

  const res = share.reservations.get('usb:1-1');
  assert.equal(res?.nodeId, 'B', 'бронь за просителем поставлена до конца release');

  finishUnbind();
  await answering;
  assert.equal(share.reservations.get('usb:1-1')?.nodeId, 'B');
});
