// Подключение чужих (и своих) устройств к этой машине.
//
// Занятие устройства — это две отдельные вещи, и их важно не путать:
//   1. ПРАВО на устройство: аренда у владельца, выдаётся по RPC.
//   2. ФАКТ подключения: usbip attach, после которого устройство
//      появляется в «Диспетчере устройств».
// Право берём первым: если владелец откажет, локальный VHCI трогать незачем.
// При освобождении порядок обратный — сначала отцепляем, потом отдаём право.

import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { rpc, RpcError } from '../net/rpc.js';
import { deviceKey } from '../net/protocol.js';

const log = logger('attach');

export class AttachManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('../usb/backend.js').UsbBackend} o.backend
   * @param {import('../config.js').Config} o.config
   * @param {import('./shareManager.js').ShareManager} o.share — для устройств этого же узла
   */
  constructor({ backend, config, share }) {
    super();
    this.backend = backend;
    this.config = config;
    this.share = share;
    /** @type {Map<string, object>} deviceKey → подключение */
    this.attachments = new Map();
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

    const liveKeys = new Set();
    for (const a of live) {
      const rec = [...this.attachments.values()]
        .find((x) => x.busid === a.busid && x.host === a.host);
      if (rec) {
        rec.vhciPort = a.vhciPort;
        rec.state = 'attached';
        liveKeys.add(rec.id);
        continue;
      }
      // Подключение, о котором мы ничего не знаем: осталось от прошлого
      // запуска или сделано вручную через usbip. Показываем как «внешнее».
      const id = `orphan:${a.host}:${a.busid}`;
      liveKeys.add(id);
      this.attachments.set(id, {
        id,
        orphan: true,
        nodeId: null,
        nodeName: `${a.host} (вне приложения)`,
        host: a.host,
        usbipPort: a.usbipPort || this.config.get('usbipPort'),
        busid: a.busid,
        description: `USB ${a.vendorId || '????'}:${a.productId || '????'}`,
        vendorId: a.vendorId || null,
        productId: a.productId || null,
        vhciPort: a.vhciPort,
        since: Date.now(),
        state: 'attached',
        lastError: null,
      });
      log.info(`обнаружено стороннее подключение ${a.host}/${a.busid} на порту ${a.vhciPort}`);
    }

    // Записи без реального подключения удаляем — кроме тех,
    // что прямо сейчас в процессе подключения.
    for (const [id, rec] of this.attachments) {
      if (liveKeys.has(id) || rec.state === 'attaching') continue;
      this.attachments.delete(id);
      log.debug('подключение', id, 'больше не активно');
    }
    this.emit('changed');
  }

  isAttached(nodeId, busid) {
    return this.attachments.has(deviceKey(nodeId, busid));
  }

  list() {
    return [...this.attachments.values()].map((a) => ({ ...a }));
  }

  /**
   * Занять и подключить устройство.
   * @param {object} target { nodeId, nodeName, host, apiPort, usbipPort, busid, description, ... }
   */
  async attach(target) {
    const id = deviceKey(target.nodeId, target.busid);
    if (this.attachments.has(id)) {
      const cur = this.attachments.get(id);
      if (cur.state === 'attached' || cur.state === 'attaching') {
        throw new Error('устройство уже подключено к этому компьютеру');
      }
    }

    const rec = {
      id,
      orphan: false,
      nodeId: target.nodeId,
      nodeName: target.nodeName,
      host: target.host,
      // Порт API владельца обязан жить в самой записи: освобождение и
      // heartbeat идут по ней, а сведения об узле к тому моменту
      // могут быть уже недоступны.
      apiPort: target.apiPort || this.config.get('apiPort'),
      usbipPort: target.usbipPort || this.config.get('usbipPort'),
      busid: target.busid,
      description: target.description,
      vendorId: target.vendorId || null,
      productId: target.productId || null,
      vhciPort: null,
      since: Date.now(),
      state: 'attaching',
      lastError: null,
      self: target.nodeId === this.config.get('nodeId'),
    };
    this.attachments.set(id, rec);
    this.emit('changed');

    try {
      const grant = await this._requestClaim(target);
      rec.usbipPort = grant.usbipPort || rec.usbipPort;
      rec.leaseMs = grant.leaseMs;

      const result = await this.backend.attach({ host: rec.host, busid: rec.busid });
      rec.vhciPort = result.vhciPort;
      rec.state = 'attached';
      rec.attachedAt = Date.now();
      log.info(`устройство ${rec.busid} узла "${rec.nodeName}" подключено (VHCI-порт ${rec.vhciPort ?? '?'})`);
      this.emit('changed');
      return { ...rec };
    } catch (e) {
      rec.state = 'error';
      rec.lastError = e.message;
      log.error(`не удалось подключить ${rec.busid} узла "${rec.nodeName}": ${e.message}`);

      // Право уже могло быть выдано — возвращаем его, чтобы устройство
      // не осталось занятым из-за нашей неудачи на локальной стороне.
      await this._requestRelease(target).catch(() => {});
      this.attachments.delete(id);
      this.emit('changed');
      throw e;
    }
  }

  /** Отключить и вернуть право. */
  async detach(id, { keepClaim = false } = {}) {
    const rec = this.attachments.get(id);
    if (!rec) throw new Error('подключение не найдено');

    rec.state = 'detaching';
    this.emit('changed');

    if (rec.vhciPort !== null && rec.vhciPort !== undefined) {
      try {
        await this.backend.detach(rec.vhciPort);
      } catch (e) {
        log.warn(`detach порта ${rec.vhciPort} не удался: ${e.message}`);
      }
    }

    if (!keepClaim && !rec.orphan) {
      await this._requestRelease(rec).catch((e) => {
        log.warn(`владелец не подтвердил освобождение ${rec.busid}: ${e.message}`);
      });
    }

    this.attachments.delete(id);
    log.info(`устройство ${rec.busid} узла "${rec.nodeName}" отключено`);
    this.emit('changed');
    return { ok: true };
  }

  async detachAll() {
    const ids = [...this.attachments.keys()];
    for (const id of ids) {
      // Осиротевшие подключения не наши — оставляем как есть.
      if (this.attachments.get(id)?.orphan) continue;
      await this.detach(id).catch((e) => log.warn('отключение при завершении:', e.message));
    }
  }

  /** Запрос права у владельца. Своё устройство обслуживаем без сети. */
  async _requestClaim(target) {
    if (target.nodeId === this.config.get('nodeId')) {
      return this.share.claim(target.busid, {
        holderId: this.config.get('nodeId'),
        holderName: this.config.get('name'),
      });
    }
    try {
      return await rpc({
        host: target.host,
        port: target.apiPort,
        path: '/api/v1/peer/claim',
        method: 'POST',
        body: {
          busid: target.busid,
          holderId: this.config.get('nodeId'),
          holderName: this.config.get('name'),
        },
        key: this.config.get('preSharedKey'),
        nodeId: this.config.get('nodeId'),
        timeoutMs: 8000,
      });
    } catch (e) {
      if (e instanceof RpcError && e.body) {
        const who = e.body.claim?.holderName;
        if (e.code === 'busy' && who) throw new Error(`устройство уже занято узлом "${who}"`);
        throw new Error(e.body.message || e.message);
      }
      throw e;
    }
  }

  async _requestRelease(target) {
    if (target.nodeId === this.config.get('nodeId')) {
      return this.share.release(target.busid, this.config.get('nodeId'));
    }
    if (!target.nodeId) return { ok: true }; // стороннее подключение
    return rpc({
      host: target.host,
      port: target.apiPort || this.config.get('apiPort'),
      path: '/api/v1/peer/release',
      method: 'POST',
      body: { busid: target.busid, holderId: this.config.get('nodeId') },
      key: this.config.get('preSharedKey'),
      nodeId: this.config.get('nodeId'),
      timeoutMs: 8000,
    });
  }

  /** Продление всех аренд. Пропажа права — повод честно отцепить устройство. */
  async _heartbeatAll() {
    for (const rec of [...this.attachments.values()]) {
      if (rec.orphan || rec.state !== 'attached') continue;

      try {
        if (rec.nodeId === this.config.get('nodeId')) {
          this.share.renew(rec.busid, this.config.get('nodeId'));
        } else {
          await rpc({
            host: rec.host,
            port: rec.apiPort || this.config.get('apiPort'),
            path: '/api/v1/peer/heartbeat',
            method: 'POST',
            body: { busid: rec.busid, holderId: this.config.get('nodeId') },
            key: this.config.get('preSharedKey'),
            nodeId: this.config.get('nodeId'),
            timeoutMs: 5000,
          });
        }
        rec.lastHeartbeat = Date.now();
        rec.heartbeatFails = 0;
        if (rec.lastError) {
          rec.lastError = null;
          this.emit('changed');
        }
      } catch (e) {
        rec.heartbeatFails = (rec.heartbeatFails || 0) + 1;
        rec.lastError = e.message;
        log.warn(`heartbeat по ${rec.busid} (${rec.nodeName}) не прошёл: ${e.message}`);

        const revoked = e.code === 'no_claim' || e.code === 'forbidden';
        // Право отозвано — отцепляемся сразу. Сетевой сбой — даём три попытки,
        // чтобы не рвать рабочее подключение из-за одного потерянного пакета.
        if (revoked || rec.heartbeatFails >= 3) {
          log.warn(`подключение ${rec.busid} прекращено: ${revoked ? 'право отозвано владельцем' : 'узел недоступен'}`);
          await this.detach(rec.id, { keepClaim: revoked }).catch(() => {});
        }
        this.emit('changed');
      }
    }
  }
}
