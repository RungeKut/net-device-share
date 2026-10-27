// Единый список локальных устройств всех поддерживаемых типов.
//
// Выше этого слоя типы не различаются: каталог, занятость, аренда, группы и
// запросы работают с любым устройством одинаково. Различие ровно одно —
// есть ли у устройства проброс данных по сети (`hasTransport`). У USB он
// есть всегда, у сетевой карты — если её можно отдать мостом (решает
// NetShare), у COM и LPT пока нет. Без проброса устройство бронируется.

import { logger } from '../log.js';
import { listPortsAndNets, slowSignature } from './ports.js';
import { makeDeviceId, hasTransport, typeInfo } from './types.js';

const log = logger('devices:hub');

export class DeviceHub {
  /**
   * @param {object} o
   * @param {import('./backend.js').UsbBackend} o.backend — бэкенд USB/IP
   * @param {() => string[]} o.enabledTypes — какие типы показывать
   * @param {import('../core/netShare.js').NetShare} [o.net] — проброс сетевых карт
   */
  constructor({ backend, enabledTypes, net = null, slow = {} }) {
    this.backend = backend;
    this.net = net;
    this.enabledTypes = enabledTypes || (() => ['usb', 'com', 'lpt', 'net']);
    /**
     * Кеш медленных источников. ts — когда их проверяли, fullDue — до какого
     * момента полное чтение не требуется, sig — отпечаток, с которым перечитали.
     */
    this._slow = { ts: 0, fullDue: 0, sig: null, want: null, ports: [], nets: [] };
    this._slowInFlight = null;
    // Подмена источников и часов — для тестов: настоящий опрос стоит запуска PowerShell.
    this._load = slow.load || listPortsAndNets;
    this._signature = slow.signature || slowSignature;
    this._now = slow.now || Date.now;
    this._freshMs = slow.freshMs ?? 15000;
    this._fullRefreshMs = slow.fullRefreshMs ?? 300000;
    this._random = slow.random || Math.random;
    this.slowStats = { loads: 0, skipped: 0, failed: 0 };
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
        ? this.backend.listLocal().then((list) => (this._lastUsb = list)).catch((e) => {
          // Сбой опроса — не «устройств нет»: пустой список отозвал бы все
          // аренды. Оставляем прошлый результат до следующего опроса.
          log.warn('перечисление USB не удалось:', e.message);
          return this._lastUsb || [];
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
    this._slow = { ...this._slow, ts: 0, sig: null };
  }

  /**
   * Раз в freshMs спрашиваем дешёвый отпечаток (реестр COM/LPT и интерфейсы
   * в самом процессе). Совпал — прежний список ещё верен, PowerShell не
   * запускается. Не совпал, недоступен, сменился набор типов или прошло
   * fullRefreshMs — перечитываем по-настоящему: отпечаток не видит смены
   * состояния карты или драйвера без смены адреса, это ловит полное чтение.
   */
  async _listSlow(wantPorts, wantNet) {
    if (this._now() - this._slow.ts < this._freshMs) return this._slow;
    // Один опрос на всех: параллельные refresh не должны множить
    // запуски PowerShell.
    if (this._slowInFlight) return this._slowInFlight;

    this._slowInFlight = (async () => {
      try {
        const want = { ports: wantPorts, nets: wantNet };
        const prev = this._slow;
        // Отпечаток берётся ДО чтения: изменение посреди чтения даст другой
        // отпечаток в следующий раз и вызовет повторное чтение, а не потеряется.
        const sig = await this._probe(want);
        if (this._unchanged(prev, sig, want)) {
          this.slowStats.skipped++;
          this._slow = { ...prev, ts: this._now() };
          return this._slow;
        }
        return await this._reload(want, sig);
      } finally {
        this._slowInFlight = null;
      }
    })();
    return this._slowInFlight;
  }

  async _probe(want) {
    try {
      return await this._signature(want);
    } catch (e) {
      log.debug('отпечаток портов и интерфейсов не получен:', e.message);
      return null;
    }
  }

  _unchanged(prev, sig, want) {
    return sig !== null && prev.sig === sig && prev.ts !== 0
      && prev.want?.ports === want.ports && prev.want?.nets === want.nets
      && this._now() < prev.fullDue;
  }

  async _reload(want, sig) {
    this.slowStats.loads++;
    // Сбой опроса — не «устройств нет»: пустой список отозвал бы все аренды
    // COM/LPT/карт. Для сорвавшегося источника оставляем прошлый результат,
    // а кеш не считаем свежим — следующий опрос попробует снова.
    let r;
    try {
      r = await this._load(want);
    } catch (e) {
      log.warn('перечисление портов и интерфейсов не удалось:', e.message);
      r = { ports: null, nets: null };
    }
    const failed = (want.ports && r.ports === null) || (want.nets && r.nets === null);
    if (failed) this.slowStats.failed++;
    const now = this._now();
    // Срок следующего полного чтения со случайным разбросом ±25%: узлы,
    // запущенные вместе (или несколько на одном компьютере), иначе читали бы
    // PowerShell в один и тот же момент, и нагрузка приходила бы волнами.
    const jitter = 0.75 + this._random() * 0.5;
    this._slow = {
      ts: failed ? 0 : now,
      fullDue: failed ? 0 : now + this._fullRefreshMs * jitter,
      sig: failed ? null : sig,
      want,
      ports: r.ports ?? this._slow.ports,
      nets: r.nets ?? this._slow.nets,
    };
    return this._slow;
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
    return this.net ? this.net.decorate(d) : d;
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

  async unbind(device, holder = {}) {
    if (device.type === 'net') {
      // Проброс мог исчезнуть, пока карта отдана (сменились права, пропал
      // драйвер), — вернуть её всё равно нужно.
      return this.net ? this.net.unlend(device, holder) : { ok: true };
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
