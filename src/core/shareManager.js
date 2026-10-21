// Локальные устройства: публикация, занятость, группы и запросы.
//
// Ключевое архитектурное решение прежнее: решение о занятости принимает
// ВЛАДЕЛЕЦ устройства и никто больше. Поэтому здесь нет ни выборов лидера,
// ни кворума — спорное состояние существует ровно в одном месте.
//
// Что добавилось к простой модели «одно устройство — одна аренда»:
//
//   Группы. Для отладки платы нужны JTAG и COM одновременно; занимать их
//   по отдельности бессмысленно — между захватами первого и второго
//   вклинится кто-то третий, и оба окажутся бесполезны. Поэтому группа
//   захватывается атомарно: либо все её устройства, либо ни одного.
//
//   Запросы. Занятое устройство больше не тупик: у того, кто им занят,
//   можно попросить его освободить. Решает держатель, а не проситель.
//
//   Право владельца. Владелец забирает своё устройство без спроса. Это не
//   грубость, а признание факта: оборудование стоит у него на столе.

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { logger } from '../log.js';
import { BIND_STATE, CLAIM_MODE, stateHash } from '../net/protocol.js';
import { typeInfo } from '../devices/types.js';

const log = logger('share');

/** Сколько цель держится за просителем после согласия держателя. */
const RESERVATION_MS = 45000;
/** Сколько живёт запрос без ответа. */
const REQUEST_TTL_MS = 180000;

