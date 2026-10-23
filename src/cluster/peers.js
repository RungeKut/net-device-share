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
// МАРШРУТЫ. Узел, видимый из нескольких сетей, — одна запись, а адреса у неё
// несколько (peer.routes): услышан напрямую в нашей сети, пересказан шлюзом из
// другой, пересказан мостом по обмену каталогом. Маршрут, о котором рассказал
// другой узел, помнит рассказчика (via): если напрямую до узла не дотянуться,
// соединение идёт через туннель на этом рассказчике (net/tunnels.js).
//
// Адрес узла всегда его собственный, кем бы он ни был рассказан. Поэтому
// и состояние, и занятие, и данные USB/IP идут к владельцу напрямую:
// мост участвует только в знакомстве и не оказывается в тракте данных.

import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { rpc } from '../net/rpc.js';
import crypto from 'node:crypto';

const log = logger('peers');

/** Узлы, о которых мы рассказываем другим. Пересказ пересказа исключён. */
const SHAREABLE = new Set(['local', 'seed']);

/** Сколько живёт маршрут без подтверждения, в таймаутах узла. */
const ROUTE_TTL_FACTOR = 3;

/** Порты по умолчанию — для узлов прежних версий, которые о них не объявляют. */
const DEFAULT_TRAFFIC_PORT = 47813;
const DEFAULT_NETLINK_PORT = 47814;

