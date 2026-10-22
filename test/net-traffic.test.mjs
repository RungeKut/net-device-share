// Скорость обмена у проброшенной сетевой карты: считается так же, как у USB, и так же доходит.
//   node --test test/net-traffic.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { NetShare } from '../src/core/netShare.js';
import { PeerRegistry } from '../src/cluster/peers.js';
import { VSwitch } from '../src/net/vswitch.js';

function netShare() {
  const config = { get: () => null, data: {} };
  return new NetShare({ config, workingIface: () => null });
}

/** Отданная карта с «посредником», чьи счётчики кадров растут по ходу теста. */
function lendWithRelay(ns, deviceId = 'net:Ethernet_2') {
  const relay = { toTap: 0, fromTap: 0 };
  ns.lends.set(deviceId, { deviceId, relay, session: { connected: () => true } });
  ns._meterBegin(deviceId);
  return { relay, deviceId };
}

test('скорость карты: приращение счётчиков кадров превращается в байты за минуту', () => {
  const ns = netShare();
  const { relay, deviceId } = lendWithRelay(ns);
  ns._tick();                                    // первый тик запоминает начальные значения
  for (let i = 0; i < 5; i++) {
    relay.toTap += 10 * 1024 * 1024;             // от держателя в провод: 10 МБ в секунду
    relay.fromTap += 2 * 1024 * 1024;            // из провода к держателю: 2 МБ в секунду
    ns._tick();
  }
  const s = ns.statsFor(deviceId);
  assert.equal(s.bytesInPerMinute, 50 * 1024 * 1024);
  assert.equal(s.bytesOutPerMinute, 10 * 1024 * 1024);
  assert.equal(s.totalIn, 50 * 1024 * 1024);
  assert.equal(s.connections, 1);
  assert.ok(s.lastActivity);
});

test('когда обмен кончился, скорость падает до нуля за минуту, а суммарный объём остаётся', () => {
  const ns = netShare();
  const { relay, deviceId } = lendWithRelay(ns);
  ns._tick();
  relay.toTap += 5 * 1024 * 1024;
  ns._tick();
  assert.equal(ns.statsFor(deviceId).bytesInPerMinute, 5 * 1024 * 1024);
  for (let i = 0; i < 61; i++) ns._tick();       // тишина дольше окна в 60 секунд
  const s = ns.statsFor(deviceId);
  assert.equal(s.bytesInPerMinute, 0, 'цифра не «залипает»');
  assert.equal(s.totalIn, 5 * 1024 * 1024);
});

test('событие traffic — только при обмене (иначе интерфейс перерисовывался бы каждую секунду зря)', () => {
  const ns = netShare();
  const { relay } = lendWithRelay(ns);
  let events = 0;
  ns.on('traffic', () => { events++; });
  ns._tick();
  ns._tick();
  assert.equal(events, 0);
  relay.fromTap += 1000;
  ns._tick();
  assert.equal(events, 1);
});

test('карта освобождена — счётчик убран, статистики нет', () => {
  const ns = netShare();
  const { deviceId } = lendWithRelay(ns);
  assert.ok(ns.statsFor(deviceId));
  ns.lends.delete(deviceId);
  ns.meters.delete(deviceId);
  assert.equal(ns.statsFor(deviceId), null);
});

test('в общем мосту у каждого держателя своя скорость, у целиком отданной — общая и есть личная', () => {
  const ns = netShare();
  const sw = new VSwitch({ id: 'net:Ethernet_2' });
  const portA = sw.attach('holder:A', { send: () => {} });
  sw.attach('holder:B', { send: () => {} });
  const relay = { toTap: 0, fromTap: 0 };
  ns.lends.set('net:Ethernet_2', {
    deviceId: 'net:Ethernet_2', mode: 'bridge', relay, sw, session: null,
    holders: new Map([
      ['A', { session: { connected: () => true } }],
      ['B', { session: { connected: () => false } }],
    ]),
  });
  ns._meterBegin('net:Ethernet_2');
  ns.holderMeters.set('net:Ethernet_2', new Map([['A', ns._newMeter()], ['B', ns._newMeter()]]));
  ns._tick();                                   // первый тик запоминает нули

  const frame = Buffer.allocUnsafe(2 + 1000);   // один кадр в 1000 байт от A
  frame.writeUInt16BE(1000, 0);
  portA.input(frame);
  // Кадр A через коммутатор ушёл в карту (1000), плюс 500 байт отправил сам
  // владелец: общий счётчик карты читает посредника, личные — порты.
  relay.toTap += 1000 + 500;
  ns._tick();

  const a = ns.statsFor('net:Ethernet_2', 'A');
  assert.equal(a.bytesInPerMinute, 1000, 'у A — только его кадры');
  assert.equal(a.connections, 1);
  const b = ns.statsFor('net:Ethernet_2', 'B');
  assert.equal(b.bytesInPerMinute, 0, 'B ничего не отправлял');
  assert.equal(b.bytesOutPerMinute, 1002, 'кадр A прилетел B флудом (tx считает с заголовком длины)');
  assert.equal(b.connections, 0);
  assert.equal(ns.statsFor('net:Ethernet_2').bytesInPerMinute, 1500, 'общая — всё, что прошло через карту, включая владельца');

  // Держатель вышел — личный счётчик убран, и вопрос о нём отвечает общая
  // цифра карты: пустая была бы враньём, общая — честно.
  ns.holderMeters.get('net:Ethernet_2').delete('B');
  assert.equal(ns.statsFor('net:Ethernet_2', 'B').bytesInPerMinute, 1500);

  // Целиком отданная карта: держателя в мосту нет — renew с holderId получает общую.
  assert.equal(ns.statsFor('net:other', 'X'), null);
});

test('у соседа сетевая карта: скорость на нашей стороне тоже не «замерзает»', async () => {
  const model = { rate: 200 };                   // момент занятия
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      nodeId: 'owner', name: 'OWNER', stateHash: 'H-const',
      devices: [{
        deviceId: 'net:Ethernet_2', type: 'net', title: 'Ethernet 2', description: 'Сетевая карта',
        claim: { holderId: 'me', holderName: 'ME', since: Date.now() },
        traffic: { bytesInPerMinute: model.rate, bytesOutPerMinute: 0, totalIn: model.rate, totalOut: 0 },
      }],
      groups: [], requests: [],
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const reg = new PeerRegistry({
    nodeId: 'me', realms: { keyFor: () => '' }, peerTimeoutMs: 60000, peerForgetMs: 120000,
    announceIntervalMs: 60000, gossipIntervalMs: 60000, remotePollIntervalMs: 60000, trafficRefreshMs: 80,
  }).start();
  try {
    reg.onAnnounce({
      nodeId: 'owner', name: 'OWNER', address: '127.0.0.1', apiPort: server.address().port, usbipPort: 3240, realm: 'open',
      version: '2.2.1', startedAt: Date.now(), deviceCount: 1, busyCount: 1, stateHash: 'H-const', next: 60000,
    });
    const peer = reg.peers.get('owner');
    const until = async (cond) => { for (let i = 0; i < 120 && !cond(); i++) await new Promise((r) => setTimeout(r, 25)); return cond(); };
    assert.ok(await until(() => peer.devices?.[0]?.traffic?.bytesInPerMinute === 200));
    model.rate = 90 * 1024 * 1024;
    assert.ok(await until(() => peer.devices[0].traffic.bytesInPerMinute === 90 * 1024 * 1024));
  } finally {
    reg.stop();
    server.close();
  }
});
