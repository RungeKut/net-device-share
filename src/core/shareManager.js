// Локальные устройства: публикация и занятость.
//
// Ключевое архитектурное решение: решение о занятости принимает ВЛАДЕЛЕЦ
// устройства и никто больше. Поэтому здесь нет ни выборов лидера, ни
// кворума, ни расхождения реплик — состояние устройства существует ровно
// в одном месте, а остальные узлы получают его копию.
//
// Занятость выдаётся как аренда с конечным сроком: если клиент выключили
// из розетки, устройство освободится само, а не останется занятым навсегда.

import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { BIND_STATE, CLAIM_MODE, stateHash } from '../net/protocol.js';

const log = logger('share');

export class ShareManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('../usb/backend.js').UsbBackend} o.backend
   * @param {import('../config.js').Config} o.config
   */
  constructor({ backend, config }) {
    super();
    this.backend = backend;
    this.config = config;
    /** @type {Map<string, object>} busid → устройство */
    this.devices = new Map();
    /** @type {Map<string, object>} busid → аренда */
    this.claims = new Map();
    this.pollTimer = null;
    this.sweepTimer = null;
    this.lastHash = null;
  }

  async start() {
    await this.refresh();
    this.pollTimer = setInterval(() => {
      this.refresh().catch((e) => log.warn('опрос устройств не удался:', e.message));
    }, 4000);
    this.pollTimer.unref?.();

    this.sweepTimer = setInterval(() => this._sweepLeases(), 2000);
    this.sweepTimer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.pollTimer);
    clearInterval(this.sweepTimer);
  }

  /** Перечитывает список устройств, сохраняя накопленные метаданные. */
  async refresh() {
    const list = await this.backend.listLocal();
    const now = Date.now();
    const seen = new Set();

    for (const raw of list) {
      if (!raw.busid) {
        // Устройство без busid показываем справочно: опубликовать нельзя.
        const key = `?${raw.instanceId || raw.description}`;
        seen.add(key);
        this.devices.set(key, {
          ...raw,
          busid: null,
          key,
          shared: false,
          bindState: BIND_STATE.UNBOUND,
          firstSeen: this.devices.get(key)?.firstSeen ?? now,
          lastSeen: now,
        });
        continue;
      }

      seen.add(raw.busid);
      const prev = this.devices.get(raw.busid);
      const shared = this.config.isShared(raw.busid);

      this.devices.set(raw.busid, {
        ...raw,
        key: raw.busid,
        shared,
        bindState: raw.bound ? BIND_STATE.BOUND : BIND_STATE.UNBOUND,
        note: this.config.get('deviceNotes')?.[raw.busid] || null,
        // connectedSince: момент появления устройства в системе. Бэкенд может
        // знать его точно (Linux, mtime в sysfs); иначе берём первое наблюдение.
        connectedSince: raw.connectedSince ?? prev?.connectedSince ?? now,
        firstSeen: prev?.firstSeen ?? now,
        sharedSince: shared ? (prev?.sharedSince ?? now) : null,
        lastSeen: now,
      });

      // Устройство только что подключили и включён автоматический доступ.
      if (!prev && this.config.get('autoShareNew') && !shared) {
        log.info(`новое устройство ${raw.busid} опубликовано автоматически`);
        this.setShared(raw.busid, true).catch((e) => log.warn(e.message));
      }
    }

    // Отключённые устройства убираем и снимаем с них занятость:
    // держать аренду на физически отсутствующее устройство бессмысленно.
    for (const [key, dev] of this.devices) {
      if (seen.has(key)) continue;
      this.devices.delete(key);
      if (this.claims.has(key)) {
        const claim = this.claims.get(key);
        this.claims.delete(key);
        log.warn(`устройство ${key} отключено физически, занятость узла "${claim.holderName}" снята`);
        this.emit('claim-revoked', { busid: key, claim, reason: 'device_unplugged' });
      }
      log.info(`устройство ${key} (${dev.description}) отключено`);
    }

    this._emitIfChanged();
  }

  /** Публикация / снятие публикации устройства. */
  async setShared(busid, shared) {
    const dev = this.devices.get(busid);
    if (!dev) throw new Error(`устройство ${busid} не найдено`);
    if (!dev.busid) throw new Error(dev.unavailableReason || 'устройство нельзя опубликовать');

    if (!shared && this.claims.has(busid)) {
      throw new Error('устройство сейчас занято — сначала освободите его');
    }

    this.config.setShared(busid, shared);
    dev.shared = shared;
    dev.sharedSince = shared ? Date.now() : null;

    if (!shared && dev.bindState === BIND_STATE.BOUND) {
      // Снятие публикации возвращает устройство своей системе.
      try {
        await this.backend.unbind(busid);
        dev.bindState = BIND_STATE.UNBOUND;
      } catch (e) {
        log.warn(`unbind ${busid} не удался: ${e.message}`);
        dev.bindState = BIND_STATE.ERROR;
        dev.lastError = e.message;
      }
    }

    log.info(`устройство ${busid} ${shared ? 'опубликовано' : 'снято с публикации'}`);
    this._emitIfChanged(true);
    return this.toDto(dev);
  }

  setNote(busid, note) {
    const notes = { ...(this.config.get('deviceNotes') || {}) };
    if (note) notes[busid] = String(note).slice(0, 200);
    else delete notes[busid];
    this.config.set({ deviceNotes: notes });
    const dev = this.devices.get(busid);
    if (dev) dev.note = note || null;
    this._emitIfChanged(true);
  }

  /**
   * Занять устройство. Вызывается и локальным UI, и удалёнными узлами
   * через RPC — правила одни и те же.
   */
  async claim(busid, { holderId, holderName }) {
    const dev = this.devices.get(busid);
    if (!dev) {
      throw errWith('device_not_found', `устройство ${busid} не найдено`);
    }
    if (!dev.shared) {
      throw errWith('not_shared', 'устройство не опубликовано владельцем');
    }

    const existing = this.claims.get(busid);
    if (existing && existing.holderId !== holderId) {
      throw errWith('busy', `устройство занято узлом "${existing.holderName}"`, { claim: { ...existing } });
    }
    if (existing && existing.holderId === holderId) {
      // Повторный запрос того же владельца — просто продление аренды.
      existing.expiresAt = Date.now() + this.config.get('claimLeaseMs');
      this._emitIfChanged(true);
      return this._claimResult(dev, existing);
    }

    // Отдаём устройство драйверу-заглушке только в момент занятия:
    // пока никто не работает, оно остаётся доступным своей системе.
    try {
      await this.backend.bind(busid);
      dev.bindState = BIND_STATE.BOUND;
      dev.lastError = null;
    } catch (e) {
      dev.bindState = BIND_STATE.ERROR;
      dev.lastError = e.message;
      this._emitIfChanged(true);
      throw errWith('bind_failed', `не удалось подготовить устройство: ${e.message}`);
    }

    const now = Date.now();
    const claim = {
      holderId,
      holderName,
      since: now,
      expiresAt: now + this.config.get('claimLeaseMs'),
      mode: holderId === this.config.get('nodeId') ? CLAIM_MODE.LOCAL : CLAIM_MODE.REMOTE,
    };
    this.claims.set(busid, claim);

    log.info(`устройство ${busid} занято узлом "${holderName}"${claim.mode === CLAIM_MODE.LOCAL ? ' (собственным)' : ''}`);
    this._emitIfChanged(true);
    return this._claimResult(dev, claim);
  }

  _claimResult(dev, claim) {
    return {
      ok: true,
      busid: dev.busid,
      usbipPort: this.config.get('usbipPort'),
      leaseMs: this.config.get('claimLeaseMs'),
      claim: { ...claim },
      device: this.toDto(dev),
    };
  }

  /** Продление аренды. Клиент шлёт heartbeat, пока устройство ему нужно. */
  renew(busid, holderId) {
    const claim = this.claims.get(busid);
    if (!claim) throw errWith('no_claim', 'устройство не занято');
    if (claim.holderId !== holderId) throw errWith('forbidden', 'устройство занято другим узлом');
    claim.expiresAt = Date.now() + this.config.get('claimLeaseMs');
    return { ok: true, expiresAt: claim.expiresAt };
  }

  /**
   * Освобождение. `force` разрешено только владельцу устройства —
   * это его право отобрать собственное оборудование.
   */
  async release(busid, holderId, { force = false } = {}) {
    const claim = this.claims.get(busid);
    if (!claim) return { ok: true, already: true };
    if (claim.holderId !== holderId && !force) {
      throw errWith('forbidden', `устройство занято узлом "${claim.holderName}"`);
    }

    this.claims.delete(busid);
    const dev = this.devices.get(busid);
    if (dev) {
      try {
        await this.backend.unbind(busid);
        dev.bindState = BIND_STATE.UNBOUND;
        dev.lastError = null;
      } catch (e) {
        // Устройство свободно в каталоге, даже если unbind не прошёл:
        // иначе сбой драйвера заблокировал бы его навсегда.
        log.warn(`unbind ${busid} не удался: ${e.message}`);
        dev.bindState = BIND_STATE.ERROR;
        dev.lastError = e.message;
      }
    }

    log.info(`устройство ${busid} освобождено${force && claim.holderId !== holderId ? ' принудительно владельцем' : ''}`);
    this.emit('claim-revoked', { busid, claim, reason: force ? 'forced' : 'released' });
    this._emitIfChanged(true);
    return { ok: true, forced: force };
  }

  /** Снимает аренды, по которым перестали приходить heartbeat-ы. */
  _sweepLeases() {
    const now = Date.now();
    for (const [busid, claim] of this.claims) {
      if (claim.expiresAt > now) continue;
      log.warn(`аренда устройства ${busid} узлом "${claim.holderName}" истекла — освобождаем`);
      this.release(busid, claim.holderId, { force: true })
        .catch((e) => log.error('автоосвобождение не удалось:', e.message));
    }
  }

  toDto(dev) {
    const claim = dev.busid ? this.claims.get(dev.busid) : null;
    return {
      busid: dev.busid,
      key: dev.key,
      vendorId: dev.vendorId,
      productId: dev.productId,
      description: dev.description,
      serial: dev.serial,
      instanceId: dev.instanceId,
      shared: Boolean(dev.shared),
      bindState: dev.bindState,
      claim: claim ? { ...claim } : null,
      connectedSince: dev.connectedSince,
      sharedSince: dev.sharedSince,
      note: dev.note || null,
      unavailableReason: dev.unavailableReason || null,
      lastError: dev.lastError || null,
    };
  }

  /** Всё, включая непубликуемое — для собственного UI. */
  listAll() {
    return [...this.devices.values()].map((d) => this.toDto(d));
  }

  /** Только опубликованное — это видят другие узлы. */
  listShared() {
    return [...this.devices.values()].filter((d) => d.shared).map((d) => this.toDto(d));
  }

  hash() {
    return stateHash(this.listShared());
  }

  _emitIfChanged(force = false) {
    const h = this.hash();
    if (force || h !== this.lastHash) {
      this.lastHash = h;
      this.emit('changed', h);
    }
  }
}

function errWith(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}
