// Реестр узлов сети и их состояний.
//
// Анонс по UDP несёт только stateHash. Полное состояние (список устройств)
// подтягивается по HTTP и только когда хеш изменился — сеть на 20 узлов
// с постоянными анонсами не превращается в поток трафика.
//
// ОТКУДА БЕРУТСЯ УЗЛЫ. Три источника, и это видно в поле origin:
//
//   local — услышан по multicast/broadcast, то есть живёт в нашей подсети;
//   seed  — узнан от узла из ДРУГОЙ сети: либо мы сами ходим к нему по
//           настроенному адресу, либо он пришёл к нам. Такие узлы мы
//           пересказываем своим соседям, то есть работаем мостом;
//   relay — узнан от моста в нашей же подсети. Дальше НЕ пересказываем:
//           иначе каталог ходил бы по кругу и размножался.
//
// Ровно один пересказ — этого достаточно, чтобы связать два сегмента, и
// этого мало, чтобы устроить лавину.
//
// Адрес узла всегда его собственный, кем бы он ни был рассказан. Поэтому
// и состояние, и занятие, и данные USB/IP идут к владельцу напрямую:
// мост участвует только в знакомстве и не оказывается в тракте данных.

import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { rpc } from '../net/rpc.js';

const log = logger('peers');

/** Узлы, о которых мы рассказываем другим. Пересказ пересказа исключён. */
const SHAREABLE = new Set(['local', 'seed']);

