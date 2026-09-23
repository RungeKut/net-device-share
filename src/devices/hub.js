// Единый список локальных устройств всех поддерживаемых типов.
//
// Выше этого слоя типы не различаются: каталог, занятость, аренда, группы и
// запросы работают с любым устройством одинаково. Различие ровно одно —
// есть ли у устройства проброс данных по сети (`hasTransport`). У USB он
// есть всегда, у сетевой карты — если её можно отдать мостом (решает
// NetShare), у COM и LPT пока нет. Без проброса устройство бронируется.

import { logger } from '../log.js';
import { listPorts, listNetInterfaces } from './ports.js';
import { makeDeviceId, hasTransport, typeInfo } from './types.js';

const log = logger('devices:hub');

export class DeviceHub {
  /**
   * @param {object} o
   * @param {import('./backend.js').UsbBackend} o.backend — бэкенд USB/IP
   * @param {() => string[]} o.enabledTypes — какие типы показывать
   * @param {import('../core/netShare.js').NetShare} [o.net] — проброс сетевых карт
   */
  constructor({ backend, enabledTypes, net = null }) {
    this.backend = backend;
    this.net = net;
    this.enabledTypes = enabledTypes || (() => ['usb', 'com', 'lpt', 'net']);
    /** Кеш медленных источников: { ts, ports, nets }. */
    this._slow = { ts: 0, ports: [], nets: [] };
    this._slowInFlight = null;
  }

  _enabled(type) {
    return this.enabledTypes().includes(type);
  }

  /**
   * Все локальные устройства в едином виде.
   *
   * Источники опрашиваются ПАРАЛЛЕЛЬНО, а порты и сетевые интерфейсы ещё и
   * кешируются. Причина не в экономии: перечисление через PowerShell занимает
   * секунды, и при последовательном опросе список USB успевал устареть к
   * моменту применения — свежее состояние затиралось старым снимком.
   * Состав портов и интерфейсов меняется несравнимо реже, чем занятость,
   * поэтому обновлять их каждые четыре секунды незачем.
   */
  async listLocal() {
    const wantPorts = this._enabled('com') || this._enabled('lpt');
    const wantNet = this._enabled('net');

    const [usb, slow] = await Promise.all([
      this._enabled('usb')
        ? this.backend.listLocal().catch((e) => {
          log.warn('перечисление USB не удалось:', e.message);
          return [];
        })
        : Promise.resolve([]),
      (wantPorts || wantNet) ? this._listSlow(wantPorts, wantNet) : Promise.resolve({ ports: [], nets: [] }),
    ]);

    const out = usb.map(fromUsb);
    for (const p of slow.ports) {
      if (this._enabled(p.type)) out.push(fromPort(p));
    }
    if (wantNet) {
      for (const n of slow.nets) out.push(this._fromNet(n));
    }
    return out;
  }

  /**
   * Сбросить кеш медленных источников.
   *
   * Кеш существует ради периодического опроса, а не ради экономии вообще.
   * Когда пользователь сам нажал «Обновить», он именно и просит посмотреть
   * заново: воткнул переходник — ждёт увидеть новый COM-порт, а не прежний
   * список ещё пятнадцать секунд.
   */
  invalidateSlow() {
    this._slow = { ts: 0, ports: this._slow.ports, nets: this._slow.nets };
  }

  async _listSlow(wantPorts, wantNet) {
    const FRESH_MS = 15000;
    if (Date.now() - this._slow.ts < FRESH_MS) return this._slow;
    // Один опрос на всех: параллельные refresh не должны множить
    // запуски PowerShell.
    if (this._slowInFlight) return this._slowInFlight;

    this._slowInFlight = (async () => {
      const [ports, nets] = await Promise.all([
        wantPorts ? listPorts().catch((e) => { log.warn('перечисление портов не удалось:', e.message); return []; }) : [],
        wantNet ? listNetInterfaces().catch((e) => { log.warn('перечисление сетевых интерфейсов не удалось:', e.message); return []; }) : [],
      ]);
      this._slow = { ts: Date.now(), ports, nets };
      this._slowInFlight = null;
      return this._slow;
    })();
    return this._slowInFlight;
  }

  /**
   * Сетевая карта: проброс есть, если её можно отдать мостом. Почему нельзя
   * — записывается рядом, чтобы человек видел причину, а не просто «бронь».
   */
  _fromNet(n) {
    const d = fromPort(n);
    const blocker = this.net ? this.net.lendBlocker(d) : 'проброс сетевых карт недоступен';
    d.hasTransport = !blocker;
    d.meta = { ...d.meta, transportNote: blocker };
    d.bound = Boolean(this.net?.isLent(d.deviceId));
    return d;
  }

  // Операции с драйвером имеют смысл только для устройств с пробросом.
  // Для остальных они успешно ничего не делают: занятость — это запись
  // в каталоге, а не действие над оборудованием.

  /**
   * @param {object} device
   * @param {{ holderId?: string, holderAddress?: string|null }} [holder] —
   *   кому отдаётся: сетевой карте нужно знать, кого пускать в канал
   */
  async bind(device, holder = {}) {
    if (!device.hasTransport) return { ok: true, reservationOnly: true };
    if (device.type === 'net') {
      if (!this.net) throw new Error('проброс сетевых карт недоступен');
      const link = await this.net.lend(device, holder);
      return { ok: true, link };
    }
    return this.backend.bind(device.key);
  }

  async unbind(device) {
    if (device.type === 'net') {
      // Проброс мог исчезнуть, пока карта отдана (сменились права, пропал
      // драйвер), — вернуть её всё равно нужно.
      return this.net ? this.net.unlend(device) : { ok: true };
    }
    if (!device.hasTransport) return { ok: true, reservationOnly: true };
    return this.backend.unbind(device.key);
  }
}

function fromUsb(d) {
  const key = d.busid || `?${d.instanceId || d.description}`;
  return {
    type: 'usb',
    key,
    deviceId: makeDeviceId('usb', key),
    title: d.busid || '—',
    description: d.description || 'USB-устройство',
    hasTransport: hasTransport('usb'),
    bound: Boolean(d.bound),
    attachedByIp: d.attachedByIp || null,
    connectedSince: d.connectedSince ?? null,
    unavailableReason: d.busid ? null : (d.unavailableReason || 'устройство нельзя опубликовать'),
    meta: {
      vendorId: d.vendorId || null,
      productId: d.productId || null,
      serial: d.serial || null,
      instanceId: d.instanceId || null,
    },
  };
}

function fromPort(p) {
  return {
    type: p.type,
    key: p.key,
    deviceId: p.deviceId,
    title: p.title,
    description: p.description,
    hasTransport: hasTransport(p.type),
    bound: false,
    attachedByIp: null,
    connectedSince: null,
    unavailableReason: null,
    meta: p.details || {},
  };
}

export { typeInfo };
