// Проброс сетевого интерфейса: карта одного компьютера становится сетевым
// адаптером другого.
//
// Как это устроено (подробно — docs/HANDOVER.md, раздел 8в):
//
//   ВЛАДЕЛЕЦ карты:  физическая карта ═ мост Windows ═ TAP ⇄ посредник ⇄ канал
//   ЗАНЯВШИЙ:                               канал ⇄ посредник ⇄ TAP
//
// Кадры с чужими MAC-адресами в провод вставляет ядро Windows — мостом. Мы
// читаем и пишем только свой TAP-адаптер, поэтому ни Npcap, ни своего
// драйвера не нужно. У занявшего появляется обычный сетевой адаптер: он
// виден в «Диспетчере устройств», получает адрес по DHCP из сети владельца
// или настраивается вручную, как любая карта.
//
// ОГРАНИЧЕНИЯ, КОТОРЫЕ ЗАДАЁТ WINDOWS, А НЕ МЫ:
//
//   Мост на компьютере один. Отдать две карты разом значило бы включить обе
//   в один мост и тем самым слить две сети в одну — ровно то, чего человек,
//   отдающий карты по отдельности, не ждёт. Поэтому у владельца занята
//   может быть только одна карта одновременно. Исключение — карта, уже
//   включённая в коммутатор владельца (core/netManager.js): мост тогда
//   собран заранее, и проброс только добавляет в него свой TAP.
//
//   Мост собирается правами администратора. Приложение и так работает с
//   ними (usbipd без них не публикует устройства), но если нет — карты
//   остаются в режиме брони, а не просят согласия у пустого стола: на
//   стороне владельца занятие приходит из сети, и отвечать на окно UAC
//   там может быть некому.
//
//   MAC карты адаптеру занявшего не присвоить: драйвер TAP принимает только
//   локально администрируемые адреса (см. tapAdapters.js). У занявшего
//   поэтому свой MAC, и устройства, помнящие адрес карты за её MAC, узнают
//   о переезде из объявления адреса (ARP), которое рассылает приложение.
//
// Пока карта отдана, у самого владельца её нет: на адаптере моста IP
// выключен (см. net/bridge.js). Владелец может включить его и задать свой
// адрес, чтобы остаться в той же сети; после освобождения всё, что меняли
// на время, возвращается как было.
//
// БРОНЬ. Карту, которую пробросить нельзя, занимают бронью — работают с ней
// на компьютере владельца (удалённым рабочим столом). Держатель брони может
// поменять ей настройки IP под себя; при освобождении карта получает свои
// прежние настройки обратно, даже если приложение за это время перезапускали.

import os from 'node:os';
import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { LinkServer, LinkClient } from '../net/tapLink.js';
import { keepRelay, plugRelay } from '../net/relayKeeper.js';
import { scanSubnet, suggestNextIp } from '../net/netScan.js';
import { listTaps, createTap, removeTap, renameAdapter, driverFilesPresent, friendlyName } from '../net/tapAdapters.js';
import { bridge, unbridge, bridgeMembers, bridgeAdapter, setBridgeIp, withBridgeLock } from '../net/bridge.js';
import {
  readIpConfig, applyIpConfig, resetIpConfig, validateIpConfig, flushNeighborCache,
  pinNeighbors, validNeighborPair, adapterSnapshot, routeChoice, BORROWED_METRIC,
} from '../net/ipConfig.js';
import { garpFrame, macBytes, VSwitch, SocketPort } from '../net/vswitch.js';
import { isElevated } from './installer.js';

const log = logger('net-share');

/** Окно учёта скорости — минута, как у счётчика USB/IP. */
const WINDOW_SECONDS = 60;

/** Как часто сканировать сеть карты в фоне, и насколько свежим должен быть результат при подключении. */
const SCAN_EVERY_MS = 3 * 60 * 1000;
const SCAN_FRESH_MS = 60 * 1000;

/**
 * Как часто перепроверять выбор маршрута к соседям владельца. Прибор перезагрузили
 * или ARP на мосту сорвался — Windows мог снова увести часть адресов в офисную карту.
 */
const ROUTE_RECHECK_MS = 60000;

/** Как часто смотреть, не появились ли у адаптера занявшего новые адреса. */
const ADDRESS_WATCH_MS = 3000;