export class PeerRegistry extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    /** @type {Map<string, object>} nodeId → peer */
    this.peers = new Map();
    this.sweepTimer = null;
    this.pollTimer = null;
    this.inflight = new Set();
    this.pinging = new Set();
  }

  start() {
    this.sweepTimer = setInterval(() => this._sweep(), 2000);
    this.sweepTimer.unref?.();
    this._scheduleRemotePoll();
    return this;
  }

  stop() {
    clearInterval(this.sweepTimer);
    clearTimeout(this.pollTimer);
  }

  /** Применить новый период опроса, не дожидаясь конца текущего ожидания. */
  retimeRemotePoll() {
    if (this.pollTimer) this._scheduleRemotePoll();
  }

  _scheduleRemotePoll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this._pollRemote()
        .catch((e) => log.debug(`опрос удалённых узлов: ${e.message}`))
        .finally(() => this._scheduleRemotePoll());
    }, this.opts.remotePollIntervalMs);
    this.pollTimer.unref?.();
  }

  /**
   * Опрос узлов из других сетей — напрямую у них самих.
   *
   * Анонсы по UDP до них не доходят, и без опроса их состояние обновлялось
   * бы только раз в круг обмена каталогом: опубликованное устройство
   * появлялось бы у соседей через полминуты, а занятость показывалась бы
   * устаревшей. Пересылать это через мост нельзя — он бы принимал на себя
   * тем больше, чем больше в сети устройств.
   *
   * Поэтому спрашиваем владельца сами, и спрашиваем дёшево: ping отдаёт
   * один хеш, и полный список едет, только когда хеш разошёлся.
   */
  async _pollRemote() {
    const remote = [...this.peers.values()].filter((p) => p.origin !== 'local');
    if (!remote.length) return;

    await Promise.all(remote.map(async (peer) => {
      if (this.pinging.has(peer.nodeId)) return;
      this.pinging.add(peer.nodeId);
      try {
        const pong = await rpc({
          host: peer.address,
          port: peer.apiPort,
          path: '/api/v1/peer/ping',
          key: this.opts.preSharedKey,
          nodeId: this.opts.nodeId,
          timeoutMs: 4000,
        });
        // Ответ — и есть доказательство жизни: для такого узла это
        // единственный признак, анонсов от него мы не слышим.
        peer.lastSeen = Date.now();
        if (!peer.online) {
          peer.online = true;
          log.info(`узел "${peer.name}" снова отвечает`);
          this.emit('peer-up', peer);
          this.emit('changed');
        }
        peer.reachError = null;
        if (pong?.stateHash && pong.stateHash !== peer.stateHash) {
          await this.refreshPeerState(peer, pong.stateHash);
        }
      } catch (e) {
        peer.reachError = e.message;
        log.debug(`узел "${peer.name}" (${peer.address}) не ответил: ${e.message}`);
      } finally {
        this.pinging.delete(peer.nodeId);
      }
    }));
  }

  /**
   * Сколько молчания считать пропажей.
   *
   * Для соседа по подсети — три пропущенных анонса. Темп он объявляет сам
   * (поле next), потому что мог уйти на медленный: считать по своему
   * интервалу нельзя, иначе спокойный узел выглядел бы упавшим.
   * Для узла из каталога — три пропущенных круга обмена.
   */
  _timeoutFor(peer, announcedInterval) {
    if (peer.origin === 'local') {
      const every = Number(announcedInterval) > 0 ? Number(announcedInterval) : this.opts.announceIntervalMs;
      return Math.max(this.opts.peerTimeoutMs, every * 3 + 2000);
    }
    // Узел из каталога подтверждается двумя путями — обменом каталогом и
    // прямым опросом. Считаем по тому, что происходит чаще, иначе пропажу
    // заметили бы позже, чем нужно.
    const every = Math.min(this.opts.gossipIntervalMs, this.opts.remotePollIntervalMs);
    return Math.max(this.opts.peerTimeoutMs, every * 3 + 5000);
  }

  _blank(nodeId, origin) {
    return {
      nodeId,
      origin,
      via: null,
      viaName: null,
      network: null,
      devices: [],
      groups: [],
      requests: [],
      stateHash: null,
      firstSeen: Date.now(),
    };
  }

  /** Обработка анонса. Тянет состояние, если хеш разошёлся с известным. */
  onAnnounce(msg) {
    const existing = this.peers.get(msg.nodeId);
    const now = Date.now();
    const peer = existing || this._blank(msg.nodeId, 'local');

    const renamed = existing && existing.name !== msg.name;
    const moved = existing && existing.address !== msg.address;
    const wasOffline = existing ? !existing.online : false;
    // Узел, который раньше был известен только по каталогу, теперь слышен
    // напрямую: он ближе, чем мы думали, и это главный источник.
    const promoted = existing && existing.origin !== 'local';

    Object.assign(peer, {
      origin: 'local',
      via: null,
      viaName: null,
      name: msg.name,
      address: msg.address,
      apiPort: msg.apiPort,
      usbipPort: msg.usbipPort,
      network: msg.network || peer.network,
      platform: msg.platform,
      version: msg.version,
      startedAt: msg.startedAt,
      deviceCount: msg.deviceCount,
      busyCount: msg.busyCount,
      announceEvery: Number(msg.next) || null,
      // Отпечаток каталога соседа: непустой — значит сосед знает узлы из
      // других сетей и нам есть что у него забрать.
      dir: msg.dir || null,
      lastSeen: now,
      online: true,
      self: false,
    });
    peer.timeoutMs = this._timeoutFor(peer, msg.next);

    this.peers.set(msg.nodeId, peer);

    if (!existing) {
      log.info(`обнаружен узел "${msg.name}" (${msg.address})`);
      this.emit('peer-up', peer);
    } else if (wasOffline) {
      log.info(`узел "${msg.name}" снова в сети`);
      this.emit('peer-up', peer);
    } else if (promoted) {
      log.info(`узел "${msg.name}" оказался в нашей подсети — слушаем его напрямую`);
    }
    if (renamed) log.info(`узел ${msg.nodeId.slice(0, 8)} переименован в "${msg.name}"`);

    if (peer.stateHash !== msg.stateHash || moved || wasOffline || promoted) {
      this.refreshPeerState(peer, msg.stateHash);
    } else {
      this.emit('changed');
    }
  }

  onBye(msg) {
    const peer = this.peers.get(msg.nodeId);
    if (!peer) return;
    // Прощание слышно только в своей подсети. Если узел известен и по
    // каталогу, он там и останется — исчезнет, когда перестанет
    // подтверждаться обменом.
    if (peer.origin !== 'local') return;
    log.info(`узел "${peer.name}" покинул сеть`);
    this.peers.delete(msg.nodeId);
    this.emit('peer-down', peer);
    this.emit('changed');
  }

  /**
   * Слияние каталога, полученного от другого узла.
   *
   * @param {object[]} entries  записи о узлах: идентичность, адрес, порты
   * @param {object} src
   * @param {'seed'|'relay'} src.origin  откуда пришёл каталог
   * @param {string} [src.viaNodeId]
   * @param {string} [src.viaName]
   * @returns {number} сколько записей реально что-то изменили
   */
  onDirectory(entries, { origin, viaNodeId = null, viaName = null }) {
    if (!Array.isArray(entries)) return 0;
    const now = Date.now();
    let touched = 0;

    for (const e of entries) {
      if (!e || typeof e.nodeId !== 'string' || !e.address || !e.apiPort) continue;
      if (e.nodeId === this.opts.nodeId) continue; // мы сами

      const existing = this.peers.get(e.nodeId);

      // Услышанный вживую сосед важнее пересказанного: его данные свежее,
      // и подменять их чужим рассказом нельзя.
      if (existing && existing.origin === 'local') continue;
      // Пересказ от соседа не должен затирать то, что мы знаем от моста.
      if (existing && existing.origin === 'seed' && origin === 'relay') {
        existing.lastSeen = now;
        continue;
      }

      const peer = existing || this._blank(e.nodeId, origin);
      const isNew = !existing;
      const changedHash = peer.stateHash !== (e.stateHash ?? null);
      const wasOffline = existing ? !existing.online : false;

      Object.assign(peer, {
        origin,
        via: viaNodeId,
        viaName,
        name: e.name || peer.name,
        address: e.address,
        apiPort: e.apiPort,
        usbipPort: e.usbipPort,
        network: e.network || null,
        platform: e.platform || null,
        version: e.version || null,
        startedAt: e.startedAt || null,
        deviceCount: e.deviceCount ?? peer.deviceCount,
        busyCount: e.busyCount ?? peer.busyCount,
        lastSeen: now,
        online: true,
        self: false,
      });
      peer.timeoutMs = this._timeoutFor(peer);
      this.peers.set(e.nodeId, peer);

      if (isNew) {
        log.info(`из каталога узла "${viaName || 'неизвестно'}": узел "${peer.name}" (${peer.address}${peer.network ? `, сеть ${peer.network}` : ''})`);
        this.emit('peer-up', peer);
        touched++;
      } else if (wasOffline) {
        log.info(`узел "${peer.name}" снова в сети (по каталогу)`);
        this.emit('peer-up', peer);
        touched++;
      }

      // Состояние забираем у владельца напрямую, минуя того, кто о нём
      // рассказал: мост не должен быть в тракте данных.
      if (isNew || changedHash || wasOffline) {
        this.refreshPeerState(peer, e.stateHash ?? null);
        touched++;
      }
    }

    if (touched) this.emit('changed');
    return touched;
  }

  /** Записи о узлах, которыми мы делимся с другими. Без пересказа пересказа. */
  directoryEntries() {
    const out = [];
    for (const p of this.peers.values()) {
      if (!SHAREABLE.has(p.origin)) continue;
      if (!p.online) continue;
      out.push({
        nodeId: p.nodeId,
        name: p.name,
        address: p.address,
        apiPort: p.apiPort,
        usbipPort: p.usbipPort,
        network: p.network,
        platform: p.platform,
        version: p.version,
        startedAt: p.startedAt,
        stateHash: p.stateHash,
        deviceCount: p.deviceCount ?? (p.devices || []).length,
        busyCount: p.busyCount ?? (p.devices || []).filter((d) => d.claim).length,
      });
    }
    return out;
  }

  /** Есть ли у нас узлы, полученные из других сетей, — то есть мост ли мы. */
  bridged() {
    return [...this.peers.values()].filter((p) => p.origin === 'seed' && p.online);
  }

  /**
   * Забыть всё, что известно только из каталога.
   *
   * Нужно, когда обмен выключают: узлы из других сетей сами по себе никуда
   * не денутся ещё минуту, и всё это время мы продолжали бы рассказывать о
   * них соседям. Человек, убравший адрес, вправе ожидать, что связь
   * оборвалась, а не «оборвётся когда-нибудь».
   */
  forgetRemote() {
    let dropped = 0;
    for (const [id, peer] of this.peers) {
      if (peer.origin === 'local') continue;
      this.peers.delete(id);
      this.emit('peer-down', peer);
      dropped++;
    }
    if (dropped) {
      log.info(`забыты узлы из других сетей: ${dropped}`);
      this.emit('changed');
    }
    return dropped;
  }

  /** Знаем ли мы узел с таким адресом. Нужен для допуска соединений данных. */
  hasAddress(ip) {
    if (!ip) return false;
    for (const p of this.peers.values()) {
      if (p.address === ip) return true;
    }
    return false;
  }

  async refreshPeerState(peer, expectedHash) {
    if (this.inflight.has(peer.nodeId)) return;
    this.inflight.add(peer.nodeId);
    try {
      const state = await rpc({
        host: peer.address,
        port: peer.apiPort,
        path: '/api/v1/peer/state',
        key: this.opts.preSharedKey,
        nodeId: this.opts.nodeId,
        timeoutMs: 4000,
      });
      peer.devices = Array.isArray(state?.devices) ? state.devices : [];
      peer.groups = Array.isArray(state?.groups) ? state.groups : [];
      // Запросы приходят уже отфильтрованными: владелец отдаёт только те,
      // где мы проситель или держатель.
      peer.requests = Array.isArray(state?.requests) ? state.requests : [];
      peer.stateHash = state?.stateHash ?? expectedHash ?? null;
      peer.name = state?.name || peer.name;
      peer.stateError = null;
      log.debug(`состояние "${peer.name}" обновлено: устройств ${peer.devices.length}, групп ${peer.groups.length}`);
      this.emit('changed');
    } catch (e) {
      peer.stateError = e.message;
      // Для узла из каталога это самая частая и самая понятная поломка:
      // рассказали о нём, а маршрута или правила брандмауэра нет.
      if (peer.origin !== 'local') {
        log.warn(`узел "${peer.name}" (${peer.address}) известен по каталогу, но недоступен напрямую: ${e.message}`);
      } else {
        log.warn(`не удалось получить состояние узла "${peer.name}": ${e.message}`);
      }
      this.emit('changed');
    } finally {
      this.inflight.delete(peer.nodeId);
    }
  }

  /** Помечает молчащие узлы офлайн и через время забывает их совсем. */
  _sweep() {
    const now = Date.now();
    let changed = false;

    for (const [id, peer] of this.peers) {
      const silence = now - peer.lastSeen;
      const timeout = peer.timeoutMs || this.opts.peerTimeoutMs;
      if (peer.online && silence > timeout) {
        peer.online = false;
        changed = true;
        log.warn(`узел "${peer.name}" не отвечает ${Math.round(silence / 1000)} с — помечен офлайн`);
        this.emit('peer-down', peer);
      }
      // Забываем заметно позже, чем помечаем офлайн: на медленном темпе
      // анонсов таймаут сам по себе велик, и при фиксированном сроке узел
      // исчезал бы из списка почти сразу после того, как в нём погас.
      if (silence > Math.max(this.opts.peerForgetMs, timeout * 2)) {
        this.peers.delete(id);
        changed = true;
        log.info(`узел "${peer.name}" удалён из списка`);
      }
    }
    if (changed) this.emit('changed');
  }

  get(nodeId) {
    return this.peers.get(nodeId);
  }

  list() {
    return [...this.peers.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
}
