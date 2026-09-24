// Сеть этого компьютера: коммутаторы, виртуальные адаптеры, настройки
// адаптеров и карта связей — то, что в интерфейсе на вкладке «Сеть».
//
// Как утилита VirtualNics, только без Hyper-V — из того, что уже есть:
//
//   КОММУТАТОР — программный (net/vswitch.js): кадры между портами по MAC.
//     Порты — TAP-адаптеры. Если в коммутатор включена физическая карта, он
//     «внешний»: карта и ещё один наш TAP («выход в сеть») собираются в мост
//     Windows, и всё, что подключено к коммутатору, оказывается в сети
//     карты. Мост в Windows один, поэтому и внешний коммутатор один; две
//     карты в нём — это две сети, слитые в одну, и так делают сознательно.
//
//   ВИРТУАЛЬНЫЙ АДАПТЕР — TAP со своим MAC, своими настройками IP и своей
//     категорией сети, подключённый портом к коммутатору. Нужен, когда в
//     сети стенда компьютер должен выглядеть несколькими устройствами —
//     каждое со своим MAC и адресом.
//
//   АДАПТЕР МОСТА — сам компьютер в сети внешнего коммутатора (как vEthernet
//     у Hyper-V с «общим доступом управляющей ОС»). При создании коммутатора
//     ему переходят настройки IP карты, чтобы компьютер не потерял адрес.
//
//   ЧУЖОЙ АДАПТЕР — всё, что создало не приложение: карты, адаптеры OpenVPN,
//     VirtualBox, Hyper-V. Их можно переименовать, отключить, сменить им MAC,
//     программные — удалить. И соединить: чужой TAP подключается к
//     коммутатору портом, как виртуальный адаптер (запись с adopted: пока
//     он подключён, другая программа открыть его не может — его можно
//     отпустить), прочие — мостом, как карта. Сама по себе программа чужого
//     не трогает — только по команде человека.
//
// Всё это живёт, пока работает приложение: кадры между портами пересылает
// оно. Мост Windows и настройки адаптеров остаются и без него, а
// виртуальные адаптеры между запусками видны как «кабель не подключён».
//
// Любое изменение — права администратора. Изменения идут строго по одному:
// мост в системе один, и две операции разом перепутали бы его состав.
//
// ЧТО НЕЛЬЗЯ, И ПОЧЕМУ:
//   * рабочую карту приложения — в мост и менять ей адрес: оборвётся связь
//     и с узлами, и с тем, кто управляет этим компьютером через браузер;
//   * Wi-Fi — в мост: он не пропускает кадры с чужими MAC;
//   * адрес карте, которая в мосту: он у неё не действует, адрес — у моста;
//   * рабочую карту отключать, переименовывать и менять ей MAC: приложение
//     знает её по имени, а без неё оборвётся связь;
//   * занятую карту — трогать вовсе, опубликованную — переименовывать: имя
//     карты — её адрес в каталоге;
//   * удалять физическую карту (Windows найдёт её снова — её отключают) и
//     адаптер Hyper-V (он удаляется вместе с коммутатором Hyper-V);
//   * служебные адаптеры приложения — всё, кроме того, что делает оно само.

import crypto from 'node:crypto';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { VSwitch, garpFrame, macBytes } from '../net/vswitch.js';
import { keepRelay, plugRelay } from '../net/relayKeeper.js';
import {
  createTap, removeTap, removeAdapter, renameAdapter, friendlyName, setTapMac, setAdapterMac, setAdapterEnabled,
  macProblem, normalizeMac, formatMac, randomMac, driverFilesPresent,
} from '../net/tapAdapters.js';
import { bridge, unbridge, bridgeMembers, bridgeAdapter, setBridgeIp } from '../net/bridge.js';
import { readIpConfig, applyIpConfig, validateIpConfig, ensureCategories } from '../net/ipConfig.js';
import { listAdapters, firewallState } from '../net/adapters.js';

const log = logger('net');

/** Как долго опись адаптеров считается свежей. */
const INVENTORY_FRESH_MS = 2500;
/** Состояние сетевых экранов меняется редко — спрашиваем раз в минуту. */
const FIREWALL_FRESH_MS = 60000;
/** Как часто следить за категорией сети и адресами наших адаптеров. */
const CATEGORY_EVERY_MS = 20000;
const ADDRESS_WATCH_MS = 4000;

