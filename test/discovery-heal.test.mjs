// Обнаружение: ответ на QUERY, самолечение, счётчики отброшенных пакетов, клон узла.
//   node --test test/discovery-heal.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Discovery } from '../src/net/discovery.js';
import { PROTO, MSG, encodeDatagram } from '../src/net/protocol.js';

const NET = { iface: 'Ethernet', address: '10.99.99.5', prefix: 24, cidr: '10.99.99.0/24' };

function make(extra = {}) {
  const realms = {
    announcing: () => [{ realm: 'open', key: '' }],
    keyFor: (r) => (r === 'open' ? '' : r === 'keyed' ? 'secret' : undefined),
  };
  const d = new Discovery({
    nodeId: 'me', networks: [NET], port: 0, realms, multicastAddress: '239.0.0.1',
    announceIntervalMs: 3000, announceIdleIntervalMs: 30000, announceTransport: 'both',
    getSnapshot: () => ({ stateHash: 'h1', name: 'me', version: '1' }),
    ...extra,
  });
  d.transport = 'both';
  d.socket = { close() {} };
  d.sentPackets = [];
  d._send = (b) => d.sentPackets.push(b);
  return d;
}
const healthyLeg = () => ({ net: NET, sock: { close: (cb) => cb?.() }, multicastOk: true, broadcastAddr: '10.99.99.255', broken: false });
const pkt = (msg, key = '') => encodeDatagram({ proto: PROTO, realm: 'open', ...msg }, key);

test('QUERY: спокойный узел отвечает, темп и таймер тика не сбиваются', () => {
  const d = make();
  d.announce('change');
  assert.equal(d.sentPackets.length, 1);
  d.interval = 12000;
  d.lastSentAt -= 1000;
  const timer = d.timer;

  d.announce('change');
  assert.equal(d.sentPackets.length, 1, 'обычный change при неизменном состоянии по-прежнему молчит');

  d._onMessage(pkt({ type: MSG.QUERY, nodeId: 'newbie' }), { address: '10.99.99.7' });
  assert.equal(d.sentPackets.length, 2, 'ответ на QUERY ушёл');
  assert.equal(d.sentPackets[1].type, MSG.ANNOUNCE);
  assert.equal(d.interval, 12000, 'темп не изменился');
  assert.equal(d.timer, timer, 'тик не перезаведён');
  clearTimeout(d.timer);
});

test('QUERY: чаще MIN_GAP_MS не отвечаем, запросы пачкой сливаются в один ответ', () => {
  const d = make();
  d.announce('change');
  d.announce('query');
  d.announce('query');
  assert.equal(d.sentPackets.length, 1, 'сразу после анонса ответ откладывается');
  assert.ok(d.replyTimer, 'ответ поставлен в очередь отдельным таймером');
  const t = d.replyTimer;
  d.announce('query');
  assert.equal(d.replyTimer, t, 'второй запрос не плодит таймеры');
  clearTimeout(d.replyTimer);
  clearTimeout(d.timer);
});

test('тик без изменений по-прежнему замедляет темп, а изменение возвращает быстрый', () => {
  const d = make();
  d.announce('change');
  d.lastSentAt -= 1000;
  d.announce('tick');
  assert.equal(d.interval, 6000);
  d.lastSentAt -= 1000;
  d.announce('query');
  assert.equal(d.interval, 6000, 'QUERY темп не двигает');
  d.opts.getSnapshot = () => ({ stateHash: 'h2', name: 'me', version: '1' });
  d.lastSentAt -= 1000;
  d.announce('change');
  assert.equal(d.interval, 3000);
  clearTimeout(d.timer);
});

test('needsRepair: ножка не открылась, multicast не вступил, ножка сломана, сокет умер', () => {
  const d = make();
  assert.equal(d.needsRepair(), true, 'ножки нет');
  d.legs.set(NET.address, healthyLeg());
  assert.equal(d.needsRepair(), false);

  d.legs.get(NET.address).multicastOk = false;
  assert.equal(d.needsRepair(), true, 'addMembership упал');
  d.transport = 'broadcast';
  assert.equal(d.needsRepair(), false, 'multicast выключен настройкой — это не поломка');
  d.transport = 'both';

  d.legs.set(NET.address, { ...healthyLeg(), broken: true });
  assert.equal(d.needsRepair(), true, 'сокет ножки сломан');

  d.legs.set(NET.address, healthyLeg());
  d.socketDead = true;
  assert.equal(d.needsRepair(), true, 'принимающий сокет умер');
  d.stopped = true;
  assert.equal(d.needsRepair(), false, 'после stop() чинить нечего');
});

test('repair: ограничен по частоте, пауза растёт и сбрасывается, когда всё в порядке', async () => {
  const d = make();
  let calls = 0;
  d._repairNow = async () => { calls++; };

  assert.equal(await d.repair(), true);
  assert.equal(await d.repair(), false, 'вторая попытка сразу — рано');
  assert.equal(calls, 1);

  d.repairAt = Date.now() - 11_000;
  assert.equal(await d.repair(), false, 'пауза после неудачной починки выросла');
  d.repairAt = Date.now() - 21_000;
  assert.equal(await d.repair(), true);
  assert.equal(d.repairGap, 40_000);

  d.legs.set(NET.address, healthyLeg());
  assert.equal(await d.repair(), false);
  assert.equal(d.repairGap, 10_000, 'здоровое состояние сбрасывает паузу');
});

