// Клиент пропал: что происходит с USB-устройством у владельца.
//   node --test test/offline-holder.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { TrafficProxy } from '../src/net/trafficProxy.js';
import { ShareManager } from '../src/core/shareManager.js';
import { BIND_STATE, CLAIM_MODE } from '../src/net/protocol.js';

/** Запрос OP_REQ_IMPORT: по нему счётчик узнаёт устройство. */
function importPacket(busid) {
  const b = Buffer.alloc(40);
  b.writeUInt16BE(0x0111, 0);
  b.writeUInt16BE(0x8003, 2);
  b.write(busid, 8, 'ascii');
  return b;
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

async function proxyWithFakeUsbipd() {
  const upstreamSockets = [];
  const usbipd = net.createServer((s) => {
    upstreamSockets.push(s);
    s.on('data', () => {});
    s.on('error', () => {});
  });
  const usbipdPort = await listen(usbipd);
  const probe = net.createServer();
  const proxyPort = await listen(probe);
  await new Promise((r) => probe.close(r));
  const proxy = new TrafficProxy({ listenPort: proxyPort, targetPort: usbipdPort });
  await proxy.start();
  return { proxy, proxyPort, usbipd, upstreamSockets };
}

test('счётчик: оборвать соединения устройства — usbipd видит чистое отключение', async () => {
  const { proxy, proxyPort, usbipd, upstreamSockets } = await proxyWithFakeUsbipd();
  const events = [];
  proxy.on('device-closed', (e) => events.push(e));

  const client = net.connect(proxyPort, '127.0.0.1');
  client.on('error', () => {});
  await new Promise((r) => client.once('connect', r));
  client.write(importPacket('1-1'));
  assert.ok(await until(() => proxy.pairs.get('usb:1-1')?.size === 1), 'соединение опознано как usb:1-1');

  let clientClosed = false;
  client.on('close', () => { clientClosed = true; });
  let upstreamClosed = false;
  upstreamSockets[0].on('close', () => { upstreamClosed = true; });

  assert.equal(proxy.dropDevice('usb:1-1'), 1);
  assert.ok(await until(() => clientClosed && upstreamClosed), 'закрылись обе стороны');
  assert.ok(await until(() => events.length === 1));
  assert.deepEqual({ deviceId: events[0].deviceId, dropped: events[0].dropped }, { deviceId: 'usb:1-1', dropped: true });
  assert.equal(proxy.pairs.has('usb:1-1'), false);
  assert.equal(proxy.dropDevice('usb:1-1'), 0, 'повторно рвать нечего');

  await proxy.stop();
  usbipd.close();
});

test('счётчик: клиент сам закрыл соединение — событие без пометки «оборвано нами»', async () => {
  const { proxy, proxyPort, usbipd } = await proxyWithFakeUsbipd();
  const events = [];
  proxy.on('device-closed', (e) => events.push(e));

  const client = net.connect(proxyPort, '127.0.0.1');
  client.on('error', () => {});
  await new Promise((r) => client.once('connect', r));
  client.write(importPacket('2-3'));
  assert.ok(await until(() => proxy.pairs.get('usb:2-3')?.size === 1));
  client.destroy();
  assert.ok(await until(() => events.length === 1));
  assert.equal(events[0].dropped, false);

  await proxy.stop();
  usbipd.close();
});

// ---------------------------------------------------------------- владелец

function shareWith({ unbind, dropData, lease = 30000, dataConnections, mode = CLAIM_MODE.REMOTE }) {
  const config = { get: (k) => ({ claimLeaseMs: lease, nodeId: 'owner' }[k]), data: {}, purposeOf: () => null };
  const hub = { unbind, invalidateSlow() {} };
  const share = new ShareManager({ hub, config, dropData, dataConnections });
  const dev = { deviceId: 'usb:1-1', type: 'usb', key: '1-1', title: 'Zynq', hasTransport: true, bindState: BIND_STATE.BOUND };
  share.devices.set(dev.deviceId, dev);
  share.claims.set(dev.deviceId, {
    holderId: 'client', holderName: 'CLIENT', since: Date.now() - 60000, renewedAt: Date.now() - 45000,
    expiresAt: Date.now() + 60000, mode, groupId: null,
  });
  return { share, dev };
}

test('аренда клиента, который пропал, истекает: соединения рвутся ДО возврата устройства системе', async () => {
  const order = [];
  const { share, dev } = shareWith({
    dropData: (id) => { order.push(`drop ${id}`); return 1; },
    unbind: async () => { order.push('unbind'); return { ok: true }; },
  });
  const r = await share.release('usb:1-1', 'client', { force: true });
  assert.equal(r.released, 1);
  assert.deepEqual(order, ['drop usb:1-1', 'unbind']);
  assert.equal(dev.bindState, BIND_STATE.UNBOUND);
  assert.equal(share.claims.size, 0);
});

test('возврат устройства: первая попытка не удалась — вторая через 2 с', { timeout: 10000 }, async () => {
  let calls = 0;
  const { share, dev } = shareWith({
    dropData: () => 0,
    unbind: async () => { calls++; if (calls === 1) throw new Error('device is busy'); return { ok: true }; },
  });
  await share.release('usb:1-1', 'client', { force: true });
  assert.equal(calls, 2);
  assert.equal(dev.bindState, BIND_STATE.UNBOUND);
  assert.equal(dev.lastError, null);
});

test('возврат устройства: обе попытки неудачны — устройство свободно в каталоге, но с ошибкой', { timeout: 10000 }, async () => {
  const { share, dev } = shareWith({
    dropData: () => 0,
    unbind: async () => { throw new Error('usbipd не отвечает'); },
  });
  await share.release('usb:1-1', 'client', { force: true });
  assert.equal(share.claims.size, 0, 'каталог не блокирует устройство навсегда');
  assert.equal(dev.bindState, BIND_STATE.ERROR);
  assert.match(dev.lastError, /usbipd не отвечает/);
});

test('владелец видит, что держатель замолчал', () => {
  const { share } = shareWith({ dropData: () => 0, unbind: async () => ({ ok: true }) });
  const claim = share.claims.get('usb:1-1');
  claim.expiresAt = Date.now() + 8000;           // аренда ещё жива, но продлевали давно
  const dto = share.toDto(share.devices.get('usb:1-1'));
  assert.ok(dto.claim.holderSilentMs >= 44000);
  assert.equal(dto.claim.leaseMs, 30000);

  claim.renewedAt = Date.now();                   // продлили — тишины нет
  assert.ok(share.toDto(share.devices.get('usb:1-1')).claim.holderSilentMs < 1000);
});

// ------------------------- соединение закрылось, а аренда осталась (как у сетевой карты)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('соединение удалённого держателя закрылось и не вернулось — аренда освобождается', async () => {
  const order = [];
  const { share } = shareWith({
    lease: 150,
    dataConnections: () => 0,
    dropData: () => { order.push('drop'); return 0; },
    unbind: async () => { order.push('unbind'); return { ok: true }; },
  });
  share.onDataClosed('usb:1-1');
  assert.equal(share.claims.size, 1, 'сразу не освобождаем: даём время на переподключение');
  await sleep(400);
  assert.equal(share.claims.size, 0);
  assert.deepEqual(order, ['drop', 'unbind']);
  share.stop();
});