function errWith(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Имя коммутатора или адаптера: видно в «Сетевых подключениях». */
function cleanName(text, what) {
  const name = friendlyName(String(text || ''));
  if (!name) throw errWith('bad_request', `${what}: пустое имя`);
  if (name.length > 48) throw errWith('bad_request', `${what}: имя длиннее 48 символов`);
  return name;
}

export class NetManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('../config.js').Config} o.config
   * @param {import('./netShare.js').NetShare} o.net — проброс карт
   * @param {() => string|null} o.workingIface — через какую карту работает приложение
   * @param {() => Map<string, object>} [o.devices] — сетевые карты из каталога
   *   (имя карты → устройство с занятостью): карта показывает и их
   * @param {(a: object) => boolean} [o.isCard] — годится ли адаптер в мост
   *   как карта. Подменяется только в проверках: на стенде карту изображает
   *   TAP-адаптер, иначе пришлось бы разбирать настоящую сеть машины.
   */
  constructor({ config, net, workingIface, devices = () => new Map(), isCard = (a) => a.hardware }) {
    super();
    this.config = config;
    this.net = net;
    this.workingIface = workingIface || (() => null);
    this.devices = devices;
    this.isCard = isCard;
    this.supported = process.platform === 'win32';
    /** @type {Map<string, object>} id коммутатора → { sw, ports, problem } */
    this.switches = new Map();
    this.chain = Promise.resolve();
    /** Что делается прямо сейчас — для интерфейса. */
    this.busy = null;
    this.inv = { at: 0, adapters: [], promise: null, firewall: null, firewallAt: 0 };
    this.timers = [];

    // Пробросу нужно знать, не занят ли мост коммутатором.
    net.fabric = {
      switchOfNic: (name) => this._switchOfNicName(name),
      bridgeSwitch: () => {
        const rec = this._bridgeSwitchRec();
        return rec ? { id: rec.id, name: rec.name, nics: rec.nics.map((n) => n.name) } : null;
      },
    };
  }

  get elevated() {
    return Boolean(this.net.elevated);
  }

  async start() {
    if (!this.supported) return this;
    // Запись о коммутаторе, которого уже нет: свой адаптер остаётся
    // неподключённым, чужой отпускается.
    const ids = new Set(this._switchRecs().map((r) => r.id));
    for (const v of this._vnicRecs().filter((r) => r.switchId && !ids.has(r.switchId))) {
      if (v.adopted) this._dropTap(v.guid);
      else this._setTap(v.guid, { switchId: null });
    }
    for (const rec of this._switchRecs()) this._startSwitch(rec);
    // Виртуальные адаптеры без коммутатора тоже поднимаются: у поднятого
    // адаптера «кабель подключён», и Windows хранит ему адрес. Чужой адаптер
    // без коммутатора не держим — он вернулся к своей программе.
    for (const v of this._vnicRecs().filter((r) => !r.switchId)) {
      if (v.adopted) this._dropTap(v.guid);
      else this._plugLoose(v.guid);
    }
    this.timers.push(setInterval(() => this._enforceCategories(), CATEGORY_EVERY_MS));
    this.timers.push(setInterval(() => this._watchVnicAddresses(), ADDRESS_WATCH_MS));
    for (const t of this.timers) t.unref?.();
    setTimeout(() => this._enforceCategories(), 5000).unref?.();
    this._checkBridge().catch(() => {});
    return this;
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    for (const rt of this.switches.values()) {
      for (const holder of rt.ports.values()) await this._unplugHolder(holder);
    }
    for (const holder of (this.loose || new Map()).values()) await this._unplugHolder(holder);
  }

  // ------------------------------------------------------------ записи

  _switchRecs() {
    return this.config.get('netSwitches') || [];
  }

  _saveSwitches(list) {
    this.config.set({ netSwitches: list });
  }

  _updateSwitch(id, patch) {
    this._saveSwitches(this._switchRecs().map((r) => (r.id === id ? { ...r, ...patch } : r)));
    return this._switchRecs().find((r) => r.id === id);
  }

  _taps() {
    return this.config.get('tapAdapters') || [];
  }

  _vnicRecs() {
    return this._taps().filter((r) => r.role === 'vnic');
  }

  _setTap(guid, patch) {
    const list = this._taps();
    const has = list.some((r) => r.guid === guid);
    this.config.set({
      tapAdapters: has ? list.map((r) => (r.guid === guid ? { ...r, ...patch } : r)) : [...list, { guid, ...patch }],
    });
  }

  _dropTap(guid) {
    this.config.set({ tapAdapters: this._taps().filter((r) => r.guid !== guid) });
  }

  /** Коммутатор, которому принадлежит мост Windows. */
  _bridgeSwitchRec() {
    return this._switchRecs().find((r) => r.uplink) || null;
  }

  _switchOfNicName(name) {
    if (!name) return null;
    const rec = this._switchRecs().find((r) => r.nics.some((n) => n.name === name));
    return rec ? { id: rec.id, name: rec.name, nics: rec.nics.map((n) => n.name) } : null;
  }

  // ----------------------------------------------------------- порты

  _startSwitch(rec) {
    const rt = { id: rec.id, sw: new VSwitch({ id: rec.id, name: rec.name }), ports: new Map(), problem: null };
    this.switches.set(rec.id, rt);
    if (rec.uplink) this._plug(rt, rec.uplink, `коммутатор «${rec.name}»: выход в сеть`);
    for (const v of this._vnicRecs().filter((r) => r.switchId === rec.id)) {
      this._plug(rt, v.guid, `виртуальный адаптер ${v.guid.slice(0, 8)}`);
    }
    return rt;
  }

  /** Поднять посредника адаптера и включить его портом в коммутатор. */
  _plug(rt, guid, label) {
    const holder = { guid, rt, stopped: false, relay: null, handle: null, failed: null, restarts: 0 };
    rt.ports.set(guid, holder);
    const ready = keepRelay(holder, guid, label, (relay) => {
      holder.handle?.detach();
      holder.handle = plugRelay(holder.rt.sw, guid, relay, label);
    }, (why) => { holder.failed = why; this.emit('changed'); })
      .catch((e) => { holder.failed = e.message; log.warn(`${label}: ${e.message}`); this.emit('changed'); });
    holder.ready = ready;
    return holder;
  }

  /** Виртуальный адаптер без коммутатора: поднят, но кадры никуда не идут. */
  _plugLoose(guid) {
    this.loose ??= new Map();
    const holder = { guid, rt: null, stopped: false, relay: null, handle: null, failed: null, restarts: 0 };
    this.loose.set(guid, holder);
    holder.ready = keepRelay(holder, guid, `виртуальный адаптер ${guid.slice(0, 8)}`, (relay) => relay.setSink(null),
      (why) => { holder.failed = why; this.emit('changed'); })
      .catch((e) => { holder.failed = e.message; this.emit('changed'); });
    return holder;
  }

  async _unplugHolder(holder) {
    if (!holder) return;
    holder.stopped = true;
    holder.handle?.detach();
    await holder.relay?.stop().catch(() => {});
    holder.relay = null;
  }

  /** Посредник адаптера, где бы он ни был подключён. */
  _holderOf(guid) {
    for (const rt of this.switches.values()) if (rt.ports.has(guid)) return rt.ports.get(guid);
    return this.loose?.get(guid) || null;
  }

  async _unplug(guid) {
    for (const rt of this.switches.values()) {
      const h = rt.ports.get(guid);
      if (h) { rt.ports.delete(guid); await this._unplugHolder(h); }
    }
    const h = this.loose?.get(guid);
    if (h) { this.loose.delete(guid); await this._unplugHolder(h); }
  }

  /** Поднять адаптер заново там, где он должен быть по записи. */
  _replug(guid) {
    const rec = this._taps().find((r) => r.guid === guid);
    if (!rec) return null;
    const rt = rec.switchId ? this.switches.get(rec.switchId) : null;
    return rt ? this._plug(rt, guid, `виртуальный адаптер ${guid.slice(0, 8)}`) : this._plugLoose(guid);
  }

  /** Сверить, собран ли мост внешнего коммутатора, — для подсказки на карте. */
  async _checkBridge() {
    const rec = this._bridgeSwitchRec();
    if (!rec) return;
    const members = await bridgeMembers();
    const inv = await this.inventory();
    const uplink = inv.adapters.find((a) => a.guid === rec.uplink);
    const missing = [...rec.nics.map((n) => inv.adapters.find((a) => a.guid === n.guid)?.name || n.name),
      uplink?.name].filter((n) => n && !members.includes(n));
    const rt = this.switches.get(rec.id);
    if (rt) rt.problem = missing.length ? `не в мосту: ${missing.join(', ')} — мост разобран не приложением` : null;
  }

  // --------------------------------------------------------- очередь

  /** Изменение сети: по одному, с отметкой «что делаем» для интерфейса. */
  _op(label, fn) {
    if (!this.supported) return Promise.reject(errWith('unsupported', 'настройка сети есть только на Windows'));
    if (!this.elevated) {
      return Promise.reject(errWith('need_admin', 'приложение запущено без прав администратора — менять сеть оно не может'));
    }
    const run = async () => {
      this.busy = label;
      this.emit('changed');
      try {
        return await fn();
      } finally {
        this.busy = null;
        this.inv.at = 0;
        this.emit('changed');
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  // ------------------------------------------------------------ опись

  /** Опись адаптеров, не старше пары секунд. Один опрос на всех. */
  async inventory(force = false) {
    if (!this.supported) return { adapters: [], firewall: null };
    if (!force && Date.now() - this.inv.at < INVENTORY_FRESH_MS) return this.inv;
    if (!this.inv.promise) {
      this.inv.promise = (async () => {
        try {
          const adapters = await listAdapters();
          this.inv.adapters = adapters;
          this.inv.at = Date.now();
          if (Date.now() - this.inv.firewallAt > FIREWALL_FRESH_MS) {
            this.inv.firewall = await firewallState().catch(() => null);
            this.inv.firewallAt = Date.now();
          }
          this._refreshNames(adapters);
        } finally {
          this.inv.promise = null;
        }
      })();
    }
    await this.inv.promise;
    return this.inv;
  }

  /** Имена карт в записях коммутаторов — по GUID: человек мог переименовать. */
  _refreshNames(adapters) {
    const byGuid = new Map(adapters.map((a) => [a.guid, a.name]));
    let changed = false;
    const list = this._switchRecs().map((r) => {
      const nics = r.nics.map((n) => {
        const now = byGuid.get(n.guid);
        if (now && now !== n.name) { changed = true; return { ...n, name: now }; }
        return n;
      });
      return { ...r, nics };
    });
    if (changed) this._saveSwitches(list);
  }

  async _adapter(guid) {
    const g = String(guid || '').replace(/[{}]/g, '').toUpperCase();
    const a = (await this.inventory(true)).adapters.find((x) => x.guid === g);
    if (!a) throw errWith('not_found', 'адаптер не найден — возможно, его уже удалили');
    return a;
  }

  /**
   * Можно ли включить этот адаптер в мост (null — можно). Кроме карт годятся
   * и программные адаптеры других программ (VirtualBox и т. п.): мост
   * соединяет сети любых адаптеров Ethernet.
   */
  _nicProblem(a) {
    if (!this.isCard(a)) {
      if (a.tap) return `«${a.name}» — TAP-адаптер: к коммутатору он подключается портом, а не мостом`;
      if (a.bridge) return 'адаптер моста в мост не включается';
      if (a.hyperv) {
        return `«${a.name}» — адаптер Hyper-V: у Hyper-V свой коммутатор, соединяйте его сеть с картой в Диспетчере Hyper-V (внешний коммутатор)`;
      }
    }
    if (a.wireless) return `«${a.name}» — Wi-Fi: он не пропускает кадры с чужими MAC, в мост его включать нельзя`;
    if (a.name === this.workingIface()) {
      return `через «${a.name}» работает само приложение: в мосту она на время потеряет адрес, и связь с узлами оборвётся`;
    }
    const dev = this.devices().get(a.name);
    if (dev?.claim || dev?.preparing) return `«${a.name}» занята — сначала её освобождают`;
    if (this.net.lends.size) return `сейчас отдана карта «${this.net.currentLend().nic}» — мост занят пробросом`;
    return null;
  }

  // ------------------------------------------------------------ права

  /** То, что нужно, чтобы решить про любой адаптер: записи, пробросы, каталог. */
  _context() {
    const described = this.net.describe();
    return {
      taps: new Map(this._taps().map((r) => [r.guid, r])),
      lendByTap: new Map(described.lends.filter((l) => l.tap).map((l) => [l.tap.guid, l])),
      borrowByTap: new Map(described.borrows.filter((b) => b.guid).map((b) => [b.guid, b])),
      devices: this.devices(),
      working: this.workingIface(),
    };
  }

  /** Кто этот адаптер для приложения. */
  _role(a, ctx) {
    const rec = ctx.taps.get(a.guid);
    if (a.bridge) return 'bridge';
    if (rec?.role === 'vnic') return 'vnic';
    if (rec?.role === 'uplink') return 'uplink';
    if (ctx.lendByTap.get(a.guid) || rec?.role === 'server') return 'lend';
    if (ctx.borrowByTap.get(a.guid) || rec?.role === 'client') return 'borrow';
    if (a.tap) return 'tap';
    // HardwareInterface бывает и у программных устройств: адаптер замыкания
    // KM-TEST (ROOT\NET\…) называет себя оборудованием.
    if (a.hardware && !a.software) return a.wireless ? 'wifi' : 'physical';
    return 'virtual';
  }

  /**
   * Что можно сделать с адаптером и почему нельзя остального. Одно правило и
   * для кнопок на карте, и для самих операций: те проверяют по свежей описи.
   *
   * @returns {{ can: Record<string, boolean>, why: Record<string, string> }}
   *   can: ip, category, rename, mac, enable, delete, move (порт
   *   коммутатора — TAP), bridge (в мост — остальные), unbridge, release;
   *   why — причины отказа по тем же ключам, why.manage — отказ во всём
   */
  _rights(a, role, ctx) {
    const rec = ctx.taps.get(a.guid);
    const dev = ctx.devices.get(a.name) || null;
    const can = {
      ip: false, category: false, rename: false, mac: false, enable: false, delete: false,
      move: false, bridge: false, unbridge: false, release: false,
    };
    const why = {};

    if (a.bridged) why.ip = 'в мосту: адрес задаётся у моста';
    else if (a.name === ctx.working) why.ip = 'через эту карту работает приложение — меняйте на месте';
    else if (role === 'uplink' || role === 'lend') why.ip = 'служебный адаптер моста';
    else if (a.bridge && a.tcpip === false) why.ip = 'IP на мосту выключен';
    else can.ip = true;
    can.category = Boolean(a.profile) || role === 'vnic' || role === 'borrow';

    // То, что запрещает всё остальное разом.
    why.manage = role === 'uplink' ? 'служебный адаптер коммутатора: он живёт и удаляется вместе с коммутатором'
      : role === 'lend' ? 'служебный адаптер проброса: он удалится при освобождении карты'
        : role === 'borrow' ? 'адаптер занятой вами карты: он удалится при освобождении'
          : a.name === ctx.working ? 'через эту карту работает приложение: отключить её или сменить ей адрес — оборвать связь и с узлами, и с этой страницей; меняйте её на месте, в свойствах Windows'
            : dev?.claim || dev?.preparing ? `карта занята${dev.claim?.holderName ? ` («${dev.claim.holderName}»)` : ''} — сначала её освобождают`
              : null;
    if (why.manage) return { can, why };
    delete why.manage;

    if (dev?.shared) why.rename = 'карта опубликована, а имя карты — её адрес в каталоге: снимите публикацию, переименуйте и опубликуйте снова';
    else can.rename = true;
    if (role === 'bridge') {
      why.manage = 'адаптер моста появляется и пропадает вместе с мостом';
      return { can, why };
    }

    const inSwitch = this._switchRecs().find((r) => r.nics.some((n) => n.guid === a.guid));
    const bridged = a.bridged ? `в мосту${inSwitch ? ` коммутатора «${inSwitch.name}»` : ''}: сначала выведите из него` : null;
    const off = a.status === 'Disabled' ? 'адаптер отключён — сначала включите его' : null;

    if (role === 'vnic') why.enable = 'порт коммутатора: из сети его выводят, отключая от коммутатора';
    else if (bridged) why.enable = bridged;
    else can.enable = true;

    if (a.hyperv) why.mac = 'MAC адаптера Hyper-V задаёт Hyper-V';
    else if (bridged) why.mac = bridged;
    else if (off) why.mac = off;
    else if (!a.tap && !a.macSettable) why.mac = 'драйвер адаптера не умеет менять MAC';
    else can.mac = true;

    if (role === 'vnic') can.delete = true;
    else if (a.hyperv) why.delete = 'адаптер Hyper-V удаляется вместе с его коммутатором — в Диспетчере Hyper-V';
    else if (!a.software) why.delete = 'физическую карту Windows найдёт снова при следующем опросе оборудования — её можно отключить';
    else if (bridged) why.delete = bridged;
    else can.delete = true;

    if (a.tap && !this.isCard(a)) {
      if (off) why.move = off;
      else can.move = true;
    } else if (inSwitch) {
      can.unbridge = true;
    } else if (a.bridged) {
      why.move = 'в мосту, собранном не приложением';
    } else {
      const p = this._nicProblem(a);
      if (p) why.move = p;
      else can.bridge = true;
    }
    can.release = Boolean(rec?.adopted);
    return { can, why };
  }

  /** Права на адаптер по нынешнему состоянию — для операций. */
  _rightsNow(a) {
    const ctx = this._context();
    return this._rights(a, this._role(a, ctx), ctx);
  }

  // -------------------------------------------------------- коммутаторы

  /**
   * Новый коммутатор.
   *
   * @param {{ name: string, nics?: string[], ports?: string[], hostAccess?: boolean }} o
   *   nics — GUID карт, которые войдут в мост (пусто — внутренний коммутатор);
   *   ports — GUID уже существующих TAP-адаптеров: своих или чужих, они
   *   станут портами; hostAccess — оставить ли самому компьютеру доступ к
   *   сети карты
   * @returns {Promise<object>} коммутатор и warnings — какие адаптеры не
   *   подключились (сам коммутатор при этом создан)
   */
  createSwitch({ name, nics = [], ports = [], hostAccess = true }) {
    return this._op('создаётся коммутатор', async () => {
      const clean = cleanName(name, 'коммутатор');
      if (this._switchRecs().some((r) => r.name === clean)) throw errWith('exists', `коммутатор «${clean}» уже есть`);
      const rec = { id: crypto.randomBytes(4).toString('hex'), name: clean, nics: [], uplink: null, hostAccess: Boolean(hostAccess), bridgeBefore: null };
      if (nics.length) {
        const adapters = [];
        for (const g of nics) adapters.push(await this._adapter(g));
        await this._buildUplink(rec, adapters);
      }
      this._saveSwitches([...this._switchRecs(), rec]);
      this._startSwitch(rec);
      log.info(`коммутатор «${clean}» создан${rec.nics.length ? ` (сеть карты ${rec.nics.map((n) => n.name).join(', ')})` : ' (внутренний)'}`);
      const warnings = [];
      for (const g of ports) {
        try {
          const a = await this._adapter(g);
          if (!a.tap) throw errWith('bad_request', `«${a.name}» — не TAP-адаптер: его соединяют с коммутатором мостом, как карту`);
          await this._setPort(a, rec.id);
        } catch (e) {
          warnings.push(e.message);
        }
      }
      return { ...this._publicSwitch(rec), warnings };
    });
  }

  /**
   * Выход коммутатора в сеть карты: наш TAP и карта — в мост Windows.
   * Карта ставится первой: MAC моста — MAC первого участника, и тогда
   * компьютер остаётся в сети под MAC своей карты (DHCP выдаст тот же адрес).
   */
  async _buildUplink(rec, adapters) {
    if (this._bridgeSwitchRec()) {
      throw errWith('bridge_busy', `мост Windows уже у коммутатора «${this._bridgeSwitchRec().name}», а мост в Windows один — добавьте карту туда`);
    }
    for (const a of adapters) {
      const why = this._nicProblem(a);
      if (why) throw errWith('forbidden', why);
    }
    const members = await bridgeMembers();
    if (members.length) {
      throw errWith('bridge_foreign', `на компьютере уже есть мост (${members.join(', ')}), собранный не приложением. Мост в Windows один — разберите его в «Сетевых подключениях»`);
    }
    if (!driverFilesPresent()) throw errWith('unavailable', 'нет файлов драйвера TAP (installers/windows/tap-windows6-9.27.0)');

    // Настройки карты — до моста: они переедут на адаптер моста.
    const nicIp = rec.hostAccess ? await readIpConfig(adapters[0].guid).catch(() => null) : null;
    const tap = await createTap();
    this._setTap(tap.guid, { role: 'uplink', switchId: rec.id, last: null });
    try {
      const tapName = friendlyName(`NDS коммутатор — ${rec.name}`);
      if (await renameAdapter(tap.guid, tapName)) tap.name = tapName;
      await bridge([...adapters.map((a) => a.name), tap.name], { hostIp: rec.hostAccess });
      const ba = await bridgeAdapter();
      if (ba) {
        rec.bridgeBefore = { guid: ba.guid, ip: await readIpConfig(ba.guid).catch(() => null) };
        if (rec.hostAccess && nicIp) {
          const r = await applyIpConfig(ba.guid, nicIp);
          if (!r.ok) log.warn(`адрес карты на мост не перенесён: ${r.error}`);
        }
      }
    } catch (e) {
      log.error(`мост коммутатора «${rec.name}» не собран: ${e.message}`);
      await unbridge([tap.name, ...adapters.map((a) => a.name)]).catch(() => {});
      await removeTap(tap.guid).catch(() => {});
      this._dropTap(tap.guid);
      throw e;
    }
    rec.uplink = tap.guid;
    rec.nics = adapters.map((a) => ({ guid: a.guid, name: a.name }));
  }

  /** Разобрать выход в сеть: мост — в исходное, наш TAP — удалить. */
  async _dropUplink(rec) {
    const inv = await this.inventory(true);
    const tapName = inv.adapters.find((a) => a.guid === rec.uplink)?.name;
    const rt = this.switches.get(rec.id);
    const holder = rt?.ports.get(rec.uplink);
    if (holder) { rt.ports.delete(rec.uplink); await this._unplugHolder(holder); }
    if (rec.bridgeBefore?.ip) {
      const now = await readIpConfig(rec.bridgeBefore.guid).catch(() => null);
      if (now) {
        await setBridgeIp(true).catch(() => {});
        await applyIpConfig(rec.bridgeBefore.guid, rec.bridgeBefore.ip).catch(() => {});
      }
    }
    await unbridge([tapName, ...rec.nics.map((n) => inv.adapters.find((a) => a.guid === n.guid)?.name || n.name)].filter(Boolean));
    await removeTap(rec.uplink).catch((e) => log.warn(`адаптер выхода коммутатора не удалён: ${e.message}`));
    this._dropTap(rec.uplink);
  }

  deleteSwitch(id) {
    return this._op('удаляется коммутатор', async () => {
      const rec = this._switchRecs().find((r) => r.id === id);
      if (!rec) throw errWith('not_found', 'коммутатор не найден');
      const lend = this.net.currentLend();
      if (lend?.shared?.id === id) throw errWith('busy', `через коммутатор отдана карта «${lend.nic}» — сначала освободите её`);
      if (rec.uplink) await this._dropUplink(rec);
      // Виртуальные адаптеры остаются — отключёнными, со своими настройками:
      // их можно подключить к другому коммутатору или удалить отдельно.
      // Чужие отпускаются — к своим программам.
      const rt = this.switches.get(id);
      for (const v of this._vnicRecs().filter((r) => r.switchId === id)) {
        const h = rt?.ports.get(v.guid);
        if (h) { rt.ports.delete(v.guid); await this._unplugHolder(h); }
        if (v.adopted) { this._dropTap(v.guid); continue; }
        this._setTap(v.guid, { switchId: null });
        this._plugLoose(v.guid);
      }
      this.switches.delete(id);
      this._saveSwitches(this._switchRecs().filter((r) => r.id !== id));
      log.info(`коммутатор «${rec.name}» удалён`);
      return { ok: true };
    });
  }

  renameSwitch(id, name) {
    return this._op('переименовывается коммутатор', async () => {
      const clean = cleanName(name, 'коммутатор');
      const rec = this._switchRecs().find((r) => r.id === id);
      if (!rec) throw errWith('not_found', 'коммутатор не найден');
      if (this._switchRecs().some((r) => r.id !== id && r.name === clean)) throw errWith('exists', `коммутатор «${clean}» уже есть`);
      if (rec.uplink) await renameAdapter(rec.uplink, friendlyName(`NDS коммутатор — ${clean}`));
      const rt = this.switches.get(id);
      if (rt) rt.sw.name = clean;
      return this._publicSwitch(this._updateSwitch(id, { name: clean }));
    });
  }

  /** Включить карту в коммутатор или вывести из него (мост Windows). */
  setSwitchNic(id, nicGuid, add) {
    return this._op(add ? 'карта включается в коммутатор' : 'карта выводится из коммутатора', async () => {
      return this._switchNic(id, await this._adapter(nicGuid), add);
    });
  }

  async _switchNic(id, a, add) {
    const rec = this._switchRecs().find((r) => r.id === id);
    if (!rec) throw errWith('not_found', 'коммутатор не найден');
    const lend = this.net.currentLend();
    if (lend && lend.nic === a.name) throw errWith('busy', `карта «${a.name}» сейчас отдана — сначала освободите её`);
    if (add) {
      if (rec.nics.some((n) => n.guid === a.guid)) return this._publicSwitch(rec);
      if (!rec.uplink) {
        await this._buildUplink(rec, [a]);
        this._updateSwitch(id, { uplink: rec.uplink, nics: rec.nics, bridgeBefore: rec.bridgeBefore });
        const rt = this.switches.get(id);
        if (rt) this._plug(rt, rec.uplink, `коммутатор «${rec.name}»: выход в сеть`);
      } else {
        const why = this._nicProblem(a);
        if (why) throw errWith('forbidden', why);
        await bridge([a.name], { hostIp: true });
        this._updateSwitch(id, { nics: [...rec.nics, { guid: a.guid, name: a.name }] });
      }
      log.info(`«${a.name}» включена в коммутатор «${rec.name}»`);
    } else {
      if (!rec.nics.some((n) => n.guid === a.guid)) return this._publicSwitch(rec);
      if (lend?.shared?.id === id) throw errWith('busy', `через коммутатор отдана карта «${lend.nic}» — сначала освободите её`);
      if (rec.nics.length === 1) {
        await this._dropUplink(rec);
        this._updateSwitch(id, { uplink: null, nics: [], bridgeBefore: null });
      } else {
        await unbridge([a.name]);
        this._updateSwitch(id, { nics: rec.nics.filter((n) => n.guid !== a.guid) });
      }
      log.info(`«${a.name}» выведена из коммутатора «${rec.name}»`);
    }
    return this._publicSwitch(this._switchRecs().find((r) => r.id === id));
  }

  /** Есть ли у самого компьютера доступ к сети внешнего коммутатора. */
  setHostAccess(id, enabled) {
    return this._op(enabled ? 'компьютер подключается к сети коммутатора' : 'компьютер отключается от сети коммутатора', async () => {
      const rec = this._switchRecs().find((r) => r.id === id);
      if (!rec) throw errWith('not_found', 'коммутатор не найден');
      if (!rec.uplink) throw errWith('bad_request', 'у внутреннего коммутатора нет моста — доступ компьютера к нему даёт виртуальный адаптер');
      await setBridgeIp(Boolean(enabled));
      return this._publicSwitch(this._updateSwitch(id, { hostAccess: Boolean(enabled) }));
    });
  }

  // ------------------------------------------------- виртуальные адаптеры

  /**
   * Новый виртуальный адаптер.
   *
   * @param {object} o
   * @param {string} o.name
   * @param {string|null} [o.switchId] — к какому коммутатору подключить
   * @param {string|null} [o.mac] — 'random', конкретный MAC или пусто (заводской)
   * @param {object|null} [o.ip] — настройки IP (пусто — DHCP)
   * @param {'Private'|'Public'} [o.category]
   */
  createVnic({ name, switchId = null, mac = null, ip = null, category = 'Private' }) {
    return this._op('создаётся виртуальный адаптер', async () => {
      const clean = cleanName(name, 'адаптер');
      const inv = await this.inventory(true);
      if (inv.adapters.some((a) => a.name === clean)) throw errWith('exists', `адаптер «${clean}» уже есть — имена в Windows не повторяются`);
      if (switchId && !this._switchRecs().some((r) => r.id === switchId)) throw errWith('not_found', 'коммутатор не найден');
      const wantMac = mac === 'random' ? randomMac() : (mac ? normalizeMac(mac) || mac : null);
      if (wantMac && macProblem(wantMac)) throw errWith('bad_request', macProblem(wantMac));
      const cfg = ip ? validateIpConfig(ip) : { dhcp: true, addresses: [], gateways: [], dns: [] };
      if (!driverFilesPresent()) throw errWith('unavailable', 'нет файлов драйвера TAP (installers/windows/tap-windows6-9.27.0)');

      const tap = await createTap();
      this._setTap(tap.guid, { role: 'vnic', switchId, category: category === 'Public' ? 'Public' : 'Private', last: null });
      try {
        if (!(await renameAdapter(tap.guid, clean))) throw new Error(`адаптер не переименован в «${clean}»`);
        // MAC — до подъёма: смена перезапускает адаптер.
        if (wantMac) await setTapMac(tap.guid, wantMac);
        const holder = this._replug(tap.guid);
        await holder?.ready;
        // Адрес — на поднятый адаптер: на отключённом netsh отвечает
        // успехом, а адрес не записывает.
        const r = await applyIpConfig(tap.guid, cfg, { dad: 0 });
        if (!r.ok) throw new Error(`настройки IP не применены: ${r.error}`);
      } catch (e) {
        await this._unplug(tap.guid);
        await removeTap(tap.guid).catch(() => {});
        this._dropTap(tap.guid);
        throw e;
      }
      log.info(`виртуальный адаптер «${clean}» создан${switchId ? ` в коммутаторе «${this._switchRecs().find((r) => r.id === switchId)?.name}»` : ''}`);
      setTimeout(() => this._enforceCategories(), 8000).unref?.();
      return { ok: true, guid: tap.guid };
    });
  }

  deleteVnic(guid) {
    return this.deleteAdapter(guid);
  }

  updateVnic(guid, patch) {
    return this.updateAdapter(guid, patch);
  }

  // ---------------------------------------------------- любые адаптеры

  /**
   * Удалить адаптер: свой виртуальный или программный адаптер другой
   * программы (OpenVPN, VirtualBox…). Физическую карту и адаптер Hyper-V —
   * нет (см. _rights).
   */
  deleteAdapter(guid) {
    return this._op('удаляется адаптер', async () => {
      const g = String(guid || '').replace(/[{}]/g, '').toUpperCase();
      const rec = this._vnicRecs().find((r) => r.guid === g);
      let a;
      try {
        a = await this._adapter(g);
      } catch (e) {
        // Свой адаптер уже удалили мимо приложения — осталось забыть запись.
        if (!rec) throw e;
        await this._unplug(g);
        this._dropTap(g);
        return { ok: true };
      }
      const { can, why } = this._rightsNow(a);
      if (!can.delete) throw errWith('forbidden', `«${a.name}» не удалить: ${why.delete || why.manage || 'служебный адаптер'}`);
      await this._unplug(a.guid);
      await removeAdapter(a.guid);
      this._dropTap(a.guid);
      log.info(`адаптер «${a.name}» удалён${rec ? '' : ' (создан не приложением)'}`);
      return { ok: true };
    });
  }

  /**
   * Изменить любой адаптер — свой или чужой: имя, MAC, включён ли,
   * коммутатор. Что с каким адаптером можно — _rights.
   *
   * @param {string} guid
   * @param {{ name?: string, mac?: string|null, enabled?: boolean, switchId?: string|null }} patch
   *   mac: 'random', конкретный MAC или '' — заводской;
   *   switchId: TAP-адаптер становится портом коммутатора (чужой при этом
   *   берётся под управление, а с null — отпускается), остальные входят в
   *   мост внешнего коммутатора, как карта; null — отключить от коммутатора
   */
  updateAdapter(guid, patch) {
    return this._op('меняется адаптер', async () => {
      let a = await this._adapter(guid);
      let { can, why } = this._rightsNow(a);
      const refuse = (k) => errWith('forbidden', `«${a.name}»: ${why[k] || why.manage || 'нельзя'}`);
      const isOn = a.status !== 'Disabled';

      // Включить — первым делом: MAC и порт нужны включённому адаптеру.
      if (patch.enabled === true && !isOn) {
        if (!can.enable) throw refuse('enable');
        await setAdapterEnabled(a.guid, true);
        a = await this._adapter(a.guid);
        ({ can, why } = this._rightsNow(a));
      }
      if (patch.name !== undefined) {
        const clean = cleanName(patch.name, 'адаптер');
        if (clean !== a.name) {
          if (!can.rename) throw refuse('rename');
          if (this.inv.adapters.some((x) => x.name === clean && x.guid !== a.guid)) {
            throw errWith('exists', `адаптер «${clean}» уже есть — имена в Windows не повторяются`);
          }
          await renameAdapter(a.guid, clean, { explain: true });
          log.info(`адаптер «${a.name}» переименован в «${clean}»`);
          a = { ...a, name: clean };
        }
      }
      if (patch.mac !== undefined) {
        if (!can.mac) throw refuse('mac');
        const mac = patch.mac === 'random' ? randomMac() : (patch.mac ? normalizeMac(patch.mac) || patch.mac : null);
        if (mac && macProblem(mac, { tap: a.tap })) throw errWith('bad_request', macProblem(mac, { tap: a.tap }));
        // Смена MAC перезапускает адаптер — посредник на это время снимаем.
        const plugged = Boolean(this._holderOf(a.guid));
        if (plugged) await this._unplug(a.guid);
        try {
          await setAdapterMac(a.guid, mac, { tap: a.tap });
        } finally {
          if (plugged) await this._replug(a.guid)?.ready;
        }
      }
      if (patch.switchId !== undefined) {
        const to = patch.switchId || null;
        if (to && !this._switchRecs().some((r) => r.id === to)) throw errWith('not_found', 'коммутатор не найден');
        if (a.tap && !this.isCard(a)) {
          await this._setPort(a, to);
        } else {
          const cur = this._switchRecs().find((r) => r.nics.some((n) => n.guid === a.guid)) || null;
          if ((cur?.id || null) !== to) {
            if (cur && to) throw errWith('bad_request', `«${a.name}» уже в коммутаторе «${cur.name}» — сначала выведите её оттуда`);
            if (!cur && !can.bridge) throw refuse('move');
            await this._switchNic(cur ? cur.id : to, a, !cur);
          }
        }
      }
      if (patch.enabled === false && isOn) {
        if (!can.enable) throw refuse('enable');
        await setAdapterEnabled(a.guid, false);
      }
      return { ok: true };
    });
  }

  /**
   * TAP-адаптер — портом в коммутатор (to) или из него (null).
   *
   * Чужой TAP при этом берётся под управление: запись с adopted, как у
   * виртуального адаптера. Открыть его может только одна программа, поэтому
   * адаптер, которым пользуется OpenVPN, не откроется — тогда запись
   * убирается, и человек узнаёт почему. Отключённый от коммутатора чужой
   * адаптер отпускается: запись удаляется, адаптер снова свободен.
   */
  async _setPort(a, to) {
    const rec = this._taps().find((r) => r.guid === a.guid);
    if (rec && rec.role !== 'vnic') throw errWith('forbidden', `«${a.name}» — служебный адаптер приложения`);
    if ((rec?.switchId || null) === to) return;
    const sw = to ? this._switchRecs().find((r) => r.id === to) : null;

    if (!rec) {
      const { can, why } = this._rightsNow(a);
      if (!can.move) throw errWith('forbidden', `«${a.name}»: ${why.move || why.manage || 'к коммутатору не подключить'}`);
      this._setTap(a.guid, { role: 'vnic', adopted: true, switchId: to, category: 'Private', last: null });
      const holder = this._replug(a.guid);
      await holder?.ready;
      if (!holder?.relay) {
        await this._unplug(a.guid);
        this._dropTap(a.guid);
        throw errWith('busy', `«${a.name}» не открылся — видимо, им пользуется другая программа (OpenVPN?). `
          + `Закройте её подключение и попробуйте снова (${holder?.failed || 'нет ответа'})`);
      }
      log.info(`TAP-адаптер «${a.name}» (создан не приложением) подключён к коммутатору «${sw.name}»`);
      setTimeout(() => this._enforceCategories(), 8000).unref?.();
      return;
    }

    await this._unplug(a.guid);
    if (!to && rec.adopted) {
      this._dropTap(a.guid);
      log.info(`TAP-адаптер «${a.name}» отпущен: он снова свободен для других программ`);
      return;
    }
    this._setTap(a.guid, { switchId: to });
    await this._replug(a.guid)?.ready;
    log.info(`адаптер «${a.name}» ${sw ? `подключён к коммутатору «${sw.name}»` : 'отключён от коммутатора'}`);
  }

  // ---------------------------------------------------- настройки адаптеров

  /**
   * Настройки IP любого адаптера — с теми ограничениями, что в шапке.
   * Для наших адаптеров заодно запоминается категория сети.
   */
  setAdapterIp(guid, ip, { category } = {}) {
    return this._op('меняются настройки IP', async () => {
      const a = await this._adapter(guid);
      const cfg = validateIpConfig(ip);
      if (a.bridged) {
        throw errWith('forbidden', `«${a.name}» в мосту: её собственный адрес не действует — настройте адаптер моста «${this._bridgeName()}»`);
      }
      if (a.name === this.workingIface()) {
        throw errWith('forbidden', `через «${a.name}» работает приложение: новый адрес оборвёт связь и с узлами, и с этой страницей. Меняйте его на месте, в свойствах Windows`);
      }
      if (a.bridge && a.tcpip === false) {
        throw errWith('forbidden', 'на мосту выключен IP — сначала включите его');
      }
      const borrow = this.net.describe().borrows.find((b) => b.guid === a.guid);
      if (borrow) return this.net.setBorrowIp(borrow.key, cfg, { category });
      const vnic = this._vnicRecs().find((r) => r.guid === a.guid);
      const r = await applyIpConfig(a.guid, cfg, vnic ? { dad: 0 } : {});
      if (!r.ok) throw new Error(`настройки не применены: ${r.error}`);
      if (vnic && category) this._setTap(a.guid, { category });
      else if (category) await ensureCategories([{ guid: a.guid, category }]).catch(() => {});
      if (vnic) this._announceVnic(a.guid, true);
      log.info(`у «${a.name}» новые настройки IP: ${cfg.dhcp ? 'DHCP' : cfg.addresses.map((x) => `${x.address}/${x.prefixLength}`).join(', ')}`);
      return { ok: true, ip: cfg };
    });
  }

  /** Категория сети адаптера: частная или общедоступная. */
  setAdapterCategory(guid, category) {
    return this._op('меняется категория сети', async () => {
      if (category !== 'Private' && category !== 'Public') throw errWith('bad_request', 'категория — Private или Public');
      const a = await this._adapter(guid);
      const borrow = this.net.borrows && [...this.net.borrows.values()].find((b) => b.tap?.guid === a.guid);
      if (borrow) borrow.category = category;
      if (this._vnicRecs().some((r) => r.guid === a.guid)) this._setTap(a.guid, { category });
      const [res] = await ensureCategories([{ guid: a.guid, category }]);
      if (res?.state === 'pending') return { ok: true, pending: true, note: 'Windows ещё опознаёт сеть — категория встанет, как только закончит' };
      if (res?.state === 'none') return { ok: true, pending: true, note: 'у адаптера пока нет сети (кабель не подключён) — категория встанет при подключении' };
      return { ok: true };
    });
  }

  /** IP на адаптере моста: выключить или вернуть. */
  setBridgeHostIp(enabled) {
    return this._op(enabled ? 'на мосту включается IP' : 'на мосту выключается IP', async () => {
      const ba = await bridgeAdapter();
      if (!ba) throw errWith('not_found', 'моста сейчас нет');
      await setBridgeIp(Boolean(enabled));
      const rec = this._bridgeSwitchRec();
      if (rec) this._updateSwitch(rec.id, { hostAccess: Boolean(enabled) });
      return { ok: true };
    });
  }

  _bridgeName() {
    return this.inv.adapters.find((a) => a.bridge)?.name || 'Сетевой мост';
  }

  // ------------------------------------------------------ наблюдение

  /**
   * Держать нашим адаптерам нужную категорию сети. Сразу после появления
   * сети её не сменить — Windows ещё опознаёт, — и после смены адреса или
   * шлюза Windows может счесть сеть новой и снова общедоступной. Поэтому
   * не один раз, а постоянно.
   */
  async _enforceCategories() {
    if (!this.supported || !this.elevated) return;
    const wants = [
      ...this._vnicRecs().filter((r) => r.category || !r.adopted).map((r) => ({ guid: r.guid, category: r.category || 'Private' })),
      ...this.net.categoryWants(),
    ];
    if (!wants.length) return;
    try {
      const res = await ensureCategories(wants);
      for (const r of res.filter((x) => x.state === 'set')) log.info(`адаптеру ${r.guid.slice(0, 8)} поставлена категория сети «${r.now}»`);
      if (res.some((x) => x.state === 'set')) { this.inv.at = 0; this.emit('changed'); }
    } catch (e) {
      log.debug(`категории сети не проверены: ${e.message}`);
    }
  }

  /**
   * Объявить адреса виртуальных адаптеров в их коммутатор. Windows сама
   * этого не делает, а устройства за мостом могли помнить адрес за
   * другим MAC. Смотрим раз в несколько секунд — адрес могли поменять и
   * в свойствах Windows, мимо приложения.
   */
  _watchVnicAddresses() {
    for (const v of this._vnicRecs()) this._announceVnic(v.guid, false);
  }

  _announceVnic(guid, force) {
    const holder = this._holderOf(guid);
    if (!holder?.rt || !holder.relay) return;
    const a = this.inv.adapters.find((x) => x.guid === guid);
    const list = a ? (os.networkInterfaces()[a.name] || []).filter((x) => x.family === 'IPv4' && !x.internal) : [];
    const now = new Set(list.map((x) => x.address).filter((x) => !x.startsWith('169.254.')));
    holder.announced ??= new Set();
    if (force) holder.announced.clear();
    for (const x of [...holder.announced]) if (!now.has(x)) holder.announced.delete(x);
    const mac = macBytes(list[0]?.mac);
    if (!mac) return;
    for (const addr of now) {
      if (holder.announced.has(addr)) continue;
      holder.announced.add(addr);
      const frame = garpFrame(mac, addr);
      for (const delay of [0, 1000, 3000]) {
        setTimeout(() => { if (!holder.stopped) holder.rt?.sw.inject(guid, frame); }, delay).unref?.();
      }
    }
  }

  // ------------------------------------------------------------ карта

  _publicSwitch(rec) {
    if (!rec) return null;
    const rt = this.switches.get(rec.id);
    return {
      id: rec.id,
      name: rec.name,
      external: Boolean(rec.uplink),
      nics: rec.nics,
      uplink: rec.uplink,
      hostAccess: Boolean(rec.hostAccess),
      problem: rt?.problem || null,
      ports: rt ? [...rt.ports.values()].map((h) => ({ guid: h.guid, up: Boolean(h.relay?.ready), failed: h.failed || null })) : [],
      stats: rt ? rt.sw.stats() : null,
    };
  }

  /**
   * Всё, что нужно для карты и настройки: адаптеры с ролями, мост,
   * коммутаторы, пробросы, брони, сетевые экраны.
   */
  async map() {
    if (!this.supported) {
      return { supported: false, reason: 'настройка сети есть только на Windows' };
    }
    const inv = await this.inventory();
    const ctx = this._context();
    const { taps, lendByTap, borrowByTap, devices, working } = ctx;
    const bridgeRec = this._bridgeSwitchRec();
    const members = inv.adapters.filter((a) => a.bridged).map((a) => a.name);

    const adapters = inv.adapters.map((a) => {
      const rec = taps.get(a.guid);
      const lend = lendByTap.get(a.guid) || null;
      const borrow = borrowByTap.get(a.guid) || null;
      const role = this._role(a, ctx);
      const dev = devices.get(a.name) || null;
      const notes = [];
      const { can, why } = this._rights(a, role, ctx);
      if (role === 'borrow' && borrow?.ipApplied && !borrow.ipApplied.ok) notes.push(borrow.ipApplied.error);
      return {
        ...a,
        role,
        // Чужой TAP, подключённый к коммутатору: создан не приложением.
        adopted: Boolean(rec?.adopted),
        working: a.name === working,
        switchId: rec?.switchId || (a.bridged && bridgeRec ? bridgeRec.id : null),
        category: a.profile?.category || null,
        wantCategory: rec?.role === 'vnic' ? (rec.category || (rec.adopted ? null : 'Private')) : borrow?.category || null,
        lend: lend && {
          deviceId: lend.deviceId, nic: lend.nic, connected: lend.connected, shared: lend.shared,
          holderName: devices.get(lend.nic)?.claim?.holderName || null, failed: lend.failed,
        },
        borrow: borrow && {
          key: borrow.key, label: borrow.label, host: borrow.host, connected: borrow.connected,
          ipApplied: borrow.ipApplied, announced: borrow.announced, failed: borrow.failed,
        },
        device: dev && {
          deviceId: dev.deviceId, shared: Boolean(dev.shared), hasTransport: Boolean(dev.hasTransport),
          transportNote: dev.meta?.transportNote || null, claim: dev.claim || null,
          preparing: Boolean(dev.preparing), heldEdit: Boolean(this.config.get('netRestore')?.[dev.deviceId]),
        },
        port: this._holderOf(a.guid) ? { up: Boolean(this._holderOf(a.guid).relay?.ready), failed: this._holderOf(a.guid).failed } : null,
        can,
        why,
        notes,
      };
    });

    const ba = inv.adapters.find((a) => a.bridge) || null;
    const lend = this.net.currentLend();
    return {
      supported: true,
      elevated: this.elevated,
      busy: this.busy,
      working,
      canCreate: this.elevated && driverFilesPresent(),
      createNote: !this.elevated ? 'приложение запущено без прав администратора — сеть можно только смотреть'
        : !driverFilesPresent() ? 'нет файлов драйвера TAP (installers/windows/tap-windows6-9.27.0)' : null,
      adapters,
      bridge: ba || members.length ? {
        present: Boolean(ba),
        guid: ba?.guid || null,
        name: ba?.name || null,
        mac: ba?.mac || null,
        ipEnabled: ba ? ba.tcpip !== false : null,
        members,
        owner: bridgeRec ? { kind: 'switch', id: bridgeRec.id, name: bridgeRec.name }
          : lend ? { kind: 'lend', deviceId: lend.deviceId, nic: lend.nic }
            : { kind: 'foreign' },
      } : null,
      switches: this._switchRecs().map((r) => this._publicSwitch(r)),
      firewall: inv.firewall,
      ts: Date.now(),
    };
  }
}

export { formatMac };