test('смерть принимающего сокета: без слушателя не падаем, repair пересоздаёт сокет', async () => {
  const d = new Discovery({
    nodeId: 'me', networks: [], port: 0, multicastAddress: '239.0.0.1',
    announceIntervalMs: 3000, announceIdleIntervalMs: 30000, announceTransport: 'both',
    realms: { announcing: () => [{ realm: 'open', key: '' }], keyFor: () => '' },
    getSnapshot: () => ({ stateHash: 'h1', name: 'me', version: '1' }),
  });
  await d.start();
  try {
    const old = d.socket;
    old.emit('error', new Error('сокет умер'));
    assert.equal(d.socketDead, true);
    assert.equal(d.needsRepair(), true);

    const seen = [];
    d.on('error', (e) => seen.push(e.message));
    old.emit('error', new Error('ещё раз'));
    assert.deepEqual(seen, ['ещё раз'], 'слушатель получает ошибку');

    assert.equal(await d.repair(), true);
    assert.notEqual(d.socket, old, 'сокет пересоздан');
    assert.equal(d.socketDead, false);
    assert.equal(d.needsRepair(), false);

    old.emit('error', new Error('поздняя ошибка старого сокета'));
    assert.equal(d.socketDead, false, 'ошибки замененного сокета не считаются');
  } finally {
    await d.stop();
  }
});

test('счётчики отбросов по причинам и собственное эхо', () => {
  const d = make();
  const inNet = { address: '10.99.99.7' };
  d._onMessage(pkt({ type: MSG.ANNOUNCE, nodeId: 'a' }), { address: '172.16.0.9' });
  d._onMessage(pkt({ type: MSG.ANNOUNCE, nodeId: 'a', realm: 'zzz' }), inNet);
  d._onMessage(pkt({ type: MSG.ANNOUNCE, nodeId: 'a', realm: 'keyed' }, 'wrong'), inNet);
  d._onMessage(encodeDatagram({ proto: 'nds/9', type: MSG.ANNOUNCE, nodeId: 'a' }, ''), inNet);
  d._onMessage(Buffer.from('не json'), inNet);
  d._onMessage(pkt({ type: MSG.ANNOUNCE, nodeId: 'me' }), { address: NET.address });

  const s = d.stats().dropped;
  assert.deepEqual(s, { outOfNet: 1, otherRealm: 1, badSignature: 1, protoMismatch: 1, malformed: 1, echo: 1, clone: 0 });
});

test('клон: анонс с нашим nodeId от чужого адреса — счётчик и один раз на адрес', () => {
  const d = make();
  const announces = [];
  d.on('announce', (m) => announces.push(m));
  for (let i = 0; i < 3; i++) d._onMessage(pkt({ type: MSG.ANNOUNCE, nodeId: 'me' }), { address: '10.99.99.77' });
  d._onMessage(pkt({ type: MSG.ANNOUNCE, nodeId: 'me' }), { address: '10.99.99.78' });
  const st = d.stats();
  assert.equal(st.dropped.clone, 4);
  assert.deepEqual(st.clones, ['10.99.99.77', '10.99.99.78']);
  assert.equal(announces.length, 0, 'клон не попадает в список соседей');
});

test('ошибки отправки: счётчик растёт всегда, предупреждение — не чаще раза в 30 с на адрес', () => {
  const d = make();
  let failCb;
  const leg = healthyLeg();
  leg.sock = { send: (b, o, l, p, a, cb) => { failCb = cb; } };
  d.legs.set(NET.address, leg);
  delete d._send;

  const key = 'send:10.99.99.255';
  d.warnedAt.set(key, Date.now() - 1000);
  const stamp = d.warnedAt.get(key);
  d.announce('change');
  failCb(new Error('ENETUNREACH'));
  failCb(new Error('ENETUNREACH'));
  assert.equal(d.stats().sendErrors, 2);
  assert.match(d.stats().lastSendError, /ENETUNREACH/);
  assert.equal(d.warnedAt.get(key), stamp, 'предупреждение подавлено: метка не обновилась');

  d.warnedAt.set(key, Date.now() - 31_000);
  failCb(new Error('ENETUNREACH'));
  assert.ok(Date.now() - d.warnedAt.get(key) < 1000, 'через 30 с предупреждение снова проходит');
  clearTimeout(d.timer);
});

test('синхронный отказ send (сокет закрыт) помечает ножку сломанной', () => {
  const d = make();
  const leg = healthyLeg();
  leg.sock = { send: () => { throw new Error('Not running'); } };
  d.legs.set(NET.address, leg);
  delete d._send;
  d.announce('change');
  assert.equal(leg.broken, true);
  assert.equal(d.needsRepair(), true);
  assert.ok(d.stats().sendErrors >= 1);
  clearTimeout(d.timer);
});
