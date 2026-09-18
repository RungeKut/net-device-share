// Реестр узлов сети и их состояний.
//
// Анонс по UDP несёт только stateHash. Полное состояние (список устройств)
// подтягивается по HTTP и только когда хеш изменился — сеть на 20 узлов
// с постоянными анонсами не превращается в поток трафика.

import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { rpc } from '../net/rpc.js';

const log = logger('peers');

export class PeerRegistry extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    /** @type {Map<string, object>} nodeId → peer */
    this.peers = new Map();
    this.sweepTimer = null;
    this.inflight = new Set();
  }

  start() {
    this.sweepTimer = setInterval(() => this._sweep(), 2000);
    this.sweepTimer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.sweepTimer);
  }

  /** Обработка анонса. Тянет состояние, если хеш разошёлся с известным. */
  onAnnounce(msg) {
    const existing = this.peers.get(msg.nodeId);
    const now = Date.now();

    const peer = existing || {
      nodeId: msg.nodeId,
      devices: [],
      groups: [],
      requests: [],
      stateHash: null,
      firstSeen: now,
    };

    const renamed = existing && existing.name !== msg.name;
    const moved = existing && existing.address !== msg.address;
    const wasOffline = existing ? !existing.online : false;

    Object.assign(peer, {
      name: msg.name,
      address: msg.address,
      apiPort: msg.apiPort,
      usbipPort: msg.usbipPort,
      platform: msg.platform,
      version: msg.version,
      startedAt: msg.startedAt,
      deviceCount: msg.deviceCount,
      busyCount: msg.busyCount,
      lastSeen: now,
      online: true,
      self: false,
    });

    this.peers.set(msg.nodeId, peer);

    if (!existing) {
      log.info(`обнаружен узел "${msg.name}" (${msg.address})`);
      this.emit('peer-up', peer);
    } else if (wasOffline) {
      log.info(`узел "${msg.name}" снова в сети`);
      this.emit('peer-up', peer);
    }
    if (renamed) log.info(`узел ${msg.nodeId.slice(0, 8)} переименован в "${msg.name}"`);

    if (peer.stateHash !== msg.stateHash || moved || wasOffline) {
      this.refreshPeerState(peer, msg.stateHash);
    } else {
      this.emit('changed');
    }
  }

  onBye(msg) {
    const peer = this.peers.get(msg.nodeId);
    if (!peer) return;
    log.info(`узел "${peer.name}" покинул сеть`);
    this.peers.delete(msg.nodeId);
    this.emit('peer-down', peer);
    this.emit('changed');
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
      log.warn(`не удалось получить состояние узла "${peer.name}": ${e.message}`);
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
      if (peer.online && silence > this.opts.peerTimeoutMs) {
        peer.online = false;
        changed = true;
        log.warn(`узел "${peer.name}" не отвечает ${Math.round(silence / 1000)} с — помечен офлайн`);
        this.emit('peer-down', peer);
      }
      if (silence > this.opts.peerForgetMs) {
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
