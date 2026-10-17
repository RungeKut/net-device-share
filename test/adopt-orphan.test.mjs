// Подключение пережило перезапуск приложения: «внешнее» или своё?
//   node --test test/adopt-orphan.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AttachManager, attachKey } from '../src/core/attachManager.js';

/** Подставной владелец: отвечает на проверку связи так, как велит сценарий. */
function fakeOwner(answer) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        calls.push({ url: req.url, body: body ? JSON.parse(body) : null });
        const [status, payload] = answer();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls }));
  });
}

function managerWith({ peer, live }) {
  const backend = { listAttached: async () => live };
  const config = { get: (k) => ({ nodeId: 'me', apiPort: 47812, usbipPort: 3240, heartbeatIntervalMs: 10000 }[k]) };
  const mgr = new AttachManager({
    backend, config, share: {}, keyFor: () => '',
    peerByAddress: (addr) => (peer && peer.address === addr ? peer : null),
  });
  return mgr;
}

const LIVE = [{ host: '127.0.0.1', busid: '3-2', vhciPort: 1, vendorId: '1c75', productId: '02cb' }];

test('после перезапуска подключение «внешнее», но с типом — интерфейс может объяснить, что с ним', async () => {
  const mgr = managerWith({ peer: null, live: LIVE });
  await mgr.reconcile();
  const [rec] = mgr.list();
  assert.equal(rec.orphan, true);
  assert.equal(rec.parts[0].type, 'usb');
  assert.match(rec.parts[0].title, /1c75:02cb/);
});

test('владелец известен и аренда за нами — подключение узнаётся заново', async () => {
  const owner = await fakeOwner(() => [200, { ok: true }]);
  const peer = {
    nodeId: 'owner-1', name: 'СТЕНД', address: '127.0.0.1', apiPort: owner.port, online: true,
    devices: [{ deviceId: 'usb:3-2', title: 'Digilent JTAG', description: 'USB-JTAG' }],
  };
  const mgr = managerWith({ peer, live: LIVE });
  await mgr.reconcile();
  assert.equal(mgr.list()[0].orphan, true);

  await mgr._adoptOrphans();
  const list = mgr.list();
  assert.equal(list.length, 1, 'одна запись, а не две');
  const rec = list[0];
  assert.equal(rec.orphan, false);
  assert.equal(rec.adopted, true);
  assert.equal(rec.id, attachKey('owner-1', 'usb:3-2'));
  assert.equal(rec.nodeName, 'СТЕНД');
  assert.equal(rec.title, 'Digilent JTAG');
  assert.equal(rec.parts[0].vhciPort, 1, 'порт драйвера сохранён: отцепить можно');
  assert.equal(rec.parts[0].type, 'usb');
  assert.equal(owner.calls[0].url, '/api/v1/peer/heartbeat');
  assert.deepEqual(owner.calls[0].body, { target: 'usb:3-2' });
  owner.server.close();
});

test('владелец не считает подключение нашим — остаётся внешним, с объяснением', async () => {
  const owner = await fakeOwner(() => [400, { error: 'no_claim', message: 'не занято' }]);
  const peer = { nodeId: 'owner-1', name: 'СТЕНД', address: '127.0.0.1', apiPort: owner.port, online: true, devices: [] };
  const mgr = managerWith({ peer, live: LIVE });
  await mgr.reconcile();
  await mgr._adoptOrphans();
  const [rec] = mgr.list();
  assert.equal(rec.orphan, true);
  assert.match(rec.orphanNote, /не считает это подключение вашим/);
  owner.server.close();
});

test('владельца не знаем (или он не в сети) — ничего не трогаем', async () => {
  const mgr = managerWith({ peer: null, live: LIVE });
  await mgr.reconcile();
  await mgr._adoptOrphans();
  assert.equal(mgr.list()[0].orphan, true);

  const offline = { nodeId: 'o', name: 'X', address: '127.0.0.1', apiPort: 1, online: false };
  const mgr2 = managerWith({ peer: offline, live: LIVE });
  await mgr2.reconcile();
  await mgr2._adoptOrphans();
  assert.equal(mgr2.list()[0].orphan, true);
});
