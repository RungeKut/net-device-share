// Прощание узла: без пересказа запись удаляется, с живым пересказом шлюза —
// переходит на relay и живёт, пока рассказчики подтверждают.
//   node --test test/peers-bye.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerRegistry } from '../src/cluster/peers.js';

const NET_A = '10.0.3.0/24';
const NET_B = '10.0.6.0/24';

function registry(nodeId = 'me') {
  const reg = new PeerRegistry({
    nodeId, realms: { keyFor: () => '' }, peerTimeoutMs: 12000, peerForgetMs: 60000,
    announceIntervalMs: 3000, gossipIntervalMs: 20000, remotePollIntervalMs: 20000,
    networkOf: (ip) => (ip.startsWith('10.0.3.') ? NET_A : ip.startsWith('10.0.6.') ? NET_B : null),
  });
  reg.refreshPeerState = () => {};
  return reg;
}
const announce = (reg, nodeId, address) => reg.onAnnounce({
  nodeId, name: nodeId.toUpperCase(), address, realm: 'open', apiPort: 47812, usbipPort: 3240,
  stateHash: 'h', next: 3000, network: null,
});

test('прощание узла без пересказа удаляет запись, как раньше', () => {
  const reg = registry();
  announce(reg, 'a1', '10.0.3.5');
  reg.onBye({ nodeId: 'a1', realm: 'open' });
  assert.equal(reg.get('a1'), undefined);
});

test('прощание в одном круге при живом другом — узел остаётся соседом', () => {
  const reg = registry();
  announce(reg, 'a1', '10.0.3.5');
  reg.onBye({ nodeId: 'a1', realm: 'open' });
  reg.onAnnounce({
    nodeId: 'a1', name: 'A1', address: '10.0.3.5', realm: 'keyed', apiPort: 47812,
    usbipPort: 3240, stateHash: 'h', next: 3000, network: null,
  });
  assert.equal(reg.get('a1').origin, 'local');
});

test('прощание узла, о котором ещё рассказывает шлюз, — запись переходит на пересказ', () => {
  const reg = registry();
  // шлюз рассказал о узле из другой сети
  reg.onDirectory(
    [{ nodeId: 'a1', name: 'A1', address: '10.0.6.9', apiPort: 47812, usbipPort: 3240, network: NET_B }],
    { origin: 'relay', realm: 'open', viaNodeId: 'gw', viaName: 'GW', via: { nodeId: 'gw', name: 'GW', address: '10.0.3.1', apiPort: 47812 } },
  );
  // узел оказался и в нашей подсети, а потом попрощался в ней
  announce(reg, 'a1', '10.0.3.5');
  assert.equal(reg.get('a1').origin, 'local');
  assert.equal(reg.get('a1').routes.size, 2, 'прямой маршрут и пересказанный');

  reg.onBye({ nodeId: 'a1', realm: 'open' });
  const peer = reg.get('a1');
  assert.ok(peer, 'запись не удалена: о узле ещё рассказывают');
  assert.equal(peer.origin, 'relay');
  assert.equal(peer.address, '10.0.6.9', 'основной адрес — пересказанный');
  assert.equal(peer.via, 'gw');
  assert.equal(peer.viaName, 'GW');
  assert.equal(peer.routeKey, '10.0.6.9:47812|gw');
  assert.deepEqual(peer.realmSeen, {}, 'в нашей подсети узла больше не слышно');
  assert.equal(peer.online, false, 'прямого доказательства жизни нет — присутствие подтвердится каталогом или опросом');
  assert.ok(peer.timeoutMs > 0);

  // Каталог всё ещё рассказывает о узле — запись возвращается в сеть.
  reg.onDirectory(
    [{ nodeId: 'a1', name: 'A1', address: '10.0.6.9', apiPort: 47812, usbipPort: 3240, network: NET_B, stateHash: 'h' }],
    { origin: 'relay', realm: 'open', viaNodeId: 'gw', viaName: 'GW', via: { nodeId: 'gw', name: 'GW', address: '10.0.3.1', apiPort: 47812 } },
  );
  assert.equal(reg.get('a1').online, true, 'пересказ подтвердился — узел снова в сети');
});

test('пересказ, о котором давно никто не рассказывал, прощание не спасает', () => {
  const reg = registry();
  reg.onDirectory(
    [{ nodeId: 'a1', name: 'A1', address: '10.0.6.9', apiPort: 47812, usbipPort: 3240, network: NET_B }],
    { origin: 'relay', realm: 'open', viaNodeId: 'gw', viaName: 'GW', via: { nodeId: 'gw', name: 'GW', address: '10.0.3.1', apiPort: 47812 } },
  );
  const peer = reg.get('a1');
  const stale = [...peer.routes.values()][0];
  stale.lastSeen = Date.now() - 24 * 3600 * 1000;   // рассказчик замолчал давно
  announce(reg, 'a1', '10.0.3.5');
  reg.onBye({ nodeId: 'a1', realm: 'open' });
  assert.equal(reg.get('a1'), undefined, 'зомби-запись не остаётся');
});