function errWith(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Совпадают ли настройки IP по сути (без учёта аренды DHCP). */
function sameIp(a, b) {
  const pick = (x) => JSON.stringify({
    dhcp: Boolean(x?.dhcp),
    addresses: (x?.addresses || []).map((y) => `${y.address}/${y.prefixLength}`).sort(),
    gateways: [...(x?.gateways || [])].sort(),
    dns: [...(x?.dns || [])],
  });
  return pick(a) === pick(b);
}

/** Адреса, которые карта объявляет своими: ручные или выданные по DHCP. */
function ownAddresses(ip) {
  if (!ip) return [];
  if (!ip.dhcp) return (ip.addresses || []).map((a) => a.address);
  return ip.lease?.address ? [ip.lease.address] : [];
}

/** Адрес карты в её сети (ручной или от DHCP) вместе с длиной префикса; null — адреса нет. */
function nicAddress(ip) {
  if (!ip) return null;
  const a = ip.dhcp
    ? (ip.lease?.address ? { address: ip.lease.address, prefixLength: ip.lease.prefixLength } : null)
    : ip.addresses?.[0];
  if (!a?.address || !a.prefixLength || a.address.startsWith('169.254.')) return null;
  return a;
}

export class NetShare extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('../config.js').Config} o.config
   * @param {() => string|null} o.workingIface — имя интерфейса, через который
   *   работает само приложение
   */
  constructor({ config, workingIface }) {
    super();
    this.config = config;
    this.workingIface = workingIface || (() => null);
    this.supported = process.platform === 'win32';
    this.elevated = false;
    this.server = null;
    this.serverError = null;
    /** @type {Map<string, object>} deviceId → отданная карта */
    this.lends = new Map();
    /** @type {Map<string, object>} ключ занятия → взятая карта */
    this.borrows = new Map();
    /** GUID адаптеров, которые сейчас в работе, — чтобы не выдать один дважды. */
    this.busyTaps = new Set();
    /** guid → когда адаптер стал свободным: по этому сроку простаивающие удаляются. */
    this.idleSince = new Map();
    this.reapTimer = null;
    this.meters = new Map();
    /** deviceId → Map(holderId → счётчик) — скорость каждого держателя моста отдельно. */
    this.holderMeters = new Map();
    /** deviceId → { at, address, prefixLength, hosts: [{ip, mac}] } — фоновое сканирование сети карты. */
    this.scans = new Map();
    this.scanning = new Map();
    this.tickTimer = null;
    /** Разборки мостов, которые ещё идут. */
    this.teardowns = Promise.resolve();
    /**
     * Сведения о коммутаторах — их подставляет core/netManager.js. Проброс
     * должен знать, не собран ли мост уже коммутатором, и чей он.
     */
    this.fabric = {
      /** Коммутатор, в мост которого входит карта с этим именем. */
      switchOfNic: () => null,
      /** Коммутатор, которому принадлежит мост Windows, если такой есть. */
      bridgeSwitch: () => null,
    };
  }

  async start() {
    if (!this.supported) return this;
    this.elevated = await isElevated().catch(() => false);

    this.server = new LinkServer({ port: this.config.get('netLinkPort') });
    try {
      await this.server.start();
      this.server.on('connected', ({ deviceId }) => {
        this._cancelTeardownTimer(deviceId);
        this.emit('changed');
      });
      this.server.on('disconnected', ({ deviceId }) => {
        this._scheduleTeardownOnDisconnect(deviceId);
        this.emit('changed');
      });
    } catch (e) {
      this.serverError = `порт канала ${this.config.get('netLinkPort')} занят: ${e.message}`;
      log.warn(`${this.serverError} — сетевые карты будут только бронироваться`);
      this.server = null;
    }

    this.tickTimer = setInterval(() => this._tick(), 1000);
    this.tickTimer.unref?.();
    // Адаптеры, оставшиеся свободными с прошлых запусков (и от версий, которые
    // их не удаляли), получают срок простоя с этой минуты.
    for (const r of this._records()) {
      if (['server', 'client'].includes(r.role)) this.idleSince.set(r.guid, Date.now());
    }
    this.reapTimer = setInterval(() => this._reapTaps().catch((e) => log.warn(`уборка TAP-адаптеров: ${e.message}`)), 30000);
    this.reapTimer.unref?.();

    this._recover();
    return this;
  }

  /**
   * Прошлый запуск завершился, не вернув карту: мост остался собранным, и
   * у владельца до сих пор нет его карты. Разбираем то, что записано. Так
   * же возвращаем настройки брони, которые держатель поменял под себя.
   */
  _recover() {
    if (!this.elevated) return;
    const left = this.config.get('netLent');
    if (left) {
      log.warn(`с прошлого запуска осталась отданная карта «${left.nic}» — возвращаем её системе`);
      this.teardowns = (async () => {
        if (left.shared) {
          await unbridge([left.tap].filter(Boolean));
        } else {
          if (left.bridge?.ip) await this._restoreBridgeIp(left.bridge).catch(() => {});
          await unbridge([left.tap, left.nic].filter(Boolean));
        }
        this.config.set({ netLent: null });
        log.info(`карта «${left.nic}» возвращена`);
      })().catch((e) => log.error(`карту «${left.nic}» вернуть не удалось: ${e.message}`));
    }
    const held = this.config.get('netRestore') || {};
    for (const [deviceId, rec] of Object.entries(held)) {
      log.warn(`с прошлого запуска у карты «${rec.name}» остались настройки держателя брони — возвращаем прежние`);
      this._restoreHeld(deviceId).catch((e) => log.error(`настройки карты «${rec.name}» не возвращены: ${e.message}`));
    }
  }

  // --------------------------------------------------------- доступность

  /**
   * Почему эту карту нельзя пробросить (null — можно).
   * Синхронно: вызывается при каждом опросе устройств.
   */
  lendBlocker(dev) {
    const m = dev.meta || dev.details || {};
    if (!this.supported) return 'проброс сетевых карт пока есть только на Windows';
    if (!m.hardware) return 'это программный адаптер — пробрасывается только настоящая сетевая карта';
    if (m.wireless) return 'Wi-Fi не пропускает кадры с чужими MAC-адресами — пробросить его мостом нельзя';
    if (dev.title && [].concat(this.workingIface() || []).includes(dev.title)) {
      return this.config.get('network') === 'auto'
        ? 'приложение ищет через эту карту узлы (автоматический выбор сетей): отдав её, компьютер потеряет связь с узлами этой сети. '
          + 'Отметьте у карты «Не использовать для обнаружения» или выберите основную сеть вручную в настройках — тогда её можно пробросить'
        : 'через эту карту работает само приложение: отдав её, компьютер потеряет связь с остальными узлами';
    }
    if (!driverFilesPresent()) return 'нет файлов драйвера TAP (installers/windows/tap-windows6-9.27.0)';
    if (!this.elevated) return 'приложение запущено без прав администратора — мост Windows без них не собирается';
    if (!this.server) return this.serverError || 'канал для кадров не запущен';
    const sw = this.fabric.bridgeSwitch();
    if (sw && !this.fabric.switchOfNic(dev.title)) {
      return `мост Windows занят коммутатором «${sw.name}» (карты: ${sw.nics.join(', ') || 'нет'}), а мост в Windows один`;
    }
    return null;
  }

  /** Почему этот компьютер не может занять чужую карту (null — может). */
  borrowBlocker() {
    if (!this.supported) return 'подключать чужие сетевые карты пока можно только на Windows';
    if (!driverFilesPresent()) return 'нет файлов драйвера TAP (installers/windows/tap-windows6-9.27.0)';
    return null;
  }

  isLent(deviceId) {
    return this.lends.has(deviceId);
  }

  // ------------------------------------------------------------ адаптеры

  _records() {
    return this.config.get('tapAdapters') || [];
  }

  /** GUID адаптеров, которые приложение считает своими, — любой роли. */
  ourGuids() {
    return new Set(this._records().map((r) => r.guid));
  }

  /**
   * Свободный TAP-адаптер нужной роли, при необходимости — новый.
   *
   * Роли разделены: адаптер владельца живёт в мосту, клиентский — с
   * настройками IP чужой карты. За целью закрепляется «её» адаптер: занял
   * ту же карту завтра — получил тот же адаптер под тем же именем.
   */
  async _pickTap(role, prefer = null, onStage = () => {}) {
    const present = await listTaps();
    const byGuid = new Map(present.map((t) => [t.guid, t]));
    const records = this._records().filter((r) => byGuid.has(r.guid));
    if (records.length !== this._records().length) this.config.set({ tapAdapters: records });

    const free = records.filter((r) => r.role === role && !this.busyTaps.has(r.guid));
    const chosen = free.find((r) => prefer && r.last === prefer) || free.find((r) => !r.last) || free[0];
    if (chosen) {
      this.busyTaps.add(chosen.guid);
      this.idleSince.delete(chosen.guid);
      return { ...byGuid.get(chosen.guid) };
    }

    if (!(await isElevated().catch(() => false))) {
      throw errWith('need_admin', 'нужен новый сетевой адаптер, а создать его можно только с правами администратора — перезапустите приложение от имени администратора');
    }
    onStage('создаётся сетевой адаптер — в первый раз ставится драйвер, это до минуты');
    const tap = await createTap();
    this.busyTaps.add(tap.guid);
    this.config.set({ tapAdapters: [...this._records(), { guid: tap.guid, role, last: null }] });
    return tap;
  }

  /**
   * Удалить TAP-адаптеры, простоявшие свободными дольше tapIdleMs. Иначе они
   * копились бы в «Сетевых подключениях» после каждого занятия. Роли vnic и
   * uplink принадлежат коммутаторам и здесь не трогаются.
   */
  _removeTap(guid) {
    return removeTap(guid);
  }

  async _reapTaps() {
    const limit = Number(this.config.get('tapIdleMs'));
    if (!this.elevated || !(limit > 0)) return;
    const now = Date.now();
    for (const r of this._records()) {
      if (!['server', 'client'].includes(r.role)) continue;
      if (this.busyTaps.has(r.guid)) continue;
      const since = this.idleSince.get(r.guid);
      if (since === undefined) { this.idleSince.set(r.guid, now); continue; }
      if (now - since < limit) continue;

      // На время удаления адаптер считается занятым: выбрать его заново нельзя.
      this.busyTaps.add(r.guid);
      try {
        await this._removeTap(r.guid);
        this.config.set({ tapAdapters: this._records().filter((x) => x.guid !== r.guid) });
        this.idleSince.delete(r.guid);
        log.info(`свободный TAP-адаптер ${r.guid} удалён (простой больше ${Math.round(limit / 1000)} с)`);
      } catch (e) {
        log.warn(`TAP-адаптер ${r.guid} не удалён: ${e.message}`);
        this.idleSince.set(r.guid, now);   // повторим не раньше чем через срок простоя
      } finally {
        this.busyTaps.delete(r.guid);
      }
    }
  }

  _releaseTap(guid, last) {
    this.busyTaps.delete(guid);
    this.idleSince.set(guid, Date.now());
    if (last === undefined) return;
    this.config.set({
      tapAdapters: this._records().map((r) => (r.guid === guid ? { ...r, last } : r)),
    });
  }

  _keepRelay(holder, guid, label, onRelay) {
    return keepRelay(holder, guid, label, onRelay, (why) => {
      this.emit('lost', { label, reason: why });
      this.emit('changed');
    });
  }

  // ------------------------------------------------------ сторона владельца

  /**
   * Отдать карту держателю: собрать мост с TAP и открыть канал.
   *
   * @param {object} dev — устройство из ShareManager
   * @param {{ holderId: string, holderAddress?: string|null }} holder
   * @returns {Promise<{ port: number, token: string, ip: object|null, ipNote: string|null }>}
   *   ip — настройки IPv4 карты: занявший ставит их своему адаптеру;
   *   ipNote — почему их нет, если их нет
   */
  lend(dev, holder) {
    return withBridgeLock(() => (holder?.mode === 'bridge' ? this._lendBridge(dev, holder) : this._lend(dev, holder)));
  }

  /**
   * Убедиться, что мост свободен для этой карты, и вернуть { members, sw }.
   * Мост, оставшийся от прошлого занятия с недошедшей разборкой, netLent ещё
   * помнит — дочищаем его на месте. Иначе карта блокировалась бы отказом
   * «мост собран не приложением» до перезапуска, хотя мост — наш собственный.
   */
  async _ensureBridgeFree(nic) {
    let members = await bridgeMembers();
    let sw = this.fabric.switchOfNic(nic);
    if (members.length && !(sw && members.includes(nic))) {
      const left = this.config.get('netLent');
      if (left) {
        log.warn(`мост остался от карты «${left.nic}» — досматриваем разборку`);
        if (left.shared) await unbridge([left.tap].filter(Boolean));
        else {
          if (left.bridge?.ip) await this._restoreBridgeIp(left.bridge).catch(() => {});
          await unbridge([left.tap, left.nic].filter(Boolean));
        }
        this.config.set({ netLent: null });
        sw = this.fabric.switchOfNic(nic);
        members = await bridgeMembers();
      }
      if (members.length && !(sw && members.includes(nic))) {
        throw errWith('bridge_foreign', `на компьютере уже есть сетевой мост (${members.join(', ')}), `
          + 'собранный не приложением. Мост в Windows один — разберите его в «Сетевых подключениях»');
      }
    }
    return { members, sw };
  }

  async _lend(dev, { holderId, holderAddress = null }) {
    const blocker = this.lendBlocker(dev);
    if (blocker) throw errWith('unavailable', blocker);

    const grant = (l) => ({ port: this.config.get('netLinkPort'), token: l.token, ip: l.ip, ipNote: l.ipNote || null });

    const existing = this.lends.get(dev.deviceId);
    if (existing?.mode === 'bridge') {
      throw errWith('bridge_busy', `карта «${existing.nic}» подключена в общий мост — целиком её не отдать, пока узлы из него не вышли`);
    }
    if (existing) {
      if (existing.holderId === holderId && existing.session) return grant(existing);
      // Владелец забрал карту у одного держателя и отдаёт другому: мост
      // остаётся, меняется только пропуск — прежний больше не войдёт.
      existing.session?.close();
      this._openSession(existing, holderId, holderAddress);
      log.info(`карта «${existing.nic}» передана другому держателю`);
      return grant(existing);
    }

    const other = [...this.lends.values()][0];
    if (other) {
      throw errWith('bridge_busy', `на этом компьютере уже отдана карта «${other.nic}». Мост в Windows один, `
        + 'и вторая карта в нём слила бы две сети в одну — освободите первую');
    }

    // Запись заводится сразу, до первого ожидания: второе занятие, пришедшее
    // в эти секунды, должно увидеть, что мост уже собирается.
    const nic = dev.title;
    const lend = {
      deviceId: dev.deviceId, nic, nicMac: dev.meta?.mac || null, tap: null, relay: null, session: null,
      holderId, token: null, ip: null, ipNote: null, stopped: false, shared: null, bridge: null, suggested: [],
    };
    this.lends.set(dev.deviceId, lend);
    this._meterBegin(dev.deviceId);

    try {
      // Предыдущая карта могла ещё не вернуться: без ожидания её мост
      // выглядел бы чужим.
      await this.teardowns;
      const { members, sw } = await this._ensureBridgeFree(nic);
      // Карта уже в коммутаторе: мост собран, и на нём живёт сам компьютер.
      // Настройки карты занявшему не отдаём — адрес занят владельцем.
      lend.shared = sw || null;

      // Настройки карты — до моста: занявший поставит их себе. Читаются из
      // реестра, так что и после сборки моста они никуда не денутся, но
      // снимок нужен именно тот, с которым карта работала.
      const guid = dev.meta?.guid || dev.details?.guid;
      if (lend.shared) {
        lend.ipNote = `карта в коммутаторе «${sw.name}» владельца, и её адрес у него занят — задайте свой адрес сами`;
      } else {
        lend.ip = guid ? await readIpConfig(guid).catch((e) => {
          log.warn(`настройки IP карты «${nic}» не прочитаны: ${e.message}`);
          return null;
        }) : null;
      }

      const tap = await this._pickTap('server');
      lend.tap = tap;
      const tapName = friendlyName(`NDS мост — ${nic}`);
      if (await renameAdapter(tap.guid, tapName)) tap.name = tapName;

      // Запись до сборки моста: если приложение упадёт посреди неё, при
      // следующем запуске будет известно, что разбирать.
      this.config.set({ netLent: { nic, tap: tap.name, shared: Boolean(lend.shared) } });
      if (lend.shared) {
        log.info(`карта «${nic}» отдаётся через коммутатор «${sw.name}»: в его мост добавляется «${tap.name}»…`);
        await bridge([tap.name], { hostIp: true });
      } else {
        log.info(`карта «${nic}» отдаётся: мост с «${tap.name}»…`);
        // TAP первым: MAC моста — MAC первого участника, и так он не
        // совпадёт с MAC карты.
        await bridge([tap.name, nic]);
        // Что было на адаптере моста до нас: владелец может поменять это на
        // время, а вернуть надо именно это.
        const ba = await bridgeAdapter().catch(() => null);
        if (ba) {
          lend.bridge = { guid: ba.guid, name: ba.name, ip: await readIpConfig(ba.guid).catch(() => null) };
          this.config.set({ netLent: { nic, tap: tap.name, shared: false, bridge: lend.bridge } });
        }
      }

      await this._keepRelay(lend, tap.guid, `карта «${nic}»`, (relay) => {
        lend.relay = relay;
        lend.session?.setRelay(relay);
      });
      this._openSession(lend, holderId, holderAddress);
      log.info(`карта «${nic}» отдана, канал на порту ${this.config.get('netLinkPort')}`);
      this.emit('changed');
      return grant(lend);
    } catch (e) {
      log.error(`карту «${nic}» отдать не удалось: ${e.message}`);
      await this._teardownLend(lend);
      throw e;
    }
  }

  // ------------------------------------------------ подключение в общий мост

  /**
   * Почему эту карту нельзя подключить в мост (null — можно).
   *
   * Отличие от целиком отданной карты: владелец остаётся в той же сети под
   * своим адресом, поэтому у карты должна быть связь и адрес IPv4, который
   * переедет на мост.
   */
  joinBlocker(dev) {
    const blocker = this.lendBlocker(dev);
    if (blocker) return blocker;
    const m = dev.meta || dev.details || {};
    if (m.status && m.status !== 'Up') return 'у карты нет связи (кабель не подключён) — подключать в мост нечего';
    if (!nicAddress(m.ip)) return 'у карты нет адреса IPv4 — владельцу нечем оставаться в этой сети';
    return null;
  }

  /**
   * Подключить узел в общий мост карты. Первый подключившийся собирает мост:
   * карта и наш TAP в мосту Windows, а адрес владельца с карты переезжает на
   * адаптер моста — он не теряет сеть. Каждый следующий получает свой порт
   * на программном коммутаторе, который сводит всех участников.
   */
  async _lendBridge(dev, { holderId, holderAddress = null }) {
    const blocker = this.joinBlocker(dev);
    if (blocker) throw errWith('unavailable', blocker);

    const existing = this.lends.get(dev.deviceId);
    if (existing) {
      if (existing.mode !== 'bridge') {
        throw errWith('bridge_busy', `карта «${existing.nic}» отдана целиком — в мост её сейчас не подключить`);
      }
      return this._addHolder(existing, dev, holderId, holderAddress);
    }
    const other = [...this.lends.values()][0];
    if (other) {
      throw errWith('bridge_busy', `на этом компьютере уже отдана карта «${other.nic}». Мост в Windows один, `
        + 'и вторая карта в нём слила бы две сети в одну — освободите первую');
    }

    const nic = dev.title;
    const lend = {
      deviceId: dev.deviceId, nic, nicMac: dev.meta?.mac || null, mode: 'bridge',
      tap: null, relay: null, wire: null, sw: new VSwitch({ id: dev.deviceId, name: nic }), holders: new Map(),
      hostIp: null, hostIpApplied: null, holderId: null, token: null, ip: null, ipNote: null,
      stopped: false, shared: null, bridge: null, session: null, suggested: [],
    };
    lend.sw.enableTrace();
    this.lends.set(dev.deviceId, lend);
    this._meterBegin(dev.deviceId);

    try {
      await this.teardowns;
      const { members, sw } = await this._ensureBridgeFree(nic);
      lend.shared = sw || null;

      const guid = dev.meta?.guid || dev.details?.guid;
      // Адрес владельца читается до моста: после сборки он переедет на мост.
      if (!lend.shared) lend.hostIp = guid ? await readIpConfig(guid).catch(() => null) : null;

      const tap = await this._pickTap('server');
      lend.tap = tap;
      const tapName = friendlyName(`NDS мост — ${nic}`);
      if (await renameAdapter(tap.guid, tapName)) tap.name = tapName;

      this.config.set({ netLent: { nic, tap: tap.name, shared: Boolean(lend.shared), mode: 'bridge' } });
      if (lend.shared) {
        log.info(`карта «${nic}» подключается в мост коммутатора «${sw.name}»: добавляется «${tap.name}»…`);
        await bridge([tap.name], { hostIp: true });
      } else {
        log.info(`карта «${nic}» подключается в общий мост: «${nic}» + «${tap.name}», адрес владельца остаётся на мосту…`);
        // Карта первой: MAC моста — её MAC, и компьютер остаётся в сети под
        // прежним адресом (DHCP выдаст тот же).
        await bridge([nic, tap.name], { hostIp: true });
        const ba = await bridgeAdapter().catch(() => null);
        if (ba) {
          lend.bridge = { guid: ba.guid, name: ba.name, ip: await readIpConfig(ba.guid).catch(() => null) };
          if (lend.hostIp) {
            lend.hostIpApplied = await applyIpConfig(ba.guid, lend.hostIp);
            if (!lend.hostIpApplied.ok) log.warn(`адрес карты «${nic}» на мост не перенесён: ${lend.hostIpApplied.error}`);
          }
          this.config.set({ netLent: { nic, tap: tap.name, shared: false, mode: 'bridge', bridge: lend.bridge } });
        }
      }

      await this._keepRelay(lend, tap.guid, `карта «${nic}»`, (relay) => {
        lend.relay = relay;
        lend.wire?.detach();
        lend.wire = plugRelay(lend.sw, 'wire', relay, 'провод');
      });
      const grant = await this._addHolder(lend, dev, holderId, holderAddress);
      log.info(`карта «${nic}» подключена в общий мост, канал на порту ${this.config.get('netLinkPort')}`);
      return grant;
    } catch (e) {
      log.error(`карту «${nic}» в мост подключить не удалось: ${e.message}`);
      await this._teardownLend(lend);
      throw e;
    }
  }

  /** Порт на коммутаторе и пропуск для ещё одного узла. */
  async _addHolder(lend, dev, holderId, holderAddress) {
    this._dropHolder(lend, holderId);
    const port = new SocketPort(lend.sw, `holder:${holderId}`, `узел ${holderId.slice(0, 8)}`);
    const session = this.server.open({
      relay: port,
      allowAddress: holderAddress && !/^127\.|^::1$/.test(holderAddress) ? holderAddress : null,
      label: `карта «${lend.nic}» → ${holderId.slice(0, 8)}`,
      deviceId: lend.deviceId,
    });
    lend.holders.set(holderId, { holderId, port, session });
    const holders = this.holderMeters.get(lend.deviceId) || new Map();
    holders.set(holderId, this._newMeter());
    this.holderMeters.set(lend.deviceId, holders);
    const advice = await this._joinAdvice(lend, dev);
    // Розданный совет запоминаем: следующий держатель получит следующий адрес,
    // а не тот же — иначе двое поставят себе один и получите конфликт IP.
    if (advice.suggest) lend.suggested.push(advice.suggest.address);
    this.emit('changed');
    return {
      port: this.config.get('netLinkPort'), token: session.token, mode: 'bridge',
      ip: advice.dhcp ? { dhcp: true, addresses: [], gateways: [], dns: [] } : null,
      ipNote: advice.note, suggest: advice.suggest, usedIps: advice.used,
      neighbors: advice.neighbors || null,
    };
  }

  _dropHolder(lend, holderId) {
    const h = lend.holders?.get(holderId);
    if (!h) return;
    h.session.close();
    h.port.close();
    lend.holders.delete(holderId);
    this.holderMeters.get(lend.deviceId)?.delete(holderId);
  }

  /**
   * Что сказать подключившемуся про адрес. В сети с DHCP адаптер просто
   * получает его сам. В сети со статикой DHCP, скорее всего, нет — тогда
   * предлагаем свободный адрес следующим за владельцем и показываем, какие
   * заняты.
   */
  async _joinAdvice(lend, dev) {
    const cfg = lend.hostIp || dev.meta?.ip || null;
    const own = nicAddress(cfg);
    if (cfg?.dhcp || !own) return { dhcp: Boolean(cfg?.dhcp), note: null, suggest: null, used: [] };

    const scan = await this._scan(dev, { maxAgeMs: SCAN_FRESH_MS }).catch((e) => {
      log.warn(`сеть карты «${lend.nic}» не просканирована: ${e.message}`);
      return this.scans.get(dev.deviceId) || null;
    });
    const used = (scan?.hosts || []).map((h) => h.ip);
    const ownIps = (cfg.addresses || []).map((a) => a.address);
    const next = suggestNextIp({
      address: own.address, prefixLength: own.prefixLength, used,
      reserved: [...ownIps, ...(cfg.gateways || []), ...(cfg.dns || []), ...(lend.suggested || [])],
    });
    const suggest = next ? { address: next, prefixLength: own.prefixLength, gateways: cfg.gateways || [], dns: cfg.dns || [] } : null;
    const note = `В этой сети у владельца статический адрес ${own.address}/${own.prefixLength}, DHCP, скорее всего, нет. `
      + (next ? `Задайте адаптеру свободный адрес — например, ${next}.` : 'Свободный адрес в подсети не нашёлся — задайте его вручную.');
    // Пары IP→MAC из сканера: держатель закрепит их статическими записями
    // ARP, и гонка «кто быстрее ответил» за спорный адрес ему не страшна.
    const neighbors = (scan?.hosts || []).filter((h) => h.ip && h.mac);
    return { dhcp: false, note, suggest, used, neighbors };
  }

  // -------------------------------------- сканирование занятых адресов в сети

  /**
   * Дополнить устройство тем, что известно из сканирования, и при
   * необходимости запустить новое. Вызывается при каждом опросе устройств,
   * поэтому ничего не ждёт: результат появится при следующем.
   */
  decorate(d) {
    const m = d.meta || {};
    const blocker = this.joinBlocker(d);
    const excluded = (this.config.get('discoveryExclude') || []).includes(d.title);
    const inUse = [].concat(this.workingIface() || []).includes(d.title);
    d.meta = {
      ...m, bridgeJoin: !blocker, joinNote: blocker,
      // Через эту карту приложение сейчас ищет узлы; excluded — карту исключили из обнаружения.
      discoveryUse: inUse, discoveryExcluded: excluded, discoveryAuto: this.config.get('network') === 'auto',
    };
    const scan = this.scans.get(d.deviceId);
    if (scan) d.meta = { ...d.meta, usedIps: scan.hosts.map((h) => h.ip), scannedAt: scan.at };
    if (!blocker) {
      const cfg = this.lends.get(d.deviceId)?.hostIp || m.ip;
      const own = nicAddress(cfg);
      if (own && cfg && !cfg.dhcp) {
        d.meta.staticAddress = { ...own, next: suggestNextIp({
          address: own.address, prefixLength: own.prefixLength,
          used: (scan?.hosts || []).map((h) => h.ip),
          reserved: [...(cfg.addresses || []).map((a) => a.address), ...(cfg.gateways || []), ...(cfg.dns || [])],
        }) };
      }
      if (this.config.isShared(d.deviceId) && (!scan || Date.now() - scan.at > SCAN_EVERY_MS)) {
        this._scan(d, { maxAgeMs: SCAN_EVERY_MS }).catch((e) => log.debug(`сканирование «${d.title}»: ${e.message}`));
      }
    }
    return d;
  }

  /** Просканировать сеть карты (не чаще maxAgeMs; параллельные вызовы делят один запуск). */
  async _scan(dev, { maxAgeMs }) {
    const id = dev.deviceId;
    const cached = this.scans.get(id);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached;
    if (this.scanning.has(id)) return this.scanning.get(id);

    const lend = this.lends.get(id);
    // Пока карта в мосту, адрес владельца живёт на мосту, и соседей надо
    // искать у него. Целиком отданная карта адреса не имеет вовсе.
    if (lend && lend.mode !== 'bridge') return cached || null;
    const cfg = lend?.hostIp || dev.meta?.ip;
    const own = nicAddress(cfg);
    const alias = lend?.bridge?.name || dev.title;
    if (!own) return cached || null;

    const run = (async () => {
      const hosts = await scanSubnet({ alias, address: own.address, prefixLength: own.prefixLength });
      const scan = { at: Date.now(), address: own.address, prefixLength: own.prefixLength, hosts };
      this.scans.set(id, scan);
      return scan;
    })().finally(() => this.scanning.delete(id));
    this.scanning.set(id, run);
    return run;
  }

  _openSession(lend, holderId, holderAddress) {
    lend.session = this.server.open({
      relay: lend.relay,
      // Свой же компьютер ходит к себе со своего адреса, а не с петли, —
      // адрес здесь не сужаем.
      allowAddress: holderAddress && !/^127\.|^::1$/.test(holderAddress) ? holderAddress : null,
      label: `карта «${lend.nic}»`,
      deviceId: lend.deviceId,
    });
    lend.token = lend.session.token;
    lend.holderId = holderId;
  }

  _scheduleTeardownOnDisconnect(deviceId) {
    if (!deviceId) return;
    const lend = this.lends.get(deviceId);
    // У подключения в мост срок держит аренда каждого узла (heartbeat), а не канал.
    if (!lend || lend.mode === 'bridge' || lend.teardownTimer) return;
    lend.teardownTimer = setTimeout(() => {
      lend.teardownTimer = null;
      if (lend.session?.connected()) return;
      log.warn(`держатель карты «${lend.nic}» отключился — разбираем сетевой путь`);
      this.unlend({ deviceId }).catch((e) => log.error(`карта «${lend.nic}» не возвращена: ${e.message}`));
    }, 60000);
    lend.teardownTimer.unref?.();
  }

  _cancelTeardownTimer(deviceId) {
    if (!deviceId) return;
    const lend = this.lends.get(deviceId);
    if (lend?.teardownTimer) {
      clearTimeout(lend.teardownTimer);
      lend.teardownTimer = null;
    }
  }

  /**
   * Вернуть карту владельцу. Держателя отключаем сразу, мост разбирается
   * следом: это десяток секунд, и ждать их незачем ни держателю, ни
   * каталогу. Следующая сборка моста встанет в очередь за разборкой.
   *
   * Вызывается при любом освобождении сетевой карты — и отданной, и
   * забронированной: у брони здесь возвращаются настройки держателя.
   */
  async unlend(dev, holder = {}) {
    if (this.config.get('netRestore')?.[dev.deviceId]) {
      await this._restoreHeld(dev.deviceId).catch((e) => log.error(`настройки карты «${dev.title}» не возвращены: ${e.message}`));
    }
    const lend = this.lends.get(dev.deviceId);
    if (!lend) return { ok: true };
    if (lend.mode === 'bridge' && holder.holderId) {
      this._dropHolder(lend, holder.holderId);
      // Пока в мосту кто-то остался, он живёт: общий мост разбирает последний.
      if (lend.holders.size) {
        this.emit('changed');
        return { ok: true, remaining: lend.holders.size };
      }
    }
    this._cancelTeardownTimer(dev.deviceId);
    lend.session?.close();
    lend.session = null;
    const done = this._teardownLend(lend).catch((e) => log.error(`карта «${lend.nic}» не возвращена: ${e.message}`));
    this.teardowns = Promise.all([this.teardowns, done]);
    return { ok: true };
  }

  async _teardownLend(lend) {
    lend.stopped = true;
    lend.session?.close();
    for (const id of [...(lend.holders?.keys() || [])]) this._dropHolder(lend, id);
    lend.wire?.detach();
    this.lends.delete(lend.deviceId);
    this.meters.delete(lend.deviceId);
    this.holderMeters.delete(lend.deviceId);
    // Устройства стенда помнят адрес карты за MAC адаптера занявшего.
    // Объявление от имени карты возвращает их к ней сразу, а не через
    // время жизни записи ARP — у приборов это бывает и двадцать минут.
    if (!lend.shared && lend.relay && lend.nicMac) {
      const mac = macBytes(lend.nicMac);
      for (const ip of ownAddresses(lend.ip)) if (mac) lend.relay.write(garpFrame(mac, ip));
    }
    await lend.relay?.stop();
    if (lend.tap) {
      try {
        if (lend.shared) {
          await unbridge([lend.tap.name]);
        } else {
          if (lend.bridge?.ip) await this._restoreBridgeIp(lend.bridge);
          await unbridge([lend.tap.name, lend.nic]);
        }
        log.info(`карта «${lend.nic}» возвращена системе`);
      } catch (e) {
        log.error(`мост с картой «${lend.nic}» не разобран: ${e.message}`);
        throw e;
      } finally {
        this._releaseTap(lend.tap.guid);
      }
    }
    this.config.set({ netLent: null });
    this.emit('changed');
  }

  /**
   * Вернуть адаптеру моста настройки IP, которые были до проброса, — если
   * владелец их на время менял. Адаптер моста Windows бывает, что создаёт
   * под прежним GUID, и тогда чужой адрес достался бы следующему мосту.
   */
  async _restoreBridgeIp(saved) {
    const now = await readIpConfig(saved.guid).catch(() => null);
    if (!now || sameIp(now, saved.ip)) return;
    // netsh не видит интерфейс без привязки IP — включаем, пока мост есть.
    await setBridgeIp(true).catch(() => {});
    const r = await applyIpConfig(saved.guid, saved.ip);
    if (r.ok) log.info('настройки IP моста возвращены к прежним');
    else log.warn(`настройки IP моста не возвращены: ${r.error}`);
  }

  /** Отданная сейчас карта, если она есть. */
  currentLend() {
    return [...this.lends.values()][0] || null;
  }

  // --------------------------------------------- бронь: настройки держателя

  /**
   * Держатель брони меняет настройки IP карты владельца под себя.
   *
   * Прежние настройки запоминаются при первой правке — в файле настроек, а
   * не в памяти: приложение могут перезапустить, пока карта занята, а
   * вернуть надо всё равно их. Возвращаются при освобождении (unlend).
   *
   * @param {object} dev — устройство из ShareManager (право держателя
   *   проверяет вызывающий)
   * @param {object} cfg — новые настройки
   */
  async holderSetIp(dev, cfg) {
    if (dev.type !== 'net') throw errWith('bad_request', 'это не сетевая карта');
    if (this.lends.has(dev.deviceId)) {
      throw errWith('forwarded', 'карта проброшена к вам: её адрес задаётся на вашем адаптере, а не у владельца');
    }
    if ([].concat(this.workingIface() || []).includes(dev.title)) {
      throw errWith('forbidden', 'через эту карту работает приложение владельца — менять её настройки по сети нельзя');
    }
    if (!this.elevated) throw errWith('need_admin', 'приложение владельца запущено без прав администратора — настройки карты оно не меняет');
    if (this.fabric.switchOfNic(dev.title)) {
      throw errWith('forbidden', 'карта включена в коммутатор владельца: её адрес задаётся у коммутатора');
    }
    const guid = dev.meta?.guid;
    if (!guid) throw errWith('not_found', 'у карты не прочитан GUID');
    const clean = validateIpConfig(cfg);

    const held = { ...(this.config.get('netRestore') || {}) };
    if (!held[dev.deviceId]) {
      const before = await readIpConfig(guid);
      if (!before) throw new Error('прежние настройки карты не прочитаны — менять не буду, вернуть было бы нечего');
      held[dev.deviceId] = { guid, name: dev.title, ip: before };
      this.config.set({ netRestore: held });
    }
    const r = await applyIpConfig(guid, clean);
    if (!r.ok) throw new Error(`настройки не применены: ${r.error}`);
    log.info(`держатель брони поменял настройки карты «${dev.title}»; при освобождении вернутся прежние`);
    this.emit('changed');
    return { ok: true, ip: clean };
  }

  async _restoreHeld(deviceId) {
    const held = { ...(this.config.get('netRestore') || {}) };
    const rec = held[deviceId];
    if (!rec) return;
    const r = await applyIpConfig(rec.guid, rec.ip);
    if (!r.ok && !/не найден/.test(r.error || '')) throw new Error(r.error);
    delete held[deviceId];
    this.config.set({ netRestore: held });
    log.info(`карте «${rec.name}» возвращены прежние настройки IP`);
    this.emit('changed');
  }

  // ------------------------------------------------------ сторона занявшего

  /**
   * Взять чужую карту: поднять свой TAP-адаптер и соединить его с каналом.
   *
   * @param {object} o
   * @param {string} o.key — ключ занятия (узел + цель + устройство)
   * @param {string} o.host — адрес владельца
   * @param {number} o.port — порт канала у владельца
   * @param {string} o.token — пропуск, выданный владельцем
   * @param {string} o.label — как назвать адаптер: человек увидит это имя
   * @param {object|null} [o.ip] — настройки IPv4 карты владельца
   * @param {(stage: string) => void} [o.onStage] — ход дела для интерфейса
   * @returns {Promise<{ name: string, guid: string, ip: object|null, ipApplied: object }>}
   */
  async borrow({ key, host, port, token, label, ip = null, neighbors = null, onStage = () => {} }) {
    const blocker = this.borrowBlocker();
    if (blocker) throw errWith('unavailable', blocker);
    if (this.borrows.has(key)) await this.giveBack(key);

    const b = {
      key, tap: null, relay: null, client: null, stopped: false, label,
      ip, ipApplied: null, category: 'Private', announced: new Set(), watch: null,
      neighbors: Array.isArray(neighbors) ? neighbors.filter(validNeighborPair) : [],
    };
    this.borrows.set(key, b);
    try {
      onStage('подбирается сетевой адаптер');
      const tap = await this._pickTap('client', key, onStage);
      b.tap = tap;
      const name = friendlyName(label);
      if (await renameAdapter(tap.guid, name)) tap.name = name;

      onStage('адаптер поднимается');
      await this._keepRelay(b, tap.guid, `адаптер «${tap.name}»`, (relay) => {
        b.relay = relay;
        b.client?.setRelay(relay);
      });

      onStage('подключение к карте владельца');
      b.client = new LinkClient({ relay: b.relay, host, port, token, label: `адаптер «${tap.name}»` });
      b.client.on('connected', () => { b.announced.clear(); this.emit('changed'); });
      b.client.on('disconnected', () => this.emit('changed'));
      b.client.on('rejected', () => this.emit('changed'));
      await this._connect(b.client);

      // Настройки — после подключения: объявление адреса должно дойти до
      // устройств стенда, а до подключения ему некуда идти.
      b.ipApplied = { ok: false, error: 'владелец не прислал настройки — задайте адрес сами' };
      if (ip) {
        onStage('перенос настроек IP');
        b.ipApplied = this.elevated
          ? await applyIpConfig(tap.guid, ip, { metric: BORROWED_METRIC })
          : { ok: false, error: 'нет прав администратора — задайте адрес вручную' };
        // Прошлые подключения могли оставить адаптеру чужие MAC-привычки:
        // чистый кэш — заново спросить у сети, кто есть кто.
        if (this.elevated) await flushNeighborCache(tap.guid, ip).catch(() => {});
        // Сканер владельца знает пары IP→MAC его сети: закрепляем их
        // статически — спорный адрес достаётся прибору, а не тому, кто
        // быстрее ответил.
        if (this.elevated && b.neighbors.length) {
          const pinned = await pinNeighbors(tap.guid, b.neighbors);
          if (pinned.ok && pinned.pinned) log.info(`закреплено статических соседей: ${pinned.pinned}`);
          await this._checkRouting(b);
        }
      }
      this._watchAddresses(b);
      b.watch = setInterval(() => this._watchAddresses(b), ADDRESS_WATCH_MS);
      b.watch.unref?.();
      b.routeTimer = setInterval(() => {
        if (this.elevated && b.neighbors.length && b.ipApplied?.ok) this._checkRouting(b);
      }, ROUTE_RECHECK_MS);
      b.routeTimer.unref?.();

      log.info(`чужая карта подключена как адаптер «${tap.name}»${ip && b.ipApplied.ok ? ', настройки IP перенесены' : ''}`);
      this.emit('changed');
      return { name: tap.name, guid: tap.guid, ip, ipApplied: b.ipApplied };
    } catch (e) {
      await this._stopBorrow(b);
      throw e;
    }
  }

  /**
   * Проверить, куда Windows на самом деле шлёт пакеты к соседям владельца.
   *
   * Подсеть адаптера может перекрываться с офисной (маска шире, а в ней — машины
   * с теми же адресами, что у приборов): тогда для части адресов пакет уходит в
   * офисную карту, а не в мост, и «мост собран, но до прибора не дойти». Если
   * такие адреса есть — один раз чистим кэш соседей и закрепляем заново, а что
   * осталось, запоминаем в b.routeWarn: интерфейс скажет об этом человеку.
   */
  async _checkRouting(b) {
    if (b.routeBusy || b.stopped || !b.tap) return;
    b.routeBusy = true;
    try {
      const ips = (b.neighbors || []).map((n) => n.ip);
      let bad = (await routeChoice(b.tap.guid, ips)).filter((r) => !r.onTap);
      if (bad.length) {
        log.warn(`Windows шлёт пакеты к ${bad.length} адресам сети владельца не через «${b.tap.name}»: ${bad.slice(0, 5).map((r) => `${r.ip}→${r.alias}`).join(', ')} — чистим кэш соседей и закрепляем заново`);
        await flushNeighborCache(b.tap.guid, b.ip).catch(() => {});
        await pinNeighbors(b.tap.guid, b.neighbors);
        bad = (await routeChoice(b.tap.guid, bad.map((r) => r.ip))).filter((r) => !r.onTap);
      }
      b.routeWarn = bad.map((r) => ({ ip: r.ip, via: r.alias }));
      // Повторяющуюся картину не повторяем в журнале: пишем, только когда она изменилась.
      const sig = bad.map((r) => `${r.ip}>${r.alias}`).sort().join(',');
      if (bad.length && sig !== b.routeSig) log.warn(`после чистки пакеты к ${bad.map((r) => r.ip).join(', ')} всё ещё идут не через мост (${[...new Set(bad.map((r) => r.alias))].join(', ')}) — см. «Диагностика моста»`);
      if (!bad.length && b.routeSig) log.info('маршруты к соседям владельца снова идут через мост');
      b.routeSig = sig;
    } catch (e) {
      log.debug(`проверка маршрутов моста: ${e.message}`);
      b.routeWarn = b.routeWarn || [];
    } finally {
      b.routeBusy = false;
    }
  }

  /**
   * Первое подключение к каналу — с повторами. Пропуск владелец открывает
   * до ответа на занятие, так что отказ здесь окончателен, а вот сеть
   * между машинами может ответить не с первого раза.
   */
  async _connect(client, attempts = 4) {
    for (let i = 1; ; i++) {
      try {
        await client.start();
        return;
      } catch (e) {
        if (e.code === 'rejected' || i >= attempts) throw e;
        log.debug(`${client.label}: канал не ответил (${e.message}), попытка ${i} из ${attempts}`);
        await new Promise((r) => setTimeout(r, 1500 * i));
      }
    }
  }

  /**
   * Объявить в сеть стенда адреса нашего адаптера.
   *
   * Windows, назначив адрес, сама его не объявляет (проверено: ни одного
   * ARP). А устройства стенда помнят этот адрес за MAC карты владельца —
   * адрес ведь и был её — и слали бы кадры туда, пока запись не устареет.
   * Поэтому следим за адресами адаптера (человек мог добавить свои в
   * свойствах Windows) и каждый новый объявляем трижды: вдруг первое
   * потеряется.
   */
  _watchAddresses(b) {
    if (b.stopped || !b.tap || !b.client?.connected) return;
    const list = (os.networkInterfaces()[b.tap.name] || []).filter((a) => a.family === 'IPv4' && !a.internal);
    const now = new Set(list.map((a) => a.address).filter((a) => !a.startsWith('169.254.')));
    for (const a of [...b.announced]) if (!now.has(a)) b.announced.delete(a);
    const mac = macBytes(list[0]?.mac || b.tap.mac);
    if (!mac) return;
    for (const addr of now) {
      if (b.announced.has(addr)) continue;
      b.announced.add(addr);
      const frame = garpFrame(mac, addr);
      for (const delay of [0, 1000, 3000]) {
        setTimeout(() => { if (!b.stopped) b.client?.inject(frame); }, delay).unref?.();
      }
      log.debug(`адаптер «${b.tap.name}»: адрес ${addr} объявлен в сеть владельца`);
    }
  }

  /**
   * Держатель меняет настройки своего адаптера — того, что стоит за чужой
   * картой. При освобождении адаптер очищается, как и после переноса.
   */
  async setBorrowIp(key, cfg, { category, neighbors = null } = {}) {
    const b = this.borrows.get(key);
    if (!b?.tap) throw errWith('not_found', 'адаптер этого занятия не найден');
    if (!this.elevated) throw errWith('need_admin', 'приложение запущено без прав администратора — задайте адрес в свойствах адаптера Windows');
    const clean = validateIpConfig(cfg);
    const r = await applyIpConfig(b.tap.guid, clean, { metric: BORROWED_METRIC });
    if (!r.ok) throw new Error(`настройки не применены: ${r.error}`);
    // Сменился адрес — прежние ответы сети о чужих MAC ни к чему.
    await flushNeighborCache(b.tap.guid, clean).catch(() => {});
    if (Array.isArray(neighbors)) b.neighbors = neighbors.filter(validNeighborPair);
    if (b.neighbors.length) {
      await pinNeighbors(b.tap.guid, b.neighbors).catch(() => {});
      await this._checkRouting(b);
    }
    b.ip = clean;
    b.ipApplied = { ok: true, own: true };
    if (category === 'Private' || category === 'Public') b.category = category;
    // Новые адреса объявятся при ближайшем обходе; не ждём его.
    setTimeout(() => this._watchAddresses(b), 1500).unref?.();
    log.info(`у адаптера «${b.tap.name}» новые настройки IP: ${clean.dhcp ? 'DHCP' : clean.addresses.map((a) => `${a.address}/${a.prefixLength}`).join(', ')}`);
    this.emit('changed');
    return { ok: true, ip: clean, ipApplied: b.ipApplied, routeWarn: b.routeWarn || [] };
  }

  async giveBack(key) {
    const b = this.borrows.get(key);
    if (!b) return;
    await this._stopBorrow(b);
    log.info(`адаптер «${b.tap?.name}» отключён`);
    this.emit('changed');
  }

  async _stopBorrow(b) {
    b.stopped = true;
    clearInterval(b.watch);
    clearInterval(b.routeTimer);
    this.borrows.delete(b.key);
    b.client?.stop();
    await b.relay?.stop();
    if (!b.tap) return;
    // Чужой адрес на своём адаптере не оставляем: карта вернулась к
    // владельцу, и адрес снова его. Ждать этого освобождению незачем.
    if ((b.ipApplied?.ok || b.ip) && this.elevated) {
      resetIpConfig(b.tap.guid).catch((e) => log.debug(`адаптер «${b.tap.name}» не очищен: ${e.message}`));
    }
    this._releaseTap(b.tap.guid, b.key);
  }

  /**
   * Диагностика общего моста: что реально происходит у владельца (порты
   * коммутатора, таблица MAC, трасса ARP/ICMP/SYN) и у держателя (адреса,
   * маршруты к подсети на всех адаптерах, соседи, выбор интерфейса для адресов
   * из сканера). Для случая «мост собран, а до прибора не дойти»: всё, что нужно,
   * чтобы отличить ARP от маршрутизации и от самого прибора, — здесь.
   */
  async diagnostics() {
    const out = { at: new Date().toISOString(), elevated: this.elevated, lends: [], borrows: [] };
    for (const l of this.lends.values()) {
      out.lends.push({
        nic: l.nic, mode: l.mode || 'exclusive', tap: l.tap?.name || null, nicMac: l.nicMac,
        hostIp: l.hostIp, hostIpApplied: l.hostIpApplied, bridge: l.bridge,
        holders: [...(l.holders?.keys() || [])],
        wire: l.relay ? { ready: Boolean(l.relay.ready), toTap: l.relay.toTap, fromTap: l.relay.fromTap } : null,
        switch: l.sw ? l.sw.diag() : null,
      });
    }
    for (const b of this.borrows.values()) {
      const entry = {
        key: b.key, adapter: b.tap?.name || null, connected: Boolean(b.client?.connected),
        ip: b.ip, ipApplied: b.ipApplied, neighborsFromOwner: b.neighbors?.length || 0,
      };
      if (b.tap?.guid) {
        // Для проверки выбора маршрута берём несколько адресов соседей владельца: по ним видно, куда уйдёт пакет.
        const probe = (b.neighbors || []).map((n) => n.ip).slice(0, 5);
        entry.windows = await adapterSnapshot(b.tap.guid, probe).catch((e) => ({ error: e.message }));
      }
      out.borrows.push(entry);
    }
    return out;
  }

  /** Состояние взятой карты — для интерфейса. */
  borrowState(key) {
    const b = this.borrows.get(key);
    if (!b) return null;
    return {
      adapter: b.tap?.name || null,
      guid: b.tap?.guid || null,
      connected: Boolean(b.client?.connected),
      failed: b.failed || null,
      ip: b.ip,
      ipApplied: b.ipApplied,
      category: b.category,
      routeWarn: b.routeWarn || [],
    };
  }

  /** Какую категорию сети держать у наших адаптеров (см. ensureCategories). */
  categoryWants() {
    return [...this.borrows.values()]
      .filter((b) => b.tap && !b.stopped)
      .map((b) => ({ guid: b.tap.guid, category: b.category }));
  }

  /** Для карты сети: что отдано и что взято. */
  describe() {
    return {
      lends: [...this.lends.values()].map((l) => ({
        deviceId: l.deviceId,
        nic: l.nic,
        tap: l.tap ? { name: l.tap.name, guid: l.tap.guid } : null,
        holderId: l.holderId,
        connected: l.mode === 'bridge' ? [...l.holders.values()].some((h) => h.session.connected()) : Boolean(l.session?.connected()),
        mode: l.mode || 'exclusive',
        holders: l.mode === 'bridge' ? [...l.holders.keys()] : undefined,
        shared: l.shared ? { id: l.shared.id, name: l.shared.name } : null,
        failed: l.failed || null,
      })),
      borrows: [...this.borrows.values()].map((b) => ({
        key: b.key,
        label: b.label,
        adapter: b.tap?.name || null,
        guid: b.tap?.guid || null,
        connected: Boolean(b.client?.connected),
        host: b.client?.host || null,
        ip: b.ip,
        ipApplied: b.ipApplied,
        category: b.category,
        announced: [...b.announced],
        failed: b.failed || null,
      })),
    };
  }

  // ------------------------------------------------------------- учёт

  _meterBegin(deviceId) {
    this.meters.set(deviceId, this._newMeter());
  }

  _newMeter() {
    return {
      ringIn: new Array(WINDOW_SECONDS).fill(0),
      ringOut: new Array(WINDOW_SECONDS).fill(0),
      slot: 0,
      totalIn: 0,
      totalOut: 0,
      seenIn: 0,
      seenOut: 0,
      relay: null,
      lastActivity: null,
    };
  }

  /** Один шаг кольцевого счётчика. Возвращает true, если в эту секунду был обмен. */
  _meterAdd(m, dIn, dOut) {
    m.slot = (m.slot + 1) % WINDOW_SECONDS;
    m.ringIn[m.slot] = dIn;
    m.ringOut[m.slot] = dOut;
    m.totalIn += dIn;
    m.totalOut += dOut;
    if (!dIn && !dOut) return false;
    m.lastActivity = Date.now();
    return true;
  }

  /**
   * Раз в секунду снимаем показания посредника. Считать каждый кусок кадров
   * в момент прохода незачем: посредник и так ведёт счёт.
   *
   * «Принято» — то, что пришло от держателя и ушло в провод владельца;
   * «передано» — обратное. Так же считает счётчик USB/IP.
   */
  _tick() {
    let active = false;
    for (const [deviceId, m] of this.meters) {
      const lend = this.lends.get(deviceId);
      const relay = lend?.relay;
      if (!relay) continue;
      if (m.relay !== relay) { m.relay = relay; m.seenIn = relay.toTap; m.seenOut = relay.fromTap; }
      const dIn = relay.toTap - m.seenIn;
      const dOut = relay.fromTap - m.seenOut;
      m.seenIn = relay.toTap;
      m.seenOut = relay.fromTap;
      if (this._meterAdd(m, dIn, dOut)) active = true;

      // Скорость каждого держателя моста — по его порту в коммутаторе:
      // rx — от держателя в сеть карты, tx — обратно. У целиком отданной
      // карты личных счётчиков нет: держатель один, общая цифра и есть его.
      for (const [holderId, hm] of this.holderMeters.get(deviceId) || []) {
        const p = lend.sw?.statsOf(`holder:${holderId}`);
        if (!p) continue;
        const hin = p.rx - hm.seenIn;
        const hout = p.tx - hm.seenOut;
        hm.seenIn = p.rx;
        hm.seenOut = p.tx;
        if (this._meterAdd(hm, hin, hout)) active = true;
      }
    }
    if (active) this.emit('traffic');
  }

  statsFor(deviceId, holderId = null) {
    const m = holderId
      ? this.holderMeters.get(deviceId)?.get(holderId)
      : this.meters.get(deviceId);
    if (!m) {
      // Личного счётчика нет (карта отдана целиком, держатель только что
      // подключился) — общая цифра карты честнее пустой.
      return holderId ? this.statsFor(deviceId) : null;
    }
    const lend = this.lends.get(deviceId);
    const sum = (ring) => ring.reduce((a, b) => a + b, 0);
    return {
      bytesInPerMinute: sum(m.ringIn),
      bytesOutPerMinute: sum(m.ringOut),
      totalIn: m.totalIn,
      totalOut: m.totalOut,
      connections: holderId
        ? (lend?.holders.get(holderId)?.session.connected() ? 1 : 0)
        : lend?.mode === 'bridge'
          ? [...lend.holders.values()].filter((h) => h.session.connected()).length
          : (lend?.session?.connected() ? 1 : 0),
      lastActivity: m.lastActivity,
    };
  }

  // ---------------------------------------------------------- завершение

  /**
   * Всё вернуть: свои карты — системе, чужие — владельцам. Мост разбирается
   * с ожиданием: оставить карту в мосту при выходе значит оставить
   * компьютер без неё до следующего запуска. Настройки брони — тоже.
   */
  async stop() {
    clearInterval(this.tickTimer);
    clearInterval(this.reapTimer);
    for (const b of [...this.borrows.values()]) await this._stopBorrow(b).catch(() => {});
    for (const l of [...this.lends.values()]) {
      this._cancelTeardownTimer(l.deviceId);
      await this._teardownLend(l).catch((e) => log.warn(`при выходе: ${e.message}`));
    }
    for (const deviceId of Object.keys(this.config.get('netRestore') || {})) {
      await this._restoreHeld(deviceId).catch((e) => log.warn(`при выходе: ${e.message}`));
    }
    await this.server?.stop();
  }
}
