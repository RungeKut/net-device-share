// Обмен каталогом узлов между сетями.
//
// ЗАЧЕМ. Обнаружение по UDP не выходит за пределы подсети: broadcast не
// маршрутизируется, multicast в корпоративных сетях обычно тоже. Поэтому
// узлы из разных сегментов друг друга не видят, хотя маршрут между ними
// есть и данные ходить могут.
//
// КАК. В настройках указывается адрес узла из другой сети — «известный
// узел». Мы периодически обмениваемся с ним каталогом: отдаём список тех,
// кого знаем сами, забираем его список. После этого оба становятся мостами
// и рассказывают о чужих узлах своим соседям по подсети — те забирают
// каталог по HTTP, увидев в анонсе непустой отпечаток (поле dir).
//
// Достаточно настроить ОДНУ сторону: обмен двусторонний, и вторая узнаёт о
// первой из того же запроса.
//
// ЧЕГО ЗДЕСЬ НЕТ. Через мост не идут ни списки устройств, ни занятие, ни
// тем более данные USB/IP. В каталоге только «кто есть и по какому адресу»;
// всё остальное каждый узел спрашивает у владельца напрямую. Мост знакомит
// и на этом заканчивает — нагрузка на него не зависит от числа устройств.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { rpc } from '../net/rpc.js';

const log = logger('directory');

/** Обмен с узлом из другой сети: маршрут длиннее, ждём дольше обычного. */
const SEED_TIMEOUT_MS = 6000;
/** Сосед по подсети отвечает быстро; если нет — он и не мост. */
const LOCAL_TIMEOUT_MS = 4000;
/** Пауза перед забором каталога у соседа: анонсы приходят пачками. */
const PULL_DEBOUNCE_MS = 700;

/**
 * Разбор строки адреса: «10.1.0.5», «10.1.0.5:47812», «stend-2.local»,
 * «[fe80::1]:47812».
 *
 * Набор допустимых символов проверяется строго. Свободная форма выглядела
 * безобидно ровно до первой опечатки: пробел или кириллица уезжали в
 * заголовок Host и роняли запрос изнутри, вместо того чтобы быть
 * отвергнутыми при вводе с понятным текстом.
 *
 * @returns {{host: string, port: number}|null}
 */
