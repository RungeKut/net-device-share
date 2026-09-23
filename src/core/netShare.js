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
import { keepRelay } from '../net/relayKeeper.js';
import { listTaps, createTap, renameAdapter, driverFilesPresent, friendlyName } from '../net/tapAdapters.js';
import { bridge, unbridge, bridgeMembers, bridgeAdapter, setBridgeIp } from '../net/bridge.js';
import {
  readIpConfig, applyIpConfig, resetIpConfig, validateIpConfig, BORROWED_METRIC,
} from '../net/ipConfig.js';
import { garpFrame, macBytes } from '../net/vswitch.js';
import { isElevated } from './installer.js';

const log = logger('net-share');

/** Окно учёта скорости — минута, как у счётчика USB/IP. */
const WINDOW_SECONDS = 60;

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
    this.meters = new Map();
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
      this.server.on('connected', () => this.emit('changed'));
      this.server.on('disconnected', () => this.emit('changed'));
    } catch (e) {
      this.serverError = `порт канала ${this.config.get('netLinkPort')} занят: ${e.message}`;
      log.warn(`${this.serverError} — сетевые карты будут только бронироваться`);
      this.server = null;
    }

    this.tickTimer = setInterval(() => this._tick(), 1000);
    this.tickTimer.unref?.();

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
    if (dev.title && dev.title === this.workingIface()) {
      return 'через эту карту работает само приложение: отдав её, компьютер потеряет связь с остальными узлами';
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

  _releaseTap(guid, last) {
    this.busyTaps.delete(guid);
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
  async lend(dev, { holderId, holderAddress = null }) {
    const blocker = this.lendBlocker(dev);
    if (blocker) throw errWith('unavailable', blocker);

    const grant = (l) => ({ port: this.config.get('netLinkPort'), token: l.token, ip: l.ip, ipNote: l.ipNote || null });

    const existing = this.lends.get(dev.deviceId);
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
      holderId, token: null, ip: null, ipNote: null, stopped: false, shared: null, bridge: null,
    };
    this.lends.set(dev.deviceId, lend);
    this._meterBegin(dev.deviceId);

    try {
      // Предыдущая карта могла ещё не вернуться: без ожидания её мост
      // выглядел бы чужим.
      await this.teardowns;
      const members = await bridgeMembers();
      const sw = this.fabric.switchOfNic(nic);
      if (members.length && !(sw && members.includes(nic))) {
        throw errWith('bridge_foreign', `на компьютере уже есть сетевой мост (${members.join(', ')}), `
          + 'собранный не приложением. Мост в Windows один — разберите его в «Сетевых подключениях»');
      }
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

  _openSession(lend, holderId, holderAddress) {
    lend.session = this.server.open({
      relay: lend.relay,
      // Свой же компьютер ходит к себе со своего адреса, а не с петли, —
      // адрес здесь не сужаем.
      allowAddress: holderAddress && !/^127\.|^::1$/.test(holderAddress) ? holderAddress : null,
      label: `карта «${lend.nic}»`,
    });
    lend.token = lend.session.token;
    lend.holderId = holderId;
  }

  /**
   * Вернуть карту владельцу. Держателя отключаем сразу, мост разбирается
   * следом: это десяток секунд, и ждать их незачем ни держателю, ни
   * каталогу. Следующая сборка моста встанет в очередь за разборкой.
   *
   * Вызывается при любом освобождении сетевой карты — и отданной, и
   * забронированной: у брони здесь возвращаются настройки держателя.
   */
  async unlend(dev) {
    if (this.config.get('netRestore')?.[dev.deviceId]) {
      await this._restoreHeld(dev.deviceId).catch((e) => log.error(`настройки карты «${dev.title}» не возвращены: ${e.message}`));
    }
    const lend = this.lends.get(dev.deviceId);
    if (!lend) return { ok: true };
    lend.session?.close();
    lend.session = null;
    const done = this._teardownLend(lend).catch((e) => log.error(`карта «${lend.nic}» не возвращена: ${e.message}`));
    this.teardowns = Promise.all([this.teardowns, done]);
    return { ok: true };
  }

  async _teardownLend(lend) {
    lend.stopped = true;
    lend.session?.close();
    this.lends.delete(lend.deviceId);
    this.meters.delete(lend.deviceId);
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
    if (dev.title === this.workingIface()) {
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
  async borrow({ key, host, port, token, label, ip = null, onStage = () => {} }) {
    const blocker = this.borrowBlocker();
    if (blocker) throw errWith('unavailable', blocker);
    if (this.borrows.has(key)) await this.giveBack(key);

    const b = {
      key, tap: null, relay: null, client: null, stopped: false, label,
      ip, ipApplied: null, category: 'Private', announced: new Set(), watch: null,
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
      }
      this._watchAddresses(b);
      b.watch = setInterval(() => this._watchAddresses(b), ADDRESS_WATCH_MS);
      b.watch.unref?.();

      log.info(`чужая карта подключена как адаптер «${tap.name}»${ip && b.ipApplied.ok ? ', настройки IP перенесены' : ''}`);
      this.emit('changed');
      return { name: tap.name, guid: tap.guid, ip, ipApplied: b.ipApplied };
    } catch (e) {
      await this._stopBorrow(b);
      throw e;
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
  async setBorrowIp(key, cfg, { category } = {}) {
    const b = this.borrows.get(key);
    if (!b?.tap) throw errWith('not_found', 'адаптер этого занятия не найден');
    if (!this.elevated) throw errWith('need_admin', 'приложение запущено без прав администратора — задайте адрес в свойствах адаптера Windows');
    const clean = validateIpConfig(cfg);
    const r = await applyIpConfig(b.tap.guid, clean, { metric: BORROWED_METRIC });
    if (!r.ok) throw new Error(`настройки не применены: ${r.error}`);
    b.ip = clean;
    b.ipApplied = { ok: true, own: true };
    if (category === 'Private' || category === 'Public') b.category = category;
    // Новые адреса объявятся при ближайшем обходе; не ждём его.
    setTimeout(() => this._watchAddresses(b), 1500).unref?.();
    log.info(`у адаптера «${b.tap.name}» новые настройки IP: ${clean.dhcp ? 'DHCP' : clean.addresses.map((a) => `${a.address}/${a.prefixLength}`).join(', ')}`);
    this.emit('changed');
    return { ok: true, ip: clean, ipApplied: b.ipApplied };
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
        connected: Boolean(l.session?.connected()),
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
    this.meters.set(deviceId, {
      ringIn: new Array(WINDOW_SECONDS).fill(0),
      ringOut: new Array(WINDOW_SECONDS).fill(0),
      slot: 0,
      totalIn: 0,
      totalOut: 0,
      seenIn: 0,
      seenOut: 0,
      relay: null,
      lastActivity: null,
    });
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
      m.slot = (m.slot + 1) % WINDOW_SECONDS;
      m.ringIn[m.slot] = dIn;
      m.ringOut[m.slot] = dOut;
      m.totalIn += dIn;
      m.totalOut += dOut;
      if (dIn || dOut) { m.lastActivity = Date.now(); active = true; }
    }
    if (active) this.emit('traffic');
  }

  statsFor(deviceId) {
    const m = this.meters.get(deviceId);
    if (!m) return null;
    const sum = (ring) => ring.reduce((a, b) => a + b, 0);
    const lend = this.lends.get(deviceId);
    return {
      bytesInPerMinute: sum(m.ringIn),
      bytesOutPerMinute: sum(m.ringOut),
      totalIn: m.totalIn,
      totalOut: m.totalOut,
      connections: lend?.session?.connected() ? 1 : 0,
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
    for (const b of [...this.borrows.values()]) await this._stopBorrow(b).catch(() => {});
    for (const l of [...this.lends.values()]) {
      await this._teardownLend(l).catch((e) => log.warn(`при выходе: ${e.message}`));
    }
    for (const deviceId of Object.keys(this.config.get('netRestore') || {})) {
      await this._restoreHeld(deviceId).catch((e) => log.warn(`при выходе: ${e.message}`));
    }
    await this.server?.stop();
  }
}
