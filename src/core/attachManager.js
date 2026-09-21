// Занятие чужих (и своих) целей: устройств и групп.
//
// Занятие — это две отдельные вещи, и их важно не путать:
//   1. ПРАВО на цель: аренда у владельца, выдаётся по RPC.
//   2. ФАКТ подключения: usbip attach, после которого устройство
//      появляется в «Диспетчере устройств».
// Право берём первым: откажут — локальный VHCI трогать незачем.
// При освобождении порядок обратный: сначала отцепляем, потом отдаём право.
//
// Целью может быть группа. Тогда право выдаётся на все её устройства сразу
// (владелец гарантирует атомарность), а подключается каждое по отдельности.
// Часть устройств группы может не иметь проброса — они просто бронируются.

import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { rpc, RpcError } from '../net/rpc.js';

const log = logger('attach');

/** Ключ занятия: узел + цель. */
export function attachKey(nodeId, target) {
  return `${nodeId}|${target}`;
}

export class AttachManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('../devices/backend.js').UsbBackend} o.backend
   * @param {import('../config.js').Config} o.config
   * @param {import('./shareManager.js').ShareManager} o.share — для целей этого же узла
   * @param {(nodeId: string) => (string|undefined)} o.keyFor — ключ круга доверия,
   *   в котором услышан этот узел. Кругов у нас может быть несколько, и
   *   подписывать вызов надо тем ключом, который примет именно он.
   */
  constructor({ backend, config, share, keyFor }) {
    super();
    this.backend = backend;
    this.config = config;
    this.share = share;
    this.keyFor = keyFor;
    /** @type {Map<string, object>} attachKey → занятие */
    this.attachments = new Map();
    /** Запросы, где держатель — мы. Приходят в ответах на heartbeat. */
    this.incomingRequests = new Map();
    this.hbTimer = null;
  }

  async start() {
    await this.reconcile();
    this.hbTimer = setInterval(() => {
      this._heartbeatAll().catch((e) => log.warn('цикл heartbeat завершился ошибкой:', e.message));
    }, this.config.get('heartbeatIntervalMs'));
    this.hbTimer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.hbTimer);
  }

  /**
   * Сверка с реальным состоянием VHCI. Нужна после перезапуска приложения:
   * подключения переживают его, и пользователь должен увидеть их в UI,
   * а не потерять управление ими.
   */
  async reconcile() {
    let live = [];
    try {
      live = await this.backend.listAttached();
    } catch (e) {
      log.warn('не удалось прочитать список подключений:', e.message);
      return;
    }

    const seenPorts = new Set();
    for (const rec of this.attachments.values()) {
      for (const part of rec.parts) {
        const match = live.find((a) => a.busid === part.key && a.host === rec.host);
        if (match) {
          part.vhciPort = match.vhciPort;
          seenPorts.add(`${match.host}/${match.busid}`);
        }
      }
    }

    // Подключения, о которых мы ничего не знаем: остались от прошлого запуска
    // или сделаны вручную через usbip. Показываем как «внешние», чтобы
    // пользователь мог их отцепить.
    for (const a of live) {
      const tag = `${a.host}/${a.busid}`;
      if (seenPorts.has(tag)) continue;
      const id = `orphan|${tag}`;
      if (this.attachments.has(id)) continue;
      this.attachments.set(id, {
        id,
        orphan: true,
        nodeId: null,
        nodeName: `${a.host} (вне приложения)`,
        host: a.host,
        apiPort: this.config.get('apiPort'),
        usbipPort: a.usbipPort || this.config.get('usbipPort'),
        target: a.busid,
        kind: 'device',
        title: `USB ${a.vendorId || '????'}:${a.productId || '????'}`,
        parts: [{ deviceId: `usb:${a.busid}`, key: a.busid, description: 'внешнее подключение', hasTransport: true, vhciPort: a.vhciPort }],
        since: Date.now(),
        state: 'attached',
        lastError: null,
      });
      log.info(`обнаружено стороннее подключение ${tag} на порту ${a.vhciPort}`);
    }

    this.emit('changed');
  }

  list() {
    return [...this.attachments.values()].map((a) => ({
      ...a,
      parts: a.parts.map((p) => ({ ...p })),
    }));
  }

  /** Запросы к нам как к держателю — для диалога в интерфейсе. */
  pendingRequests() {
    return [...this.incomingRequests.values()]
      .filter((r) => r.state === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  isHeld(nodeId, target) {
    return this.attachments.has(attachKey(nodeId, target));
  }

  /**
   * Занять цель и подключить всё, что поддаётся пробросу.
   * @param {object} t { nodeId, nodeName, host, apiPort, usbipPort, target, kind, title, devices[] }
   * @param {boolean} force — право владельца забрать своё без спроса
   */
  async attach(t, { force = false } = {}) {
    const id = attachKey(t.nodeId, t.target);
    const current = this.attachments.get(id);
    if (current && (current.state === 'attached' || current.state === 'attaching')) {
      throw new Error('цель уже занята этим компьютером');
    }

    const rec = {
      id,
      orphan: false,
      nodeId: t.nodeId,
      nodeName: t.nodeName,
      host: t.host,
      apiPort: t.apiPort || this.config.get('apiPort'),
      usbipPort: t.usbipPort || this.config.get('usbipPort'),
      target: t.target,
      kind: t.kind || 'device',
      title: t.title,
      parts: (t.devices || []).map((d) => ({
        deviceId: d.deviceId,
        key: d.key,
        type: d.type,
        description: d.description,
        hasTransport: Boolean(d.hasTransport),
        vhciPort: null,
        error: null,
      })),
      since: Date.now(),
      attachedAt: null,
      state: 'attaching',
      lastError: null,
      self: t.nodeId === this.config.get('nodeId'),
    };
    this.attachments.set(id, rec);
    this.emit('changed');

    try {
      const grant = await this._requestClaim(t, force);
      rec.usbipPort = grant.usbipPort || rec.usbipPort;
      rec.leaseMs = grant.leaseMs;

      // Подключаем по очереди. Устройства без проброса просто числятся
      // забронированными — для них локально делать нечего.
      for (const part of rec.parts) {
        if (!part.hasTransport) continue;
        const result = await this.backend.attach({ host: rec.host, busid: part.key, port: rec.usbipPort });
        part.vhciPort = result.vhciPort;
      }

      rec.state = 'attached';
      rec.attachedAt = Date.now();
      const attached = rec.parts.filter((p) => p.hasTransport).length;
      log.info(`${rec.title} занято у "${rec.nodeName}"${attached ? `, подключено устройств: ${attached}` : ' (бронь)'}`);
      this.emit('changed');
      return { ...rec };
    } catch (e) {
      rec.state = 'error';
      rec.lastError = e.message;
      log.error(`не удалось занять ${rec.title} у "${rec.nodeName}": ${e.message}`);

      // Откат: отцепляем то, что успели, и возвращаем право — иначе цель
      // останется занятой из-за нашей же неудачи.
      for (const part of rec.parts) {
        if (part.vhciPort === null || part.vhciPort === undefined) continue;
        await this.backend.detach(part.vhciPort).catch(() => {});
      }
      await this._requestRelease(rec).catch(() => {});
      this.attachments.delete(id);
      this.emit('changed');
      throw e;
    }
  }

  /** Отцепить и вернуть право. */
  async detach(id, { keepClaim = false } = {}) {
    const rec = this.attachments.get(id);
    if (!rec) throw new Error('занятие не найдено');

    rec.state = 'detaching';
    this.emit('changed');

    for (const part of rec.parts) {
      if (part.vhciPort === null || part.vhciPort === undefined) continue;
      try {
        await this.backend.detach(part.vhciPort);
      } catch (e) {
        log.warn(`отключение порта ${part.vhciPort} не удалось: ${e.message}`);
      }
    }

    if (!keepClaim && !rec.orphan) {
      await this._requestRelease(rec).catch((e) => {
        log.warn(`владелец не подтвердил освобождение ${rec.target}: ${e.message}`);
      });
    }

    this.attachments.delete(id);
    log.info(`${rec.title} освобождено`);
    this.emit('changed');
    return { ok: true };
  }

  async detachAll() {
    for (const id of [...this.attachments.keys()]) {
      if (this.attachments.get(id)?.orphan) continue; // не наше — не трогаем
      await this.detach(id).catch((e) => log.warn('освобождение при завершении:', e.message));
    }
  }

  /** Ответ на запрос: отдать цель просителю или отказать. */
  async answerRequest(requestId, accept) {
    const req = this.incomingRequests.get(requestId);
    if (!req) throw new Error('запрос не найден');

    const isOurs = req.ownerNodeId === this.config.get('nodeId');
    const answer = isOurs
      ? await this.share.answerRequest(requestId, this.config.get('nodeId'), accept)
      : await rpc({
        host: req.ownerHost,
        port: req.ownerApiPort,
        path: '/api/v1/peer/request-answer',
        method: 'POST',
        body: { requestId, accept: Boolean(accept) },
        key: this.keyFor(req.ownerNodeId),
        nodeId: this.config.get('nodeId'),
        timeoutMs: 8000,
      });

    req.state = accept ? 'accepted' : 'declined';
    this.incomingRequests.set(requestId, req);

    // Согласились — отпускаем цель у себя. Право владелец уже снял, нам
    // осталось убрать локальное подключение, чтобы в системе не осталось
    // устройства, ведущего в никуда.
    if (accept) {
      const id = attachKey(req.ownerNodeId, req.target);
      if (this.attachments.has(id)) {
        await this.detach(id, { keepClaim: true }).catch((e) => log.warn(e.message));
      }
    }
    this.emit('changed');
    return answer;
  }

  // --------------------------------------------------------------- вызовы

  async _requestClaim(t, force) {
    if (t.nodeId === this.config.get('nodeId')) {
      return this.share.claim(t.target, {
        holderId: this.config.get('nodeId'),
        holderName: this.config.get('name'),
        force,
      });
    }
    try {
      return await rpc({
        host: t.host,
        port: t.apiPort,
        path: '/api/v1/peer/claim',
        method: 'POST',
        body: { target: t.target, holderName: this.config.get('name'), force: Boolean(force) },
        key: this.keyFor(t.nodeId),
        nodeId: this.config.get('nodeId'),
        timeoutMs: 15000,
      });
    } catch (e) {
      if (e instanceof RpcError && e.body) {
        throw new Error(e.body.message || e.message);
      }
      throw e;
    }
  }

  async _requestRelease(rec) {
    if (rec.nodeId === this.config.get('nodeId')) {
      return this.share.release(rec.target, this.config.get('nodeId'));
    }
    if (!rec.nodeId) return { ok: true }; // стороннее подключение
    return rpc({
      host: rec.host,
      port: rec.apiPort || this.config.get('apiPort'),
      path: '/api/v1/peer/release',
      method: 'POST',
      body: { target: rec.target },
      key: this.keyFor(rec.nodeId),
      nodeId: this.config.get('nodeId'),
      timeoutMs: 8000,
    });
  }

  /**
   * Продление аренд. Ответ владельца приносит ещё и запросы к нам как
   * к держателю: отдельный канал для этого не нужен, heartbeat идёт и так.
   */
  async _heartbeatAll() {
    for (const rec of [...this.attachments.values()]) {
      if (rec.orphan || rec.state !== 'attached') continue;

      try {
        const res = rec.nodeId === this.config.get('nodeId')
          ? this.share.renew(rec.target, this.config.get('nodeId'))
          : await rpc({
            host: rec.host,
            port: rec.apiPort || this.config.get('apiPort'),
            path: '/api/v1/peer/heartbeat',
            method: 'POST',
            body: { target: rec.target },
            key: this.keyFor(rec.nodeId),
            nodeId: this.config.get('nodeId'),
            timeoutMs: 5000,
          });

        rec.lastHeartbeat = Date.now();
        rec.heartbeatFails = 0;
        if (rec.lastError) { rec.lastError = null; this.emit('changed'); }
        this._absorbRequests(rec, res?.pendingRequests);
        // Скорость измеряет владелец — у него стоит счётчик. Держателю она
        // приезжает попутно, отдельного канала для этого не нужно.
        this._absorbTraffic(rec, res?.traffic);
      } catch (e) {
        rec.heartbeatFails = (rec.heartbeatFails || 0) + 1;
        rec.lastError = e.message;
        log.warn(`heartbeat по ${rec.target} (${rec.nodeName}) не прошёл: ${e.message}`);

        const revoked = e.code === 'no_claim' || e.code === 'forbidden'
          || /no_claim|forbidden|занято другим/i.test(e.message);
        // Право отозвано — отцепляемся сразу. Сетевой сбой — три попытки,
        // чтобы не рвать рабочее подключение из-за одного потерянного пакета.
        if (revoked || rec.heartbeatFails >= 3) {
          log.warn(`${rec.title}: ${revoked ? 'право отозвано владельцем' : 'узел недоступен'} — отцепляемся`);
          await this.detach(rec.id, { keepClaim: revoked }).catch(() => {});
        }
        this.emit('changed');
      }
    }
  }

  /** Раскладывает присланные владельцем счётчики по устройствам занятия. */
  _absorbTraffic(rec, list) {
    if (!Array.isArray(list)) return;
    let changed = false;
    for (const t of list) {
      const part = rec.parts.find((p) => p.deviceId === t.deviceId);
      if (!part) continue;
      part.traffic = t.bytesInPerMinute === undefined ? null : {
        bytesInPerMinute: t.bytesInPerMinute,
        bytesOutPerMinute: t.bytesOutPerMinute,
        totalIn: t.totalIn,
        totalOut: t.totalOut,
        lastActivity: t.lastActivity,
      };
      changed = true;
    }
    if (changed) this.emit('changed');
  }

  /** Запоминает запросы, адресованные нам, и сообщает о новых. */
  _absorbRequests(rec, list) {
    if (!Array.isArray(list)) return;
    const me = this.config.get('nodeId');
    let fresh = false;

    for (const r of list) {
      if (r.holderId !== me) continue;
      const known = this.incomingRequests.get(r.id);
      this.incomingRequests.set(r.id, {
        ...r,
        ownerNodeId: rec.nodeId,
        ownerHost: rec.host,
        ownerApiPort: rec.apiPort || this.config.get('apiPort'),
      });
      if (!known && r.state === 'pending') fresh = true;
    }

    // Подчищаем завершённые, чтобы список не рос без конца.
    for (const [id, r] of this.incomingRequests) {
      if (r.state !== 'pending' && Date.now() - (r.answeredAt || r.createdAt) > 120000) {
        this.incomingRequests.delete(id);
      }
    }

    if (fresh) {
      log.info('поступил запрос на освобождение занятой цели');
      this.emit('request-incoming');
      this.emit('changed');
    }
  }

  /**
   * Владелец сообщил, что право отозвано (забрал себе или освободил
   * принудительно). Отцепляемся немедленно: иначе в системе до следующего
   * heartbeat останется устройство, которое уже никуда не ведёт.
   */
  async revokedByOwner(ownerNodeId, target, reason) {
    const id = attachKey(ownerNodeId, target);
    const rec = this.attachments.get(id);
    if (!rec) return false;
    log.warn(`${rec.title}: владелец отозвал право (${reason || 'без причины'}) — отцепляемся`);
    await this.detach(id, { keepClaim: true }).catch((e) => log.warn(e.message));
    this.emit('revoked', { target, reason, title: rec.title });
    return true;
  }

  /** Принять запрос напрямую от владельца (мгновенное уведомление). */
  acceptPush(request, owner) {
    if (request.holderId !== this.config.get('nodeId')) return false;
    const known = this.incomingRequests.get(request.id);
    this.incomingRequests.set(request.id, {
      ...request,
      ownerNodeId: owner.nodeId,
      ownerHost: owner.host,
      ownerApiPort: owner.apiPort,
    });
    if (!known && request.state === 'pending') {
      log.info(`запрос на освобождение: "${request.requesterName}" просит ${request.title}`);
      this.emit('request-incoming');
      this.emit('changed');
    }
    return true;
  }
}