export function parseSeed(raw, defaultPort) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const m = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/.exec(text)   // [IPv6]:порт
    || /^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(text);
  if (!m) return null;

  const host = m[1];
  if (host.length > 253) return null;
  const port = m[2] === undefined ? defaultPort : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export class DirectoryService extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => string[]} opts.seeds        адреса узлов в других сетях
   * @param {() => object} opts.selfEntry      запись о нас самих
   * @param {import('./peers.js').PeerRegistry} opts.peers
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.peers = opts.peers;
    this.timer = null;
    this.stopped = false;
    /** @type {Map<string, object>} адрес → как прошёл последний обмен */
    this.seedState = new Map();
    /** @type {Map<string, string>} nodeId соседа → отпечаток его каталога */
    this.pulled = new Map();
    this.pullTimers = new Map();
    this.lastRound = null;
  }

  get enabled() {
    return this._seedList().length > 0;
  }

  /**
   * Общий ключ обязателен, когда работа выходит за пределы своей подсети.
   *
   * Внутри подсети границу доверия держит проверка адреса: чужой должен
   * сначала оказаться в той же сети. Как только появляются узлы из других
   * сегментов, эта граница исчезает, и остаётся только подпись. Без ключа
   * подпись не проверяется вовсе — то есть управление устройствами было бы
   * открыто всем, до кого дотянется маршрут.
   */
  get blocked() {
    return this.enabled && !this.opts.key();
  }

  _seedList() {
    const raw = this.opts.seeds() || [];
    return raw.map((s) => String(s || '').trim()).filter(Boolean);
  }

  start() {
    this.stopped = false;
    if (this.blocked) {
      log.error('указаны узлы из других сетей, но не задан общий ключ — обмен каталогом выключен');
      log.error('задайте общий ключ в настройках: без него удалённые узлы работать не будут');
      return this;
    }
    if (!this.enabled) {
      log.debug('узлы из других сетей не указаны — обмен каталогом не нужен');
      return this;
    }
    log.info(`обмен каталогом включён: ${this._seedList().length} адрес(ов), раз в ${Math.round(this.opts.intervalMs() / 1000)} с`);
    this._round();
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const t of this.pullTimers.values()) clearTimeout(t);
    this.pullTimers.clear();
  }

  /** Отпечаток каталога: соседи по нему понимают, что у нас есть новое. */
  hash() {
    const shared = this.peers.bridged();
    if (!shared.length) return null;
    const shape = shared
      .map((p) => `${p.nodeId}@${p.stateHash || '-'}`)
      .sort()
      .join(';');
    return crypto.createHash('sha1').update(shape).digest('hex').slice(0, 12);
  }

  /** Что мы отдаём собеседнику: мы сами плюс те, о ком вправе рассказывать. */
  payload() {
    return {
      nodeId: this.opts.selfEntry().nodeId,
      name: this.opts.selfEntry().name,
      network: this.opts.selfEntry().network,
      ts: Date.now(),
      peers: [this.opts.selfEntry(), ...this.peers.directoryEntries()],
    };
  }

  /**
   * Анонс соседа по подсети. Непустой dir — у него есть узлы из других
   * сетей; забираем каталог, но только когда отпечаток изменился.
   */
  onAnnounce(msg) {
    if (this.stopped || !msg?.dir) return;
    if (this.pulled.get(msg.nodeId) === msg.dir) return;
    if (this.pullTimers.has(msg.nodeId)) return;

    const t = setTimeout(() => {
      this.pullTimers.delete(msg.nodeId);
      this._pullLocal(msg.nodeId).catch((e) => log.debug(`забор каталога: ${e.message}`));
    }, PULL_DEBOUNCE_MS);
    t.unref?.();
    this.pullTimers.set(msg.nodeId, t);
  }

  /** Забор каталога у соседа-моста в своей подсети: только чтение. */
  async _pullLocal(nodeId) {
    const peer = this.peers.get(nodeId);
    if (!peer || peer.origin !== 'local') return;

    try {
      const res = await rpc({
        host: peer.address,
        port: peer.apiPort,
        path: '/api/v1/peer/directory',
        key: this.opts.key(),
        nodeId: this.opts.selfEntry().nodeId,
        timeoutMs: LOCAL_TIMEOUT_MS,
      });
      const added = this.peers.onDirectory(res?.peers, {
        origin: 'relay',
        viaNodeId: peer.nodeId,
        viaName: peer.name,
      });
      this.pulled.set(nodeId, peer.dir);
      if (added) log.info(`от соседа "${peer.name}" получены узлы из других сетей: ${added}`);
    } catch (e) {
      log.warn(`каталог у соседа "${peer.name}" не забран: ${e.message}`);
    }
  }

  async _round() {
    if (this.stopped) return;
    const seeds = this._seedList();
    const defaultPort = this.opts.defaultPort();
    const selfId = this.opts.selfEntry().nodeId;
    const results = [];

    for (const raw of seeds) {
      const parsed = parseSeed(raw, defaultPort);
      if (!parsed) {
        this.seedState.set(raw, { address: raw, ok: false, error: 'адрес не разобран', at: Date.now() });
        log.warn(`адрес "${raw}" не разобран — ожидается «хост» или «хост:порт»`);
        continue;
      }
      results.push(this._exchange(raw, parsed, selfId));
    }

    await Promise.allSettled(results);
    this.lastRound = Date.now();
    this.emit('changed');

    if (this.stopped) return;
    this.timer = setTimeout(() => this._round(), this.opts.intervalMs());
    this.timer.unref?.();
  }

  /** Двусторонний обмен: отдаём свой каталог, забираем чужой одним запросом. */
  async _exchange(raw, { host, port }, selfId) {
    try {
      const res = await rpc({
        host,
        port,
        path: '/api/v1/peer/directory',
        method: 'POST',
        body: this.payload(),
        key: this.opts.key(),
        nodeId: selfId,
        timeoutMs: SEED_TIMEOUT_MS,
      });

      if (res?.nodeId === selfId) {
        this.seedState.set(raw, { address: raw, ok: false, error: 'это адрес самого себя', at: Date.now() });
        log.warn(`адрес ${raw} указывает на этот же узел — пропускаем`);
        return;
      }

      const added = this.peers.onDirectory(res?.peers, {
        origin: 'seed',
        viaNodeId: res?.nodeId || null,
        viaName: res?.name || raw,
      });

      this.seedState.set(raw, {
        address: raw,
        ok: true,
        error: null,
        at: Date.now(),
        nodeId: res?.nodeId || null,
        name: res?.name || null,
        network: res?.network || null,
        received: Array.isArray(res?.peers) ? res.peers.length : 0,
      });
      if (added) log.info(`обмен с ${raw} ("${res?.name || '?'}"): новых или изменившихся узлов ${added}`);
      else log.debug(`обмен с ${raw}: изменений нет`);
    } catch (e) {
      const prev = this.seedState.get(raw);
      this.seedState.set(raw, { address: raw, ok: false, error: e.message, at: Date.now(), nodeId: prev?.nodeId || null, name: prev?.name || null });
      // Первую неудачу показываем громко, повторные — тихо: недоступный
      // адрес не должен забивать журнал каждые двадцать секунд.
      if (prev?.ok !== false) log.warn(`обмен с ${raw} не удался: ${e.message}`);
      else log.debug(`обмен с ${raw} не удался: ${e.message}`);
    }
  }

  stats() {
    return {
      enabled: this.enabled,
      blocked: this.blocked,
      intervalMs: this.opts.intervalMs(),
      lastRound: this.lastRound,
      hash: this.hash(),
      seeds: this._seedList().map((s) => this.seedState.get(s) || { address: s, ok: null, error: null, at: null }),
      remoteCount: this.peers.bridged().length,
    };
  }
}
