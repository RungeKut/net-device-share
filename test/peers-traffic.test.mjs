// Скорость обмена у соседей не должна «замерзать».
//   node --test test/peers-traffic.test.mjs
//
// Баг: точные байты в хеш состояния не входят, поэтому наша копия устройств соседа
// обновлялась только когда у него что-то менялось — и скорость показывала момент
// занятия (сотни байт в минуту) вместо настоящих мегабайт.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PeerRegistry } from '../src/cluster/peers.js';

/** Сосед: состояние с постоянным хешем, а скорость и занятость меняются. */
function fakeOwner(model) {
  return new Promise((resolve) => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/api/v1/peer/state') {
        requests++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          nodeId: 'owner', name: 'OWNER', stateHash: 'H-const',     // хеш не меняется никогда
          devices: [{
            deviceId: 'usb:1-1', type: 'usb', title: '1-1', description: 'Флешка',
            claim: model.busy ? { holderId: 'me', holderName: 'ME', since: Date.now() } : null,
            traffic: model.busy ? { bytesInPerMinute: model.rate, bytesOutPerMinute: 0, totalIn: model.rate, totalOut: 0 } : null,
          }],
          groups: [], requests: [],
        }));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, get requests() { return requests; } }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return false;
}

function registry() {
  return new PeerRegistry({
    nodeId: 'me',
    realms: { keyFor: () => '' },
    peerTimeoutMs: 60000,
    peerForgetMs: 120000,
    announceIntervalMs: 60000,
    gossipIntervalMs: 60000,
    remotePollIntervalMs: 60000,
    trafficRefreshMs: 80,
  });
}

const announce = (port) => ({
  nodeId: 'owner', name: 'OWNER', address: '127.0.0.1', apiPort: port, usbipPort: 3240, realm: 'open',
  version: '2.2.0', startedAt: Date.now(), deviceCount: 1, busyCount: 1, stateHash: 'H-const', next: 60000,
});

test('скорость занятого устройства соседа обновляется, хотя хеш его состояния не меняется', async () => {
  const model = { busy: true, rate: 320 };               // в момент занятия — рукопожатие, сотни байт
  const owner = await fakeOwner(model);
  const reg = registry().start();
  try {
    reg.onAnnounce(announce(owner.port));
    const peer = reg.peers.get('owner');
    assert.ok(await until(() => peer.devices?.[0]?.traffic?.bytesInPerMinute === 320), 'первая копия получена');

    model.rate = 600 * 1024 * 1024;                       // началось копирование большого файла
    assert.ok(await until(() => peer.devices[0].traffic.bytesInPerMinute === 600 * 1024 * 1024),
      'копия узла отстаёт: скорость застряла на моменте занятия');
    assert.equal(peer.stateHash, 'H-const', 'хеш состояния при этом не менялся');
  } finally {
    reg.stop();
    owner.server.close();
  }
});

test('у узла ничего не занято — его без нужды не опрашиваем', async () => {
  const model = { busy: false, rate: 0 };
  const owner = await fakeOwner(model);
  const reg = registry().start();
  try {
    reg.onAnnounce({ ...announce(owner.port), busyCount: 0 });
    const peer = reg.peers.get('owner');
    assert.ok(await until(() => peer.devices?.length === 1), 'первая копия получена');
    await sleep(100);                                      // даём устояться
    const before = owner.requests;
    await sleep(500);                                      // ≈6 периодов
    assert.equal(owner.requests, before, 'свободный узел не перечитывается по таймеру');
  } finally {
    reg.stop();
    owner.server.close();
  }
});

test('занятость появилась — узел начинает перечитываться; освободился — перестаёт', async () => {
  const model = { busy: false, rate: 0 };
  const owner = await fakeOwner(model);
  const reg = registry().start();
  try {
    reg.onAnnounce({ ...announce(owner.port), busyCount: 0 });
    const peer = reg.peers.get('owner');
    assert.ok(await until(() => peer.devices?.length === 1));
    await sleep(150);

    model.busy = true;
    model.rate = 1000;
    peer.busyCount = 1;                                    // так сообщает анонс владельца
    assert.ok(await until(() => peer.devices[0].traffic?.bytesInPerMinute === 1000));

    model.busy = false;
    peer.busyCount = 0;
    assert.ok(await until(() => !peer.devices[0].claim), 'освобождение дошло');
    await sleep(150);
    const after = owner.requests;
    await sleep(400);
    assert.equal(owner.requests, after, 'после освобождения опрос прекратился');
  } finally {
    reg.stop();
    owner.server.close();
  }
});