export class ShareManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('../devices/hub.js').DeviceHub} o.hub
   * @param {import('../config.js').Config} o.config
   * @param {() => number} [o.dataPort] — порт, который сообщается клиентам для
   *   данных USB/IP. Отличается от usbipPort, когда включён счётчик трафика.
   * @param {(deviceId: string) => object|null} [o.trafficOf] — счётчики устройства
   */
  constructor({ hub, config, dataPort, trafficOf, trafficBegin, dropData, dataConnections }) {
    super();
    this.hub = hub;
    this.config = config;
    this.dataPort = dataPort || (() => config.get('usbipPort'));
    this.trafficOf = trafficOf || (() => null);
    this.trafficBegin = trafficBegin || (() => {});
    // Оборвать соединения данных устройства (счётчик трафика стоит в разрыве
    // и умеет это). Вызывается при освобождении: см. release().
    this.dropData = dropData || (() => 0);
    // Сколько соединений данных у устройства сейчас (0, если счётчик не работает).
    this.dataConnections = dataConnections || (() => 0);
    /** @type {Map<string, NodeJS.Timeout>} deviceId → таймер «соединение закрылось, а аренда осталась» */
    this.dataTimers = new Map();
    /** @type {Map<string, object>} deviceId → устройство */
    this.devices = new Map();
    /** @type {Map<string, object>} deviceId → аренда */
    this.claims = new Map();
    /** @type {Map<string, object>} deviceId → бронь после согласия держателя */
    this.reservations = new Map();
    /**
     * Подключения «в мост»: сетевую карту владельца в общий мост могут
     * включить несколько узлов сразу, и это не занятие — карта остаётся
     * свободной для следующих. deviceId → Map(holderId → подключение).
     */
    this.joins = new Map();
    /** Подключения одной карты идут по очереди: мост собирается один раз. */
    this.joinChains = new Map();
    /** @type {Map<string, object>} requestId → запрос */
    this.requests = new Map();
    /**
     * Устройства, которые прямо сейчас готовятся к выдаче. Подготовка
     * сетевой карты — это сборка моста, секунды; без этой отметки второй
     * узел успел бы пройти проверку занятости за это время.
     */
    this.preparing = new Set();
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

    this.sweepTimer = setInterval(() => this._sweep(), 2000);
    this.sweepTimer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.pollTimer);
    clearInterval(this.sweepTimer);
    for (const t of this.dataTimers.values()) clearTimeout(t);
    this.dataTimers.clear();
  }

  // ------------------------------------------------------------- устройства

  async refresh() {
    // Время фиксируется ДО опроса: список собирается не мгновенно, и всё,
    // что изменилось за время сборки, свежее полученного снимка.
    const startedAt = Date.now();
    const list = await this.hub.listLocal();
    const now = Date.now();
    const seen = new Set();

    for (const raw of list) {
      seen.add(raw.deviceId);
      const prev = this.devices.get(raw.deviceId);
      const shared = this.config.isShared(raw.deviceId);

      // Состояние, выставленное явной операцией уже ПОСЛЕ начала опроса,
      // новее того, что вернул опрос. Без этой проверки освобождение,
      // случившееся во время сборки списка, затиралось устаревшим снимком,
      // и устройство навсегда оставалось «занятым драйвером».
      const fresher = prev?.stateStamp > startedAt;

      // Запись обновляется НА МЕСТЕ, а не заменяется новой: иначе правка
      // состояния уходила бы в объект, уже выброшенный из карты.
      const dev = prev || { firstSeen: now, connectedSince: null, lastError: null };
      Object.assign(dev, raw, {
        shared,
        bindState: fresher ? prev.bindState
          : raw.bound ? BIND_STATE.BOUND
            : (prev?.bindState === BIND_STATE.ERROR ? BIND_STATE.ERROR : BIND_STATE.UNBOUND),
        purpose: this.config.purposeOf(raw.deviceId),
        // Момент появления устройства в системе. Провайдер может знать его
        // точно; иначе считаем от первого наблюдения.
        connectedSince: raw.connectedSince ?? prev?.connectedSince ?? now,
        firstSeen: prev?.firstSeen ?? now,
        sharedSince: shared ? (prev?.sharedSince ?? now) : null,
        lastError: prev?.lastError ?? null,
        lastSeen: now,
      });
      this.devices.set(raw.deviceId, dev);

      if (!prev && this.config.get('autoShareNew') && !shared && !raw.unavailableReason) {
        log.info(`новое устройство ${raw.deviceId} опубликовано автоматически`);
        this.setShared(raw.deviceId, true).catch((e) => log.warn(e.message));
      }
    }

    // Пропавшие устройства: снимаем занятость — держать аренду на то, чего
    // физически нет, бессмысленно и мешает остальным.
    for (const [id, dev] of this.devices) {
      if (seen.has(id)) continue;
      this.devices.delete(id);
      if (this.claims.has(id)) {
        const claim = this.claims.get(id);
        this.claims.delete(id);
        log.warn(`устройство ${id} исчезло, занятость узла "${claim.holderName}" снята`);
        this.emit('claim-revoked', { deviceId: id, claim, reason: 'device_gone' });
      }
      for (const join of this._joinsOf(id).values()) {
        log.warn(`устройство ${id} исчезло, подключение узла "${join.holderName}" снято`);
        this.emit('claim-revoked', { deviceId: id, claim: join, reason: 'device_gone' });
      }
      this.joins.delete(id);
      this.reservations.delete(id);
      // Отданная сетевая карта пропала (выдернули USB-адаптер) — мост с её
      // TAP-адаптером больше ни к чему, и сам он не разберётся.
      if (dev.type === 'net') this.hub.unbind(dev).catch((e) => log.warn(e.message));
      log.info(`устройство ${id} (${dev.description}) больше не доступно`);
    }

    this._emitIfChanged();
  }

  get(deviceId) {
    return this.devices.get(deviceId);
  }

  async setShared(deviceId, shared) {
    const dev = this.devices.get(deviceId);
    if (!dev) throw errWith('device_not_found', `устройство ${deviceId} не найдено`);
    if (dev.unavailableReason) throw errWith('unavailable', dev.unavailableReason);

    if (!shared && this._held(deviceId)) {
      throw errWith('busy', 'устройство сейчас занято — сначала освободите его');
    }
    if (!shared) {
      const group = this.publishedGroupOf(deviceId);
      if (group) {
        throw errWith('in_group', `устройство отдано группой «${group.name}» — снимите с публикации саму группу`);
      }
    }

    this.config.setShared(deviceId, shared);
    dev.shared = shared;
    dev.sharedSince = shared ? Date.now() : null;

    if (!shared && dev.bindState === BIND_STATE.BOUND) {
      try {
        await this.hub.unbind(dev);
        dev.bindState = BIND_STATE.UNBOUND;
        dev.stateStamp = Date.now();
        dev.lastError = null;
      } catch (e) {
        log.warn(`возврат ${deviceId} системе не удался: ${e.message}`);
        dev.bindState = BIND_STATE.ERROR;
        dev.stateStamp = Date.now();
        dev.lastError = e.message;
      }
    }

    log.info(`устройство ${deviceId} ${shared ? 'опубликовано' : 'снято с публикации'}`);
    this._emitIfChanged(true);
    return this.toDto(dev);
  }

  /** Пользовательское описание: что это и для чего используется. */
  setPurpose(deviceId, text) {
    this.config.setPurpose(deviceId, text);
    const dev = this.devices.get(deviceId);
    if (dev) dev.purpose = this.config.purposeOf(deviceId);
    this._emitIfChanged(true);
    return { ok: true };
  }

  // ----------------------------------------------------------------- группы

  groups() {
    return this.config.get('groups') || [];
  }

  groupOf(deviceId) {
    return this.groups().find((g) => g.members.includes(deviceId)) || null;
  }

  /**
   * Группа, которая СЕЙЧАС распоряжается устройством.
   *
   * Пока группа не опубликована, она существует только как заготовка у
   * владельца: её устройства живут своей жизнью — публикуются и занимаются
   * по отдельности. Ограничения включаются вместе с публикацией группы.
   */
  publishedGroupOf(deviceId) {
    const g = this.groupOf(deviceId);
    return g && g.shared ? g : null;
  }

  publishedGroups() {
    return this.groups().filter((g) => g.shared);
  }

  /** Публикация группы целиком. */
  setGroupShared(groupId, shared) {
    const group = this.groups().find((g) => g.id === groupId);
    if (!group) throw errWith('not_found', 'группа не найдена');
    if (!shared && group.members.some((m) => this._held(m))) {
      throw errWith('busy', 'группа сейчас занята — сначала освободите её');
    }
    const groups = this.groups().map((g) => (g.id === groupId ? { ...g, shared: Boolean(shared) } : g));
    this.config.set({ groups });
    log.info(`группа «${group.name}» ${shared ? 'опубликована' : 'снята с публикации'}`);
    this._emitIfChanged(true);
    return { ...group, shared: Boolean(shared) };
  }

  saveGroup({ id, name, description, members }) {
    const clean = (members || []).filter((m) => this.devices.has(m));
    if (clean.length < 1) throw errWith('bad_request', 'в группе должно быть хотя бы одно устройство');

    const groupId = id || `g_${crypto.randomUUID().slice(0, 8)}`;
    const others = this.groups().filter((g) => g.id !== groupId);

    // Устройство состоит не более чем в одной группе: иначе «занять группу»
    // перестаёт быть однозначной операцией.
    for (const g of others) {
      const overlap = g.members.filter((m) => clean.includes(m));
      if (overlap.length) {
        throw errWith('conflict', `устройства уже состоят в группе «${g.name}»: ${overlap.join(', ')}`);
      }
    }
    for (const m of clean) {
      if (this._held(m)) throw errWith('busy', 'нельзя менять состав, пока устройства группы заняты');
    }

    const existing = this.groups().find((g) => g.id === groupId);
    const group = {
      id: groupId,
      name: String(name || '').trim().slice(0, 80) || 'Группа',
      description: String(description || '').trim().slice(0, 500),
      members: clean,
      // Новая группа сразу опубликована: её и создают ради того, чтобы
      // занимали из сети. Снять публикацию можно отдельной кнопкой — тогда
      // устройства снова заживут по отдельности.
      shared: existing ? Boolean(existing.shared) : true,
    };
    this.config.set({ groups: [...others, group] });

    log.info(`группа «${group.name}» сохранена: ${clean.length} устройств`);
    this._emitIfChanged(true);
    return group;
  }

  deleteGroup(groupId) {
    const group = this.groups().find((g) => g.id === groupId);
    if (!group) throw errWith('not_found', 'группа не найдена');
    if (group.members.some((m) => this._held(m))) {
      throw errWith('busy', 'группа сейчас занята — сначала освободите её');
    }
    this.config.set({ groups: this.groups().filter((g) => g.id !== groupId) });
    log.info(`группа «${group.name}» удалена`);
    this._emitIfChanged(true);
    return { ok: true };
  }

  // -------------------------------------------------------------- занятость

  /**
   * Разбирает цель: одиночное устройство или группа.
   * @param {string} target — deviceId либо "group:<id>"
   */
  _resolve(target) {
    if (String(target).startsWith('group:')) {
      const id = String(target).slice(6);
      const group = this.groups().find((g) => g.id === id);
      if (!group) throw errWith('not_found', 'группа не найдена');
      const devices = group.members.map((m) => this.devices.get(m)).filter(Boolean);
      if (devices.length !== group.members.length) {
        throw errWith('device_not_found', 'не все устройства группы сейчас доступны');
      }
      return { kind: 'group', id: target, group, devices };
    }
    const dev = this.devices.get(target);
    if (!dev) throw errWith('device_not_found', `устройство ${target} не найдено`);
    const group = this.publishedGroupOf(target);
    if (group) {
      throw errWith('in_group', `устройство входит в группу «${group.name}» — занимайте группу целиком`);
    }
    return { kind: 'device', id: target, group: null, devices: [dev] };
  }

  /**
   * Занять устройство или группу.
   * @param {object} who { holderId, holderName, force, holderAddress }
   *   force разрешён только владельцу — это его право забрать своё
   *   оборудование без спроса. holderAddress — откуда пришёл вызов: канал
   *   сетевой карты пускает только с него.
   */
  async claim(target, { holderId, holderName, force = false, holderAddress = null }) {
    const { kind, group, devices } = this._resolve(target);
    const busyPreparing = devices.find((d) => this.preparing.has(d.deviceId));
    if (busyPreparing) {
      throw errWith('busy', `${busyPreparing.title} прямо сейчас занимается — попробуйте через несколько секунд`);
    }
    for (const d of devices) this.preparing.add(d.deviceId);
    // Каталог сразу видит «готовится»: и владелец у себя, и соседи — иначе
    // до конца сборки моста карта выглядела бы свободной.
    this._emitIfChanged(true);
    try {
      return await this._claim(target, { kind, group, devices }, { holderId, holderName, force, holderAddress });
    } finally {
      for (const d of devices) this.preparing.delete(d.deviceId);
      this._emitIfChanged(true);
    }
  }

  async _claim(target, { kind, group, devices }, { holderId, holderName, force, holderAddress }) {
    const isOwner = holderId === this.config.get('nodeId');
    const preempt = force && isOwner;

    if (kind === 'group') {
      if (!group.shared) throw errWith('not_shared', `группа «${group.name}» не опубликована`);
    } else {
      for (const dev of devices) {
        if (!dev.shared) throw errWith('not_shared', `устройство ${dev.title} не опубликовано`);
      }
    }
    // Проверяем ВСЕ устройства до того, как трогать хоть одно: группа
    // занимается целиком или не занимается вовсе.
    const blocking = [];
    for (const dev of devices) {
      const existing = this.claims.get(dev.deviceId);
      if (existing && existing.holderId !== holderId && !preempt) {
        blocking.push({ dev, claim: existing });
        continue;
      }
      const joined = [...this._joinsOf(dev.deviceId).values()].filter((j) => j.holderId !== holderId);
      if (joined.length && !preempt) {
        blocking.push({ dev, joined });
        continue;
      }
      const reserved = this.reservations.get(dev.deviceId);
      if (reserved && reserved.nodeId !== holderId && reserved.until > Date.now() && !preempt) {
        blocking.push({ dev, reserved });
      }
    }
    if (blocking.length) {
      const first = blocking[0];
      const who = first.claim ? first.claim.holderName
        : first.joined ? first.joined.map((j) => j.holderName).join(', ')
        : first.reserved.nodeName;
      throw errWith('busy',
        kind === 'group'
          ? `группа занята: ${first.dev.title} — у узла "${who}"`
          : first.joined ? `в мост карты подключены узлы: ${who} — целиком её занять нельзя, пока они не выйдут`
          : `устройство занято узлом "${who}"`,
        { claim: first.claim ? { ...first.claim } : null, blocking: blocking.map((b) => b.dev.title) });
    }

    // Владелец забирает своё: снимаем чужие аренды перед захватом.
    if (preempt) {
      for (const dev of devices) {
        for (const join of [...this._joinsOf(dev.deviceId).values()]) await this._leave(dev, join.holderId, 'owner_preempt');
        const existing = this.claims.get(dev.deviceId);
        if (existing && existing.holderId !== holderId) {
          this.claims.delete(dev.deviceId);
          log.warn(`владелец забирает ${dev.deviceId} у узла "${existing.holderName}"`);
          this.emit('claim-revoked', { deviceId: dev.deviceId, claim: existing, reason: 'owner_preempt' });
        }
        this.reservations.delete(dev.deviceId);
      }
    }

    // Готовим устройства к работе. Если хоть одно не далось — откатываем всё.
    const prepared = [];
    // Каналы сетевых карт: куда подключаться и с каким пропуском. Уходят
    // только тому, кто занял, — в каталог и анонсы они не попадают.
    const links = [];
    try {
      for (const dev of devices) {
        const r = await this.hub.bind(dev, { holderId, holderAddress });
        if (r?.link) links.push({ deviceId: dev.deviceId, ...r.link });
        dev.bindState = dev.hasTransport ? BIND_STATE.BOUND : BIND_STATE.UNBOUND;
        dev.stateStamp = Date.now();
        dev.lastError = null;
        prepared.push(dev);
      }
    } catch (e) {
      for (const dev of prepared) {
        await this.hub.unbind(dev).catch(() => {});
        dev.bindState = BIND_STATE.UNBOUND;
        dev.stateStamp = Date.now();
      }
      const failed = devices[prepared.length];
      if (failed) { failed.bindState = BIND_STATE.ERROR; failed.lastError = e.message; failed.stateStamp = Date.now(); }
      this._emitIfChanged(true);
      throw errWith('bind_failed', `не удалось подготовить ${failed ? failed.title : 'устройство'}: ${e.message}`);
    }

    const now = Date.now();
    const lease = this.config.get('claimLeaseMs');
    for (const dev of devices) {
      this.claims.set(dev.deviceId, {
        holderId,
        holderName,
        since: now,
        renewedAt: now,
        expiresAt: now + lease,
        mode: isOwner ? CLAIM_MODE.LOCAL : CLAIM_MODE.REMOTE,
        groupId: group ? group.id : null,
      });
      this.reservations.delete(dev.deviceId);
      this.trafficBegin(dev.deviceId);
    }

    this._closeRequestsFor(target, preempt ? 'superseded' : 'granted');

    log.info(`${kind === 'group' ? `группа «${group.name}»` : target} занята узлом "${holderName}"${preempt ? ' (забрал владелец)' : ''}`);
    this._emitIfChanged(true);

    return {
      ok: true,
      target,
      kind,
      usbipPort: this.dataPort(),
      links,
      leaseMs: lease,
      devices: devices.map((d) => this.toDto(d)),
    };
  }

  _joinsOf(deviceId) {
    return this.joins.get(deviceId) || new Map();
  }

  /** Занято ли устройство хоть как-то: занятием или подключением в мост. */
  _held(deviceId) {
    return this.claims.has(deviceId) || this._joinsOf(deviceId).size > 0;
  }

  /**
   * Подключить узел в общий мост сетевой карты. В отличие от claim карта
   * остаётся доступной остальным: подключаться могут все, а целиком занять
   * её можно, только пока в мосту никого нет.
   */
  async join(target, who) {
    const { kind, devices } = this._resolve(target);
    const dev = devices[0];
    if (kind !== 'device' || dev.type !== 'net') throw errWith('not_joinable', 'в мост подключают сетевую карту, а не группу или устройство другого вида');
    if (!dev.shared) throw errWith('not_shared', `устройство ${dev.title} не опубликовано`);
    if (!dev.hasTransport || !dev.meta?.bridgeJoin) {
      throw errWith('not_joinable', dev.meta?.joinNote || 'эту карту в мост подключить нельзя');
    }
    if (who.holderId === this.config.get('nodeId')) {
      throw errWith('not_joinable', 'свою карту в мост подключать незачем: она и так в вашей сети');
    }
    // Мост собирается один раз, дальше подключения идут по очереди.
    const prev = this.joinChains.get(dev.deviceId) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._join(dev, who));
    this.joinChains.set(dev.deviceId, run.catch(() => {}));
    return run;
  }

  async _join(dev, { holderId, holderName, holderAddress = null }) {
    const id = dev.deviceId;
    const taker = this.claims.get(id);
    if (taker) {
      throw errWith('busy', `карта занята целиком узлом "${taker.holderName}" — в мост её сейчас не подключить`, { claim: { ...taker } });
    }
    if (this.preparing.has(id)) throw errWith('busy', `${dev.title} прямо сейчас готовится — попробуйте через несколько секунд`);
    const reserved = this.reservations.get(id);
    if (reserved && reserved.nodeId !== holderId && reserved.until > Date.now()) {
      throw errWith('busy', `карта забронирована узлом "${reserved.nodeName}"`);
    }

    let r;
    try {
      r = await this.hub.bind(dev, { holderId, holderAddress, mode: 'bridge' });
    } catch (e) {
      dev.bindState = BIND_STATE.ERROR;
      dev.lastError = e.message;
      dev.stateStamp = Date.now();
      this._emitIfChanged(true);
      throw errWith('bind_failed', `не удалось подключить в мост ${dev.title}: ${e.message}`);
    }

    const now = Date.now();
    const lease = this.config.get('claimLeaseMs');
    const byHolder = this.joins.get(id) || new Map();
    byHolder.set(holderId, { holderId, holderName, since: byHolder.get(holderId)?.since || now, renewedAt: now, expiresAt: now + lease, mode: CLAIM_MODE.REMOTE });
    this.joins.set(id, byHolder);
    dev.bindState = BIND_STATE.BOUND;
    dev.stateStamp = now;
    dev.lastError = null;
    this.reservations.delete(id);
    this.trafficBegin(id);
    log.info(`${dev.title}: узел "${holderName}" подключён в мост (подключённых: ${byHolder.size})`);
    this._emitIfChanged(true);

    return {
      ok: true,
      target: id,
      kind: 'device',
      mode: 'bridge',
      usbipPort: this.dataPort(),
      links: r?.link ? [{ deviceId: id, ...r.link }] : [],
      leaseMs: lease,
      devices: [this.toDto(dev)],
    };
  }

  /** Снять одно подключение; когда оно последнее, мост разбирается. */
  async _leave(dev, holderId, reason) {
    const byHolder = this.joins.get(dev.deviceId);
    const join = byHolder?.get(holderId);
    if (!join) return;
    byHolder.delete(holderId);
    if (!byHolder.size) this.joins.delete(dev.deviceId);
    const last = !byHolder.size;
    try {
      await this.hub.unbind(dev, { holderId, mode: 'bridge' });
      if (last) {
        dev.bindState = BIND_STATE.UNBOUND;
        dev.stateStamp = Date.now();
        dev.lastError = null;
      }
    } catch (e) {
      log.warn(`отключение ${holderId} от ${dev.deviceId} не удалось: ${e.message}`);
      if (last) { dev.bindState = BIND_STATE.ERROR; dev.stateStamp = Date.now(); dev.lastError = e.message; }
    }
    this.emit('claim-revoked', { deviceId: dev.deviceId, claim: join, reason });
    log.info(`${dev.title}: узел "${join.holderName}" вышел из моста${last ? ', мост разобран' : ''}`);
    this._emitIfChanged(true);
  }

  renew(target, holderId) {
    const { devices } = this._resolve(target);
    const lease = this.config.get('claimLeaseMs');
    let renewed = 0;
    for (const dev of devices) {
      const join = this._joinsOf(dev.deviceId).get(holderId);
      if (join) {
        join.expiresAt = Date.now() + lease;
        join.renewedAt = Date.now();
        renewed++;
        continue;
      }
      const claim = this.claims.get(dev.deviceId);
      if (!claim) continue;
      if (claim.holderId !== holderId) throw errWith('forbidden', 'занято другим узлом');
      claim.expiresAt = Date.now() + lease;
      claim.renewedAt = Date.now();
      claim.silentWarned = false;
      renewed++;
    }
    if (!renewed) throw errWith('no_claim', 'не занято');
    // Ответ на heartbeat — надёжный способ донести до держателя запросы:
    // он приходит регулярно и не требует, чтобы владелец умел достучаться
    // до клиента сам.
    return {
      ok: true,
      expiresAt: Date.now() + lease,
      pendingRequests: this.requestsFor(holderId),
      // Клиент видит скорость своими глазами: владелец измеряет, а ответ
      // на heartbeat и так приходит каждые десять секунд.
      traffic: devices.map((d) => ({ deviceId: d.deviceId, ...(this.trafficOf(d.deviceId) || {}) })),
    };
  }

  /**
   * Соединение данных удалённого держателя закрылось, а аренда осталась.
   *
   * Для USB/IP соединение живёт ровно столько, сколько устройство подключено
   * у клиента: закрылось — устройства у него в системе больше нет, что бы ни
   * думало его приложение. Даём время на переподключение (по длине аренды),
   * потом освобождаем — как для сетевой карты, у которой разбирается путь,
   * когда держатель отключился. Если клиент жив, его очередная проверка связи
   * получит «право отозвано», и он сам отцепится и сообщит об этом.
   */
  onDataClosed(deviceId) {
    const claim = this.claims.get(deviceId);
    if (!claim || claim.mode !== CLAIM_MODE.REMOTE) return;
    this.onDataOpened(deviceId);
    const timer = setTimeout(() => {
      this.dataTimers.delete(deviceId);
      if (this.claims.get(deviceId) !== claim) return;      // уже освобождено или занято заново
      if (this.dataConnections(deviceId) > 0) return;       // переподключился
      log.warn(`держатель "${claim.holderName}" отключил ${deviceId}, а аренда осталась — освобождаем`);
      this.release(claim.groupId ? `group:${claim.groupId}` : deviceId, claim.holderId, { force: true })
        .catch((e) => log.error('автоосвобождение не удалось:', e.message));
    }, this.config.get('claimLeaseMs'));
    timer.unref?.();
    this.dataTimers.set(deviceId, timer);
  }

  /** Соединение вернулось (или аренду сняли): таймер больше не нужен. */
  onDataOpened(deviceId) {
    const t = this.dataTimers.get(deviceId);
    if (t) {
      clearTimeout(t);
      this.dataTimers.delete(deviceId);
    }
  }

  async release(target, holderId, { force = false } = {}) {
    let resolved;
    try {
      resolved = this._resolve(target);
    } catch (e) {
      // Устройство могло исчезнуть — освобождать уже нечего.
      if (e.code === 'device_not_found' || e.code === 'not_found') return { ok: true, already: true };
      throw e;
    }

    // Пока устройство возвращается драйверу (unbind идёт секунды), оно не
    // свободно: без этой отметки третий узел занимал его между удалением
    // занятия и концом unbind, а новый bind обгонял старый unbind.
    const held = resolved.devices.filter((d) => !this.preparing.has(d.deviceId));
    for (const d of held) this.preparing.add(d.deviceId);
    try {
      return await this._release(resolved, target, holderId, force);
    } finally {
      for (const d of held) this.preparing.delete(d.deviceId);
    }
  }

  async _release(resolved, target, holderId, force) {
    // Подключение в мост снимается отдельно от занятия: у карты их может
    // быть несколько. Владелец с force снимает все.
    if (resolved.kind === 'device') {
      const dev = resolved.devices[0];
      const joins = this._joinsOf(dev.deviceId);
      if (joins.has(holderId) || (force && joins.size && !this.claims.has(dev.deviceId))) {
        const who = joins.has(holderId) ? [holderId] : [...joins.keys()];
        for (const id of who) await this._leave(dev, id, id === holderId ? 'released' : 'forced');
        return { ok: true, released: who.length };
      }
    }

    let released = 0;
    for (const dev of resolved.devices) {
      const claim = this.claims.get(dev.deviceId);
      if (!claim) continue;
      if (claim.holderId !== holderId && !force) {
        throw errWith('forbidden', `устройство занято узлом "${claim.holderName}"`);
      }
      this.claims.delete(dev.deviceId);
      this.onDataOpened(dev.deviceId);
      released++;

      // Клиент мог пропасть, не закрыв соединение (питание, кабель): с точки
      // зрения TCP оно живо, и usbipd считает устройство подключённым. Рвём
      // его сами - тогда usbipd получает чистое отключение, и устройство
      // освобождается до возврата системе, а не по таймауту через минуты.
      const dropped = this.dropData(dev.deviceId);
      if (dropped) log.info(`${dev.deviceId}: оборвано соединений данных: ${dropped}`);

      try {
        try {
          await this.hub.unbind(dev);
        } catch (first) {
          // Вторая попытка: драйвер мог ещё не успеть увидеть разрыв.
          log.debug(`возврат ${dev.deviceId}: первая попытка не удалась (${first.message}), повторяю`);
          await new Promise((r) => setTimeout(r, 2000));
          await this.hub.unbind(dev);
        }
        dev.bindState = BIND_STATE.UNBOUND;
        dev.stateStamp = Date.now();
        dev.lastError = null;
      } catch (e) {
        // Каталог считает устройство свободным, даже если драйвер не отдал
        // его обратно: иначе сбой заблокировал бы устройство навсегда.
        log.warn(`возврат ${dev.deviceId} системе не удался: ${e.message}`);
        dev.bindState = BIND_STATE.ERROR;
        dev.stateStamp = Date.now();
        dev.lastError = e.message;
      }
      this.emit('claim-revoked', { deviceId: dev.deviceId, claim, reason: force ? 'forced' : 'released' });
    }

    if (released) {
      log.info(`${target} освобождено${force ? ' принудительно' : ''}`);
      this._emitIfChanged(true);
    }
    return { ok: true, released };
  }

  // ---------------------------------------------------------------- запросы

  /** Кто сейчас держит цель (для группы — держатель первого устройства). */
  holderOf(target) {
    const { devices } = this._resolve(target);
    for (const dev of devices) {
      const claim = this.claims.get(dev.deviceId);
      if (claim) return claim;
    }
    return null;
  }

  createRequest({ target, requesterId, requesterName, message }) {
    const { kind, group, devices } = this._resolve(target);
    const holder = this.holderOf(target);
    if (!holder) throw errWith('not_busy', 'цель свободна — занимайте без запроса');
    if (holder.holderId === requesterId) throw errWith('already_yours', 'вы и так держите эту цель');

    const existing = [...this.requests.values()].find(
      (r) => r.target === target && r.requesterId === requesterId && r.state === 'pending');
    if (existing) return { ...existing, duplicate: true };

    const now = Date.now();
    const req = {
      id: `r_${crypto.randomUUID().slice(0, 8)}`,
      target,
      kind,
      title: kind === 'group' ? `группа «${group.name}»` : devices[0].description,
      requesterId,
      requesterName,
      holderId: holder.holderId,
      holderName: holder.holderName,
      message: String(message || '').trim().slice(0, 300),
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      state: 'pending',
      answeredAt: null,
    };
    this.requests.set(req.id, req);
    log.info(`запрос ${req.id}: "${requesterName}" просит ${req.title} у "${holder.holderName}"`);
    this.emit('request-created', req);
    this._emitIfChanged(true);
    return req;
  }

  /** Ответ держателя. Освобождение и бронь за просителем — здесь же. */
  async answerRequest(requestId, holderId, accept) {
    const req = this.requests.get(requestId);
    if (!req) throw errWith('not_found', 'запрос не найден');
    if (req.state !== 'pending') throw errWith('closed', 'на запрос уже ответили');
    if (req.holderId !== holderId) throw errWith('forbidden', 'отвечать может только держатель');

    req.state = accept ? 'accepted' : 'declined';
    req.answeredAt = Date.now();

    if (accept) {
      // Бронь ставится ДО освобождения: release ждёт драйвер секундами, и
      // всё это время цель иначе не была бы закрыта ни занятием, ни бронью.
      let reserved = [];
      try {
        const { devices } = this._resolve(req.target);
        for (const dev of devices) {
          this.reservations.set(dev.deviceId, {
            nodeId: req.requesterId,
            nodeName: req.requesterName,
            until: Date.now() + RESERVATION_MS,
          });
        }
        reserved = devices;
      } catch (e) {
        log.warn(`бронь за "${req.requesterName}" не поставлена: ${e.message}`);
      }
      try {
        await this.release(req.target, holderId, { force: true });
      } catch (e) {
        for (const dev of reserved) this.reservations.delete(dev.deviceId);
        throw e;
      }
      log.info(`запрос ${requestId} удовлетворён, ${req.target} забронировано за "${req.requesterName}"`);
    } else {
      log.info(`запрос ${requestId} отклонён держателем "${req.holderName}"`);
    }

    this.emit('request-answered', req);
    this._emitIfChanged(true);
    return { ...req };
  }

  cancelRequest(requestId, requesterId) {
    const req = this.requests.get(requestId);
    if (!req) return { ok: true, already: true };
    if (req.requesterId !== requesterId) throw errWith('forbidden', 'отменить может только автор запроса');
    req.state = 'cancelled';
    req.answeredAt = Date.now();
    this._emitIfChanged(true);
    return { ok: true };
  }

  /** Запросы, которые должен видеть конкретный узел: свои и адресованные ему. */
  requestsFor(nodeId) {
    return [...this.requests.values()]
      .filter((r) => r.requesterId === nodeId || r.holderId === nodeId)
      .map((r) => ({ ...r }));
  }

  _closeRequestsFor(target, reason) {
    for (const req of this.requests.values()) {
      if (req.target === target && req.state === 'pending') {
        req.state = reason;
        req.answeredAt = Date.now();
      }
    }
  }

  // ------------------------------------------------------------------ прочее

  _sweep() {
    const now = Date.now();
    let changed = false;

    for (const [deviceId, claim] of this.claims) {
      // Держатель молчит: проверка связи идёт каждые 10 с, а тишина дольше половины
      // аренды - это уже не потерянный пакет. Говорим об этом заранее, а не
      // только когда аренда истекла; интерфейс владельца показывает то же.
      const silentFor = now - (claim.renewedAt || claim.since);
      if (claim.mode === CLAIM_MODE.REMOTE && !claim.silentWarned && claim.expiresAt > now
        && silentFor > this.config.get('claimLeaseMs') / 2) {
        claim.silentWarned = true;
        log.warn(`держатель "${claim.holderName}" не отвечает ${Math.round(silentFor / 1000)} с - ${deviceId} освободится через ${Math.max(0, Math.round((claim.expiresAt - now) / 1000))} с, если связь не вернётся`);
        changed = true;
      }
      if (claim.expiresAt > now) continue;
      log.warn(`аренда ${deviceId} узлом "${claim.holderName}" истекла — освобождаем`);
      this.release(claim.groupId ? `group:${claim.groupId}` : deviceId, claim.holderId, { force: true })
        .catch((e) => log.error('автоосвобождение не удалось:', e.message));
    }

    for (const [deviceId, byHolder] of this.joins) {
      for (const join of byHolder.values()) {
        if (join.expiresAt > now) continue;
        log.warn(`подключение ${deviceId} узлом "${join.holderName}" истекло — снимаем`);
        const dev = this.devices.get(deviceId);
        if (dev) this._leave(dev, join.holderId, 'expired').catch((e) => log.error('снятие подключения не удалось:', e.message));
      }
    }

    for (const [deviceId, res] of this.reservations) {
      if (res.until > now) continue;
      this.reservations.delete(deviceId);
      changed = true;
    }

    for (const req of this.requests.values()) {
      if (req.state === 'pending' && req.expiresAt <= now) {
        req.state = 'expired';
        req.answeredAt = now;
        changed = true;
        log.info(`запрос ${req.id} истёк без ответа`);
      }
      // Отвеченные запросы какое-то время видны обеим сторонам, потом убираются.
      if (req.state !== 'pending' && req.answeredAt && now - req.answeredAt > 120000) {
        this.requests.delete(req.id);
        changed = true;
      }
    }

    if (changed) this._emitIfChanged(true);
  }

  toDto(dev) {
    const claim = this.claims.get(dev.deviceId) || null;
    const reserved = this.reservations.get(dev.deviceId) || null;
    const group = this.groupOf(dev.deviceId);
    const info = typeInfo(dev.type);
    return {
      deviceId: dev.deviceId,
      type: dev.type,
      typeTitle: info.title,
      icon: info.icon,
      key: dev.key,
      title: dev.title,
      description: dev.description,
      purpose: dev.purpose || null,
      hasTransport: dev.hasTransport,
      shared: Boolean(dev.shared),
      bindState: dev.bindState,
      joins: [...this._joinsOf(dev.deviceId).values()].map((j) => ({ holderId: j.holderId, holderName: j.holderName, since: j.since })),
      claim: claim ? { ...claim, holderSilentMs: claim.mode === CLAIM_MODE.REMOTE ? Date.now() - (claim.renewedAt || claim.since) : 0, leaseMs: this.config.get('claimLeaseMs') } : null,
      reservedFor: reserved && reserved.until > Date.now() ? { ...reserved } : null,
      groupId: group ? group.id : null,
      groupName: group ? group.name : null,
      // Пока группа не опубликована, устройство живёт своей жизнью;
      // интерфейсу нужно различать эти два состояния.
      groupPublished: Boolean(group && group.shared),
      connectedSince: dev.connectedSince,
      sharedSince: dev.sharedSince,
      unavailableReason: dev.unavailableReason || null,
      lastError: dev.lastError || null,
      // Идёт выдача: для сетевой карты это сборка моста, секунды.
      preparing: this.preparing.has(dev.deviceId),
      traffic: this.trafficOf(dev.deviceId),
      meta: dev.meta || {},
    };
  }

  listAll() {
    return [...this.devices.values()].map((d) => this.toDto(d));
  }

  /**
   * Устройства, видимые соседям: опубликованные поодиночке и все члены
   * опубликованных групп. Член группы может быть не опубликован сам по себе —
   * его отдаёт наружу группа, и без него она была бы неполной.
   */
  listShared() {
    const viaGroup = new Set(this.publishedGroups().flatMap((g) => g.members));
    return [...this.devices.values()]
      .filter((d) => d.shared || viaGroup.has(d.deviceId))
      .map((d) => this.toDto(d));
  }

  /** Группы с подставленным состоянием занятости. */
  listGroups() {
    return this.groups().map((g) => {
      const claims = g.members.map((m) => this.claims.get(m)).filter(Boolean);
      const holder = claims[0] || null;
      const reserved = g.members.map((m) => this.reservations.get(m)).find((r) => r && r.until > Date.now()) || null;
      return {
        id: g.id,
        name: g.name,
        description: g.description || '',
        members: [...g.members],
        shared: Boolean(g.shared),
        available: g.members.every((m) => this.devices.has(m)),
        claim: holder ? { ...holder } : null,
        // Частичная занятость возможна только как след сбоя: в норме
        // все устройства группы заняты вместе.
        partial: claims.length > 0 && claims.length !== g.members.length,
        reservedFor: reserved ? { ...reserved } : null,
        preparing: g.members.some((m) => this.preparing.has(m)),
      };
    });
  }

  hash() {
    // ВАЖНО: точные байты в хеш не входят. Они меняются каждую секунду, и
    // соседи перечитывали бы состояние без остановки. В хеш идёт только
    // признак «есть активность»: переход «молчит ↔ работает» доходит быстро,
    // а сами цифры держатель получает в ответе на heartbeat.
    const devices = this.listShared().map((d) => ({
      ...d,
      traffic: d.traffic && (d.traffic.bytesInPerMinute || d.traffic.bytesOutPerMinute) ? 'active' : null,
    }));
    const groupPart = this.listGroups()
      .map((g) => `${g.id}|${g.name}|${g.description}|${g.shared ? 1 : 0}|${g.members.join(',')}|${g.claim ? g.claim.holderId : '-'}`)
      .join(';');
    const requestPart = [...this.requests.values()]
      .map((r) => `${r.id}:${r.state}`)
      .sort()
      .join(';');
    return stateHash(devices, `${groupPart}#${requestPart}`);
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