test('узел, объявленный не из той сети, где слышен, помечен «за NAT»', () => {
  const reg = registry();
  reg.opts.networkOf = (ip) => (ip.startsWith('10.0.3.') ? NET_A : null);
  reg.onAnnounce({
    nodeId: 'vm', name: 'VM', address: '10.0.3.46', realm: 'open', apiPort: 47812, usbipPort: 3240,
    stateHash: 'h', next: 3000, network: '192.168.137.0/24',
  });
  assert.deepEqual(reg.get('vm').redirected, { network: '192.168.137.0/24', heardOn: NET_A }, 'анонс из чужой подсети');

  reg.onAnnounce({
    nodeId: 'vm', name: 'VM', address: '10.0.3.46', realm: 'open', apiPort: 47812, usbipPort: 3240,
    stateHash: 'h', next: 3000, network: NET_A,
  });
  assert.equal(reg.get('vm').redirected, null, 'анонс из своей сети — пометка снята');
});

test('noteSeedSelf: рабочий адрес от обмена становится основным маршрутом узла', () => {
  const reg = registry();
  reg.onDirectory(
    [{ nodeId: 'vm', name: 'VM', address: '192.168.137.9', apiPort: 47812, usbipPort: 3240, network: '192.168.137.0/24' }],
    { origin: 'seed', realm: 'open', viaNodeId: 'vm', viaName: 'VM', via: { nodeId: 'vm', name: 'VM', address: '10.0.3.46', apiPort: 47822 } },
  );
  const peer = reg.get('vm');
  assert.equal(peer.routes.get(peer.routeKey).address, '192.168.137.9', 'внутренний адрес из каталога');

  reg.noteSeedSelf('vm', '10.0.3.46', 47822);
  const main = peer.routes.get(peer.routeKey);
  assert.equal(main.address, '10.0.3.46');
  assert.equal(main.apiPort, 47822, 'достижимый через проброс адрес:порт');
  assert.equal(main.mode, 'direct', 'мы только что успешно поговорили по нему');
});

test('noteGhosts: нашли себя — узел знает, что его видно под чужим адресом', () => {
  const reg = registry('vm-node');
  const events = [];
  reg.on('changed', () => events.push(1));

  reg.noteGhosts([{ nodeId: 'other', address: '10.0.3.46' }]);
  assert.equal(reg.ghosted, null, 'нас в списке нет');

  reg.noteGhosts([{ nodeId: 'vm-node', address: '10.0.3.46' }]);
  assert.equal(reg.ghosted.address, '10.0.3.46');
  const marks = events.length;

  reg.noteGhosts([{ nodeId: 'vm-node', address: '10.0.3.46' }]);
  assert.equal(events.length, marks, 'повторное подтверждение не дёргает интерфейс');

  reg.noteGhosts([]);
  assert.equal(reg.ghosted, null, 'отражение пропало — знак снят');
});

test('разные маски у соседей — не «чужая сеть»: источник внутри объявленной сети', () => {
  const reg = registry();
  reg.onAnnounce({
    nodeId: 'm', name: 'M', address: '10.0.3.46', realm: 'open', apiPort: 47812, usbipPort: 3240,
    stateHash: 'h', next: 3000, network: '10.0.3.0/24',   // сосед считает свою подсеть /24, у нас /21
  });
  assert.equal(reg.get('m').redirected, null, 'источник внутри своей сети — честный узел');
});

test('пересказанный узел с нашим же адресом не заводится', () => {
  const reg = registry();
  reg.opts.isOwnAddress = (ip) => ip === '200.100.1.1';
  reg.onDirectory(
    [{ nodeId: 'vm', name: 'VM', address: '200.100.1.1', apiPort: 47812, usbipPort: 3240, network: '192.168.52.0/24' }],
    { origin: 'relay', realm: 'open', viaNodeId: 'nb', viaName: 'NB', via: { nodeId: 'nb', name: 'NB', address: '10.0.3.5', apiPort: 47812 } },
  );
  assert.equal(reg.get('vm'), undefined, 'отражение от соседа — в список не попадает');
});

test('узел, весь транспорт которого — отражённые анонсы, не пересказывается', () => {
  const reg = registry();
  reg.opts.networkOf = (ip) => (ip.startsWith('10.0.3.') ? NET_A : null);
  reg.onAnnounce({
    nodeId: 'vm', name: 'VM', address: '10.0.3.46', realm: 'open', apiPort: 47812, usbipPort: 3240,
    stateHash: 'h', next: 3000, network: '192.168.52.0/24',
  });
  assert.ok(reg.get('vm').redirected, 'помечен: источник вне объявленной сети');
  assert.deepEqual(reg.directoryEntries('open', { forNetwork: '10.0.9.0/24' }), [], 'не рассказываем');

  reg.noteSeedSelf('vm', '10.0.3.46', 47822);   // появился рабочий проброс + seed
  const out = reg.directoryEntries('open', { forNetwork: '10.0.9.0/24' });
  assert.equal(out.length, 1, 'рабочий маршрут — снова рассказываем');
  assert.equal(out[0].address, '10.0.3.46');
  assert.equal(out[0].apiPort, 47822, 'адрес:порт из основного маршрута, не из отражённого');
});