export class PeerRegistry extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    /** @type {Map<string, object>} nodeId → peer */
    this.peers = new Map();
    this.sweepTimer = null;
    this.pollTimer = null;
    this.trafficTimer = null;
    this.inflight = new Set();
    this.pinging = new Set();
    this.stopped = false;
    /** @type {Map<string, {host: string, port: number, until: number}>} открытые туннели через шлюзы */
    this.tunnelCache = new Map();
  }

  start() {
    this.stopped = false;
    this.sweepTimer = setInterval(() => this._sweep(), 2000);
    this.sweepTimer.unref?.();
    this._scheduleRemotePoll();
    // Скорость обмена у соседей. Точные байты в хеш состояния не входят (они меняются
    // каждую секунду, и соседи перечитывали бы состояние без остановки), а значит,
    // пока у узла ничего не меняется, наша копия его устройств не обновлялась бы и
    // показывала скорость на момент последнего изменения — например, 320 байт в минуту
    // у флешки, с которой уже копируют гигабайты. Поэтому узлы, у которых есть занятые
    // устройства, перечитываем сами, часто: нагрузка — один небольшой запрос на занятый узел.
    const every = Number(process.env.NDS_TRAFFIC_REFRESH_MS) || this.opts.trafficRefreshMs || 5000;
    this.trafficTimer = setInterval(() => this._refreshBusy(), every);
    this.trafficTimer.unref?.();
    return this;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    clearInterval(this.trafficTimer);
    clearTimeout(this.pollTimer);
  }

  /** Перечитать состояние узлов, у которых что-то занято: только у них меняется скорость. */
  _refreshBusy() {
    for (const peer of this.peers.values()) {
      if (!peer.online) continue;
      // Карта в общем мосту занятой не числится (claim нет), но держатели в joins
      // гоняют трафик: без них скорость моста у соседей замерзала.
      const busy = (peer.devices || []).some((d) => d.claim || d.joins?.length) || (peer.busyCount || 0) > 0;
      if (busy) this.refreshPeerState(peer, null).catch(() => {});
    }
  }

  /** Применить новый период опроса, не дожидаясь конца текущего ожидания. */
  retimeRemotePoll() {
    if (this.pollTimer) this._scheduleRemotePoll();
  }

  _scheduleRemotePoll() {
    clearTimeout(this.pollTimer);
    // Опрос, закончившийся после stop(), не должен взводить таймер заново.
    if (this.stopped) return;
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
    const remote = [...this.peers.values()].filter((p) => p.origin !== 'local'
      || [...p.routes.values()].some((r) => r.kind !== 'direct'));
    if (!remote.length) return;

    await Promise.all(remote.map(async (peer) => {
      if (this.pinging.has(peer.nodeId)) return;
      this.pinging.add(peer.nodeId);
      try {
        // Запасные маршруты (пересказанные адреса узла, который мы слышим и
        // напрямую) проверяем отдельно: от них зависит, что показать в окне выбора.
        for (const r of [...peer.routes.values()]) {
          if (r.key !== peer.routeKey && r.kind !== 'direct') await this.probeRoute(peer, r);
        }
        if (peer.origin === 'local') return;
        const main = this.primaryRoute(peer);
        if (main && main.kind !== 'direct' && !main.mode) await this.probeRoute(peer, main);
        const ep = await this.endpoint(peer, peer.apiPort);
        const pong = await rpc({
          host: ep.host,
          port: ep.port,
          path: '/api/v1/peer/ping',
          key: this.opts.realms.keyFor(peer.realm),
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
        if (main) { main.lastSeen = Date.now(); if (!main.mode) main.mode = ep.tunnel ? 'tunnel' : 'direct'; }
        if (pong?.stateHash && pong.stateHash !== peer.stateHash) {
          await this.refreshPeerState(peer, pong.stateHash);
        }
      } catch (e) {
        peer.reachError = e.message;
        // Прямой маршрут, который перестал отвечать, пробуем заново: возможно,
        // теперь остался только туннель через шлюз.
        const main = this.primaryRoute(peer);
        if (main && main.via && main.kind !== 'direct') main.mode = null;
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
      /** @type {Map<string, object>} ключ → маршрут (адрес в какой-то из сетей) */
      routes: new Map(),
      routeKey: null,
      // Круг доверия, в котором узел услышан. По нему выбирается ключ
      // для вызовов к нему и понятное название сети в списке.
      realm: null,
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

    // Узел, слышный сразу в двух наших сетях, присылает один анонс с каждого
    // адреса. Прежний адрес сохраняем, пока он жив: иначе запись прыгала бы
    // между двумя адресами на каждом пакете, и каждый прыжок — лишний запрос
    // состояния. Сменить адрес стоит, только когда прежний замолчал.
    const seen = peer.seenAt || (peer.seenAt = {});
    seen[msg.address] = now;
    let address = msg.address;
    if (existing && existing.origin === 'local' && existing.address !== msg.address
      && now - (seen[existing.address] || 0) < this._timeoutFor(existing, msg.next)) {
      address = existing.address;
    }

    this._touchRoute(peer, {
      kind: 'direct', origin: 'local', address: msg.address,
      apiPort: msg.apiPort, usbipPort: msg.usbipPort, trafficPort: msg.trafficPort, netLinkPort: msg.netLinkPort,
      network: msg.network || null, heardOn: this.opts.networkOf?.(msg.address) || null, via: null, mode: 'direct',
    }, now);
    peer.routeKey = this._routeKey({ address, via: null });

    const renamed = existing && existing.name !== msg.name;
    const moved = existing && existing.address !== address;
    const wasOffline = existing ? !existing.online : false;
    // Узел, который раньше был известен только по каталогу, теперь слышен
    // напрямую: он ближе, чем мы думали, и это главный источник.
    const promoted = existing && existing.origin !== 'local';

    Object.assign(peer, {
      origin: 'local',
      via: null,
      viaName: null,
      realm: msg.realm,
      name: msg.name,
      address,
      apiPort: msg.apiPort,
      usbipPort: msg.usbipPort,
      network: msg.network || peer.network,
      nets: Number(msg.nets) || 1,
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
  onDirectory(entries, { origin, realm, viaNodeId = null, viaName = null, via = null }) {
    if (!Array.isArray(entries)) return 0;
    const now = Date.now();
    let touched = 0;

    for (const e of entries) {
      if (!e || typeof e.nodeId !== 'string' || !e.address || !e.apiPort) continue;
      if (e.nodeId === this.opts.nodeId) continue; // мы сами

      const existing = this.peers.get(e.nodeId);

      // Рассказанный адрес — это ещё один маршрут до узла, а не замена того,
      // что уже известно. Услышанный вживую сосед важнее пересказанного: его
      // данные свежее, и подменять их чужим рассказом нельзя.
      const told = {
        kind: origin === 'seed' ? 'seed' : 'relay', origin, address: e.address,
        apiPort: e.apiPort, usbipPort: e.usbipPort, trafficPort: e.trafficPort, netLinkPort: e.netLinkPort,
        network: e.network || null, heardOn: null, via: via || (viaNodeId ? { nodeId: viaNodeId, name: viaName } : null),
        mode: null,
      };
      if (existing && existing.origin === 'local') {
        // Тот же адрес, что слышим сами, маршрутом не считается.
        if (![...existing.routes.values()].some((r) => r.kind === 'direct' && r.address === e.address)) {
          if (this._touchRoute(existing, told, now)) touched++;
        }
        continue;
      }
      // Пересказ от соседа не должен затирать то, что мы знаем от моста.
      if (existing && existing.origin === 'seed' && origin === 'relay') {
        existing.lastSeen = now;
        if (this._touchRoute(existing, told, now)) touched++;
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
        // Круг берётся из обмена, а не из самой записи: рассказать о себе
        // можно что угодно, а подписаться чужим ключом — нет.
        realm,
        name: e.name || peer.name,
        address: e.address,
        apiPort: e.apiPort,
        usbipPort: e.usbipPort,
        trafficPort: e.trafficPort,
        netLinkPort: e.netLinkPort,
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
      this._touchRoute(peer, told, now);
      peer.routeKey = this._routeKey(told);
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

  /**
   * Записи о узлах, которыми мы делимся с другими. Без пересказа пересказа.
   *
   * @param {string} realm
   * @param {{ forNetwork?: string|null }} [o] — сеть собеседника (CIDR). Узлы, которых
   *   он и сам слышит в этой сети, ему не пересказываем; об остальных, слышных
   *   нам в других наших сетях, — рассказываем: так узел с несколькими
   *   интерфейсами становится шлюзом без всяких настроек.
   */
  directoryEntries(realm, { forNetwork = null } = {}) {
    const out = [];
    for (const p of this.peers.values()) {
      if (!SHAREABLE.has(p.origin)) continue;
      if (!p.online) continue;
      if (forNetwork) {
        const local = [...p.routes.values()].filter((r) => r.kind === 'direct' && r.heardOn);
        if (p.origin === 'local' && (!local.length || local.some((r) => r.heardOn === forNetwork))) continue;
      }
      // Только свой круг доверия. Обмен идёт внутри одной сети, и
      // рассказывать мосту из «Лаборатории» об узлах «Цеха» значило бы
      // склеить обратно то, что ключи разделяют.
      if (p.realm !== realm) continue;
      const via = forNetwork && p.origin === 'local'
        ? [...p.routes.values()].find((r) => r.kind === 'direct' && r.heardOn && r.heardOn !== forNetwork) : null;
      out.push({
        nodeId: p.nodeId,
        name: p.name,
        address: via?.address || p.address,
        apiPort: via?.apiPort || p.apiPort,
        usbipPort: via?.usbipPort || p.usbipPort,
        trafficPort: via?.trafficPort ?? p.trafficPort,
        netLinkPort: via?.netLinkPort ?? p.netLinkPort,
        network: via?.network || p.network,
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

  /**
   * Забыть узлы из кругов доверия, в которых мы больше не состоим.
   *
   * Ключ убрали из настроек — значит, его узлы нам больше не свои. Ждать,
   * пока они отвалятся по таймауту, нельзя: минуту после снятия ключа их
   * устройства оставались бы в каталоге, и попытка занять такое устройство
   * упиралась бы в неверную подпись без внятного объяснения.
   */
  retainRealms(realms) {
    const keep = new Set(realms);
    let dropped = 0;
    for (const [id, peer] of this.peers) {
      if (keep.has(peer.realm)) continue;
      this.peers.delete(id);
      this.emit('peer-down', peer);
      dropped++;
    }
    if (dropped) {
      log.info(`забыты узлы из кругов доверия, которых у нас больше нет: ${dropped}`);
      this.emit('changed');
    }
    return dropped;
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
      for (const r of p.routes.values()) if (r.address === ip) return true;
    }
    return false;
  }

  // ------------------------------------------------------------- маршруты

  _routeKey(r) {
    return `${r.address}|${r.via?.nodeId || ''}`;
  }

  /** Добавить или обновить маршрут. @returns {boolean} появился новый или изменился адрес сети. */
  _touchRoute(peer, route, now = Date.now()) {
    const key = this._routeKey(route);
    const old = peer.routes.get(key);
    const next = { ...(old || {}), ...route, key, lastSeen: now, firstSeen: old?.firstSeen || now };
    // Способ добраться (напрямую или туннелем) выясняет проба, а не рассказ.
    if (old && route.mode === null) next.mode = old.mode;
    peer.routes.set(key, next);
    return !old;
  }

  /** Маршрут, по которому сейчас разговариваем с узлом. */
  primaryRoute(peer) {
    return peer.routes.get(peer.routeKey) || [...peer.routes.values()][0] || null;
  }

  /** Маршруты для интерфейса: свежие, с понятными пометками. */
  routesOf(peer) {
    const ttl = (peer.timeoutMs || this.opts.peerTimeoutMs) * ROUTE_TTL_FACTOR;
    const now = Date.now();
    const out = [];
    for (const r of peer.routes.values()) {
      if (now - r.lastSeen > ttl) continue;
      out.push({
        key: r.key,
        address: r.address,
        network: r.network || r.heardOn || null,
        kind: r.kind,
        via: r.via ? { nodeId: r.via.nodeId, name: r.via.name || null } : null,
        // direct — адрес доступен нам напрямую, tunnel — только через шлюз, null — ещё не проверяли.
        mode: r.mode ?? null,
        primary: r.key === peer.routeKey,
      });
    }
    return out.sort((a, b) => Number(b.primary) - Number(a.primary) || String(a.address).localeCompare(String(b.address)));
  }

  /** Убрать маршруты, которые давно никто не подтверждал. */
  _expireRoutes(peer, now) {
    const ttl = (peer.timeoutMs || this.opts.peerTimeoutMs) * ROUTE_TTL_FACTOR;
    for (const [key, r] of peer.routes) {
      if (now - r.lastSeen > ttl && key !== peer.routeKey) peer.routes.delete(key);
    }
  }

  /**
   * Куда подключаться для этого порта узла: прямо или туннелем через шлюз.
   *
   * @param {object} peer
   * @param {number} port — порт узла (его собственный, не туннельный)
   * @param {string} [routeKey] — выбранный маршрут (по умолчанию основной)
   * @returns {Promise<{ host: string, port: number, tunnel: boolean }>}
   */
  async endpoint(peer, port, routeKey = peer.routeKey) {
    const r = peer.routes.get(routeKey) || this.primaryRoute(peer);
    if (!r) return { host: peer.address, port, tunnel: false };
    if (r.mode === 'tunnel' && r.via) {
      const t = await this._openTunnel(peer, r, port);
      return { host: t.host, port: t.port, tunnel: true };
    }
    return { host: r.address, port, tunnel: false };
  }

  /** Порт узла по имени: свой у каждого маршрута, с запасными значениями для старых версий. */
  portOf(peer, name, routeKey = peer.routeKey) {
    const r = peer.routes.get(routeKey) || this.primaryRoute(peer) || {};
    const own = { api: 'apiPort', usbip: 'usbipPort', traffic: 'trafficPort', netlink: 'netLinkPort' }[name];
    const fallback = { api: peer.apiPort, usbip: peer.usbipPort, traffic: DEFAULT_TRAFFIC_PORT, netlink: DEFAULT_NETLINK_PORT }[name];
    return r[own] || peer[own] || fallback;
  }

  async _openTunnel(peer, route, port) {
    const cacheKey = `${route.via.nodeId}|${route.address}|${port}`;
    const hit = this.tunnelCache.get(cacheKey);
    if (hit && hit.until > Date.now()) return hit;
    const gateway = this.peers.get(route.via.nodeId);
    const gwHost = gateway?.address || route.via.address;
    const gwPort = gateway?.apiPort || route.via.apiPort;
    if (!gwHost || !gwPort) throw new Error(`шлюз «${route.via.name || route.via.nodeId}» неизвестен — туннель не открыть`);
    const res = await rpc({
      host: gwHost,
      port: gwPort,
      path: '/api/v1/peer/tunnel',
      method: 'POST',
      body: { nodeId: peer.nodeId, address: route.address, port },
      key: this.opts.realms.keyFor(peer.realm),
      nodeId: this.opts.nodeId,
      timeoutMs: 6000,
    });
    const t = { host: gwHost, port: res.port, until: Date.now() + 5 * 60 * 1000 };
    this.tunnelCache.set(cacheKey, t);
    return t;
  }

  /**
   * Выяснить, как добираться по маршруту: напрямую или только через шлюз.
   * Сначала прямой ping (быстрый), потом, если не вышло и есть шлюз, — через
   * туннель. Результат — в route.mode; null — не достучались никак.
   */
  async probeRoute(peer, route) {
    const key = this.opts.realms.keyFor(peer.realm);
    const ping = (host, port, timeoutMs) => rpc({ host, port, path: '/api/v1/peer/ping', key, nodeId: this.opts.nodeId, timeoutMs });
    try {
      await ping(route.address, route.apiPort, 2500);
      route.mode = 'direct';
    } catch {
      route.mode = null;
      if (route.via) {
        try {
          const t = await this._openTunnel(peer, route, route.apiPort);
          await ping(t.host, t.port, 4000);
          route.mode = 'tunnel';
        } catch (e) {
          route.probeError = e.message;
        }
      }
    }
    if (route.mode) route.lastSeen = Date.now();
    return route.mode;
  }

  /**
   * Отпечаток того, что мы расскажем собеседнику в сети forNetwork: слышные
   * нам в других сетях узлы. Меняется — соседи заберут каталог заново.
   */
  gatewayShape(forNetwork) {
    const parts = [];
    for (const p of this.peers.values()) {
      if (p.origin !== 'local' || !p.online) continue;
      const local = [...p.routes.values()].filter((r) => r.kind === 'direct' && r.heardOn);
      if (!local.length || local.some((r) => r.heardOn === forNetwork)) continue;
      parts.push(`${p.nodeId}@${p.stateHash || '-'}@${local[0].address}`);
    }
    return parts.sort().join(';');
  }

  async refreshPeerState(peer, expectedHash) {
    if (this.inflight.has(peer.nodeId)) return;
    this.inflight.add(peer.nodeId);
    try {
      // Пересказанный узел: сначала выясняем, как до него добраться, — иначе
      // первый запрос состояния уходил бы напрямую в никуда.
      const main = this.primaryRoute(peer);
      if (main && main.kind !== 'direct' && !main.mode) await this.probeRoute(peer, main);
      const ep = await this.endpoint(peer, peer.apiPort);
      const state = await rpc({
        host: ep.host,
        port: ep.port,
        path: '/api/v1/peer/state',
        key: this.opts.realms.keyFor(peer.realm),
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
      this._expireRoutes(peer, now);
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
        // Шлюза больше нет — кэшированные туннели через него ведут в никуда.
        for (const [k, t] of this.tunnelCache) {
          if (t.host === peer.address || t.host === peer.routes?.get(peer.routeKey)?.address) this.tunnelCache.delete(k);
        }
      }
    }
    // Просроченные записи кэша туннелей чистим, а не только пропускаем при чтении.
    for (const [k, t] of this.tunnelCache) if (t.until <= now) this.tunnelCache.delete(k);
    if (changed) this.emit('changed');
  }

  get(nodeId) {
    return this.peers.get(nodeId);
  }

  list() {
    return [...this.peers.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
}