test('соединение вернулось в срок — аренда остаётся', async () => {
  const { share } = shareWith({ lease: 150, dataConnections: () => 0, dropData: () => 0, unbind: async () => ({ ok: true }) });
  share.onDataClosed('usb:1-1');
  await sleep(50);
  share.onDataOpened('usb:1-1');
  await sleep(300);
  assert.equal(share.claims.size, 1);
  share.stop();
});

test('к моменту срока соединение уже есть (переподключился) — аренда остаётся', async () => {
  let live = 0;
  const { share } = shareWith({ lease: 150, dataConnections: () => live, dropData: () => 0, unbind: async () => ({ ok: true }) });
  share.onDataClosed('usb:1-1');
  live = 1;
  await sleep(300);
  assert.equal(share.claims.size, 1);
  share.stop();
});

test('своё устройство владельца этим не освобождается', async () => {
  const { share } = shareWith({ lease: 100, mode: CLAIM_MODE.LOCAL, dataConnections: () => 0, dropData: () => 0, unbind: async () => ({ ok: true }) });
  share.onDataClosed('usb:1-1');
  await sleep(250);
  assert.equal(share.claims.size, 1);
  share.stop();
});

test('осознанное освобождение держателем снимает отсчёт', async () => {
  let unbinds = 0;
  const { share } = shareWith({ lease: 150, dataConnections: () => 0, dropData: () => 0, unbind: async () => { unbinds++; return { ok: true }; } });
  share.onDataClosed('usb:1-1');
  await share.release('usb:1-1', 'client');
  await sleep(300);
  assert.equal(unbinds, 1, 'не освобождали второй раз');
  assert.equal(share.dataTimers.size, 0);
  share.stop();
});
