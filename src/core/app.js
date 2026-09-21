// Сборка приложения: конфигурация, устройства, обнаружение узлов, реестр
// соседей, публикация, занятия, запросы и HTTP-интерфейс.
//
// Здесь же формируется единый снимок состояния — то, что видит пользователь:
// каталог всей сети, склеенный из собственных устройств и данных соседей.
// Каталог состоит из записей двух видов: одиночные устройства и группы,
// внутри которых лежат их устройства. Для интерфейса это один список.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { resolveNetwork, listNetworks } from '../net/interfaces.js';
import { Discovery } from '../net/discovery.js';
import { PeerRegistry } from '../cluster/peers.js';
import { DirectoryService, parseSeed } from '../cluster/directory.js';
import { ShareManager } from './shareManager.js';
import { AttachManager, attachKey } from './attachManager.js';
import { Installer } from './installer.js';
import { Autostart } from './autostart.js';
import { ApiServer } from '../api/httpServer.js';
import { createBackend } from '../devices/backend.js';
import { DeviceHub } from '../devices/hub.js';
import { DEVICE_TYPES, RESERVATION_NOTE, typeInfo } from '../devices/types.js';
import { rpc } from '../net/rpc.js';
import { Realms } from '../net/realms.js';
import { TrafficProxy } from '../net/trafficProxy.js';

const log = logger('app');

export const VERSION = '2.0.0';

const ANNOUNCE_TRANSPORTS = new Set(['both', 'multicast', 'broadcast']);

/**
 * Нижняя граница длины общего ключа.
 *
 * Ключ защищает управление устройствами, и особенно — работу между сетями,
 * где проверки адреса уже нет. Восемь символов мало для настоящей стойкости,
 * но отсекают главное: «1234» и имя отдела, набранные «чтобы просто
 * заработало». Для настоящего ключа в интерфейсе есть кнопка.
 */
const MIN_KEY_LENGTH = 8;

/** Больше горстки кругов доверия на узел — это уже не про удобство. */
const MAX_NETWORKS = 8;

/** Числовая настройка времени: только целое и только в разумных границах. */
function clampMs(target, field, min, max) {
  if (target[field] === undefined) return;
  const value = Number(target[field]);
  if (!Number.isFinite(value)) throw new Error(`${field}: ожидается число`);
  target[field] = Math.min(max, Math.max(min, Math.round(value)));
}

export class App extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    // Круги доверия нужны раньше всего остального: по ним выбирается
    // ключ для любого разговора с другим узлом.
    this.realms = new Realms(config);
    this.version = VERSION;
    this.startedAt = Date.now();
    this.network = null;
    this.backend = null;
    this.backendInfo = null;
    this.hub = null;
    this.share = null;
    this.attach = null;
    this.peers = null;
    this.discovery = null;
    this.directory = null;
    this.api = null;
    this.installer = null;
    this.traffic = null;
    this.autostart = null;
    this.autostartState = null;
    this.stopping = false;
  }

  async start() {
    this.network = resolveNetwork(this.config.get('network'));
    if (!this.network) {
      throw new Error('не найден подходящий сетевой интерфейс IPv4 — проверьте подключение к сети');
    }
    if (this.config.get('network') === 'auto') {
      log.info(`рабочая сеть выбрана автоматически: ${this.network.cidr} (${this.network.iface})`);
    }

    this.backend = await createBackend(this.config.get('backend'), {
      usbipdPath: this.config.get('usbipdPath'),
      usbipPath: this.config.get('usbipPath'),
    });
    this.backendInfo = await this.backend.probe();
    log.info(`бэкенд USB/IP: ${this.backend.name} (раздача: ${this.backendInfo.server ? 'да' : 'нет'}, подключение: ${this.backendInfo.client ? 'да' : 'нет'})`);
    this._explainMockBackend();
    for (const issue of this.backendInfo.issues || []) log.warn(issue);
    for (const note of this.backendInfo.notes || []) log.info(note);

    this.hub = new DeviceHub({
      backend: this.backend,
      enabledTypes: () => this.config.get('enabledTypes') || ['usb'],
    });

    this.installer = new Installer({
      reprobe: () => this.reprobeBackend(),
      backendInfo: () => this.backendInfo,
    });
    await this.installer.init();
    this.installer.on('changed', () => this.api?.pushState());
    this.installer.on('finished', () => this.onStateChanged());
    this._autoInstall();

    this.autostart = new Autostart(this.config);
    // Состояние читается у системы один раз при старте: опрашивать
    // планировщик на каждый снимок незачем, оно меняется только кнопкой.
    this.autostartState = await this.autostart.status().catch((e) => {
      log.warn('состояние автозапуска не прочитано:', e.message);
      return { supported: false, enabled: false, error: e.message };
    });
    log.info(`автозапуск при входе в систему: ${this.autostartState.enabled ? 'включён' : 'выключен'}`);

    await this._startTrafficMeter();

    this.share = new ShareManager({
      hub: this.hub,
      config: this.config,
      // Клиенту сообщается порт счётчика, если он работает, и порт usbipd,
      // если нет. Всё остальное приложение об этой подмене не знает.
      dataPort: () => (this.traffic ? this.config.get('trafficPort') : this.config.get('usbipPort')),
      trafficOf: (deviceId) => (this.traffic ? this.traffic.statsFor(deviceId) : null),
      trafficBegin: (deviceId) => this.traffic?.begin(deviceId),
    });
    this.attach = new AttachManager({
      backend: this.backend,
      config: this.config,
      share: this.share,
      // Ключ зависит от того, в каком круге услышан владелец, поэтому
      // менеджер подключений спрашивает его по узлу, а не хранит у себя.
      keyFor: (nodeId) => this.keyForNode(nodeId),
    });
    this.peers = new PeerRegistry({
      nodeId: this.config.get('nodeId'),
      realms: this.realms,
      peerTimeoutMs: this.config.get('peerTimeoutMs'),
      peerForgetMs: this.config.get('peerForgetMs'),
      announceIntervalMs: this.config.get('announceIntervalMs'),
      gossipIntervalMs: this.config.get('gossipIntervalMs'),
      remotePollIntervalMs: this.config.get('remotePollIntervalMs'),
    });
    this.directory = new DirectoryService({
      peers: this.peers,
      seeds: () => this.config.get('seeds') || [],
      realms: this.realms,
      intervalMs: () => this.config.get('gossipIntervalMs'),
      defaultPort: () => this.config.get('apiPort'),
      selfEntry: () => this._selfEntry(),
    });

    this.share.on('changed', () => this.onStateChanged());
    this.attach.on('changed', () => this.onStateChanged());
    this.peers.on('changed', () => this.api?.pushState());

    // Запрос на нашу же цель адресуем держателю немедленно, не дожидаясь
    // его очередного heartbeat: диалог должен всплыть сразу.
    this.share.on('request-created', (req) => this.pushRequestToHolder(req));

    // Если право на нашу цель отозвано, у держателя надо прекратить и само
    // подключение — иначе в его системе останется устройство в никуда.
    // Счётчики привязаны к сеансу работы: освободили устройство — счёт
    // начинается заново, иначе следующий держатель увидит чужие цифры.
    this.share.on('claim-revoked', ({ deviceId, claim, reason }) => {
      this.traffic?.reset(deviceId);
      const target = claim?.groupId ? `group:${claim.groupId}` : deviceId;
      const selfId = this.config.get('nodeId');

      if (!claim || claim.holderId === selfId) {
        const id = attachKey(selfId, target);
        if (this.attach.attachments.has(id)) {
          this.attach.detach(id, { keepClaim: true }).catch((e) => log.warn(e.message));
        }
        return;
      }
      // Держатель на другом узле: сообщаем ему сразу. Heartbeat донёс бы и
      // сам, но до десяти секунд у него в системе висело бы устройство,
      // которое уже никуда не ведёт.
      this.pushRevocation(claim.holderId, target, reason);
    });

    await this.share.start();
    await this.attach.start();
    this.peers.start();

    this.api = new ApiServer(this);
    await this.api.start();

    this.discovery = new Discovery({
      nodeId: this.config.get('nodeId'),
      network: this.network,
      port: this.config.get('discoveryPort'),
      apiPort: this.config.get('apiPort'),
      usbipPort: this.config.get('usbipPort'),
      realms: this.realms,
      multicastAddress: this.config.get('multicastAddress'),
      announceIntervalMs: this.config.get('announceIntervalMs'),
      announceIdleIntervalMs: this.config.get('announceIdleIntervalMs'),
      announceBackoff: this.config.get('announceBackoff'),
      announceTransport: this.config.get('announceTransport'),
      getSnapshot: () => this._announceSnapshot(),
    });
    this.discovery.on('announce', (m) => {
      this.peers.onAnnounce(m);
      // Сосед объявил непустой отпечаток каталога — значит знает узлы из
      // других сетей, и нам есть что у него забрать.
      this.directory.onAnnounce(m);
    });
    this.discovery.on('bye', (m) => this.peers.onBye(m));
    await this.discovery.start();

    this.directory.on('changed', () => this.onStateChanged());
    this.directory.start();

    log.info(`узел "${this.config.get('name')}" готов; сеть ${this.network.cidr}, адрес ${this.network.address}`);
    return this;
  }

  /**
   * Доустановка недостающих компонентов при запуске.
   *
   * Без драйверов USB/IP приложение поднимается, но не делает главного:
   * устройство не появится в «Диспетчере устройств». Ждать, пока человек
   * найдёт кнопку «Установить», незачем — файлы лежат рядом, суммы и
   * подписи проверяются те же самые.
   *
   * Запуск без ожидания: установка занимает до минуты, а приложение должно
   * подняться сразу. Ход дела виден в интерфейсе и в журнале, по окончании
   * бэкенд перепроверяется сам.
   */
  _autoInstall() {
    if (!this.config.get('autoInstall')) return;
    const plan = this.installer.plan();
    if (!plan.canInstall) {
      const missing = plan.components.filter((c) => !c.installed && !c.fileAvailable);
      for (const c of missing) {
        log.warn(`не хватает ${c.title}, но и установщика нет: ${c.file || c.id}`);
      }
      return;
    }

    const todo = plan.components.filter((c) => c.needed);
    log.info(`доустановка при запуске: ${todo.map((c) => c.title).join(', ')}`);
    this.installer.start().catch((e) => log.error(`доустановка не началась: ${e.message}`));
  }

  /**
   * Дописывает к примечанию об имитации то, чего бэкенд знать не может:
   * откуда взялся режим и как из него выйти.
   *
   * Разница существенная. Флаг запуска пропадёт сам при следующем старте,
   * а запись в файле настроек будет действовать вечно, и совет «уберите
   * флаг» такому пользователю ничем не поможет — убирать нечего.
   */
  _explainMockBackend() {
    if (this.backend.name !== 'mock') return;
    const fromCli = Boolean(this.config.runtimeOverrides?.backend);
    this.backendInfo.notes = [
      ...(this.backendInfo.notes || []),
      fromCli
        ? 'Режим задан флагом --backend mock и действует только на этот запуск: '
          + 'следующий запуск без флага вернёт работу с настоящими устройствами.'
        : `Режим записан в файле настроек (${this.config.file}, поле "backend"). `
          + 'Флага при запуске нет, поэтому убирать нечего: удалите это поле '
          + 'или замените его значение на "auto" и перезапустите приложение.',
    ];
  }

  /**
   * Ключ для разговора с указанным узлом.
   *
   * С соседом говорим ключом того круга, в котором он услышан; с самим
   * собой — любым своим, лишь бы мы же его и приняли: занятие собственного
   * устройства идёт тем же путём по HTTP, что и чужого, и подпись там тоже
   * проверяется.
   */
  keyForNode(nodeId) {
    if (nodeId === this.config.get('nodeId')) return this.realms.self()?.key ?? '';
    const peer = this.peers?.get(nodeId);
    return peer ? this.realms.keyFor(peer.realm) : undefined;
  }

  _announceSnapshot() {
    const shared = this.share.listShared();
    return {
      name: this.config.get('name'),
      version: this.version,
      startedAt: this.startedAt,
      stateHash: this.share.hash(),
      deviceCount: shared.length,
      busyCount: shared.filter((d) => d.claim).length,
      // Непустой отпечаток — приглашение соседям забрать у нас каталог
      // узлов из других сетей.
      dir: this.directory?.hash() || null,
    };
  }

  /**
   * Запись о нас самих для каталога.
   *
   * Адрес здесь наш собственный и таким же уходит дальше по цепочке
   * пересказов: кто бы о нас ни рассказал, обращаться к нам будут напрямую.
   */
  _selfEntry() {
    const shared = this.share?.listShared() || [];
    return {
      nodeId: this.config.get('nodeId'),
      name: this.config.get('name'),
      address: this.network.address,
      apiPort: this.config.get('apiPort'),
      usbipPort: this.config.get('usbipPort'),
      network: this.network.cidr,
      platform: process.platform,
      version: this.version,
      startedAt: this.startedAt,
      stateHash: this.share?.hash() || null,
      deviceCount: shared.length,
      busyCount: shared.filter((d) => d.claim).length,
    };
  }

  onStateChanged() {
    if (this.stopping) return;
    this.discovery?.announce();
    this.api?.pushState();
  }

  async reprobeBackend() {
    this.backendInfo = await this.backend.probe();
    log.info(`окружение перепроверено (раздача: ${this.backendInfo.server ? 'да' : 'нет'}, подключение: ${this.backendInfo.client ? 'да' : 'нет'})`);
    this.onStateChanged();
    return this.backendInfo;
  }

  /**
   * Полное обновление по явной просьбе пользователя.
   *
   * Делает то, чего не делает ни один таймер: перепроверяет окружение
   * USB/IP (вдруг утилиты доставили, не перезапуская приложение) и сверяет
   * список занятий с реальным состоянием VHCI (вдруг кто-то вмешался мимо
   * приложения). Остальное просто случается раньше, чем случилось бы само.
   */
  async refreshAll() {
    await this.reprobeBackend();
    // Кеш медленных источников сбрасываем: нажатие «Обновить» — это просьба
    // посмотреть заново, а не показать то же самое ещё раз.
    this.hub?.invalidateSlow();
    await this.share.refresh();
    await this.attach.reconcile();
    this.discovery?.query();
    this.onStateChanged();
  }

  // ------------------------------------------------------- действия с целями

  /** Собирает всё, что нужно для занятия цели у конкретного узла. */
  _targetInfo(nodeId, target) {
    const selfId = this.config.get('nodeId');

    if (nodeId === selfId) {
      const devices = this._devicesOfTarget(this.share.listShared(), this.share.listGroups(), target);
      if (!devices.length) throw new Error('цель не найдена среди опубликованных');
      return {
        nodeId,
        nodeName: `${this.config.get('name')} (этот компьютер)`,
        host: this.network.address,
        apiPort: this.config.get('apiPort'),
        usbipPort: this.config.get('usbipPort'),
        target,
        kind: target.startsWith('group:') ? 'group' : 'device',
        title: this._targetTitle(this.share.listShared(), this.share.listGroups(), target),
        devices,
      };
    }

    const peer = this.peers.get(nodeId);
    if (!peer) throw new Error('узел-владелец не найден в сети');
    if (!peer.online) throw new Error(`узел "${peer.name}" сейчас недоступен`);

    const devices = this._devicesOfTarget(peer.devices || [], peer.groups || [], target);
    if (!devices.length) throw new Error('цель не найдена у владельца');

    return {
      nodeId,
      nodeName: peer.name,
      host: peer.address,
      apiPort: peer.apiPort,
      usbipPort: peer.usbipPort,
      target,
      kind: target.startsWith('group:') ? 'group' : 'device',
      title: this._targetTitle(peer.devices || [], peer.groups || [], target),
      devices,
    };
  }

  _devicesOfTarget(devices, groups, target) {
    if (String(target).startsWith('group:')) {
      const g = (groups || []).find((x) => `group:${x.id}` === target);
      if (!g) return [];
      return g.members.map((m) => devices.find((d) => d.deviceId === m)).filter(Boolean);
    }
    const d = devices.find((x) => x.deviceId === target);
    return d ? [d] : [];
  }

  _targetTitle(devices, groups, target) {
    if (String(target).startsWith('group:')) {
      const g = (groups || []).find((x) => `group:${x.id}` === target);
      return g ? `группа «${g.name}»` : target;
    }
    const d = devices.find((x) => x.deviceId === target);
    return d ? d.description : target;
  }

  /** Занять цель. force — право владельца забрать своё без спроса. */
  async attachTarget(nodeId, target, { force = false } = {}) {
    const info = this._targetInfo(nodeId, target);

    const needsClient = info.devices.some((d) => d.hasTransport);
    if (needsClient && !this.backendInfo.client) {
      throw new Error('на этом компьютере нет клиентской части USB/IP — подключать устройства невозможно. См. docs/WINDOWS-SETUP.md');
    }

    const r = await this.attach.attach(info, { force });
    const peer = this.peers.get(nodeId);
    if (peer) this.peers.refreshPeerState(peer).catch(() => {});
    this.onStateChanged();
    return r;
  }

  /** Попросить у держателя освободить занятую цель. */
  async requestTarget(nodeId, target, message) {
    const selfId = this.config.get('nodeId');
    if (nodeId === selfId) {
      return this.share.createRequest({
        target,
        requesterId: selfId,
        requesterName: this.config.get('name'),
        message,
      });
    }
    const peer = this.peers.get(nodeId);
    if (!peer) throw new Error('узел-владелец не найден в сети');

    const res = await rpc({
      host: peer.address,
      port: peer.apiPort,
      path: '/api/v1/peer/request',
      method: 'POST',
      body: { target, requesterName: this.config.get('name'), message },
      key: this.realms.keyFor(peer.realm),
      nodeId: selfId,
      timeoutMs: 8000,
    });
    this.peers.refreshPeerState(peer).catch(() => {});
    this.onStateChanged();
    return res;
  }

  /** Ответ на адресованный нам запрос. */
  async answerRequest(requestId, accept) {
    const r = await this.attach.answerRequest(requestId, accept);
    this.onStateChanged();
    return r;
  }

  /**
   * Доставка запроса держателю. Отдельный канал нужен ради скорости:
   * heartbeat донёс бы его и сам, но с задержкой до десяти секунд, а
   * диалог должен всплыть сразу.
   */
  async pushRequestToHolder(req) {
    const selfId = this.config.get('nodeId');
    if (req.holderId === selfId) {
      this.attach.acceptPush(req, {
        nodeId: selfId,
        host: this.network.address,
        apiPort: this.config.get('apiPort'),
      });
      return;
    }
    const peer = this.peers.get(req.holderId);
    if (!peer || !peer.online) {
      log.debug('держатель недоступен, запрос дойдёт с очередным heartbeat');
      return;
    }
    try {
      await rpc({
        host: peer.address,
        port: peer.apiPort,
        path: '/api/v1/peer/notify-request',
        method: 'POST',
        body: { request: req, owner: { nodeId: selfId, host: this.network.address, apiPort: this.config.get('apiPort') } },
        key: this.realms.keyFor(peer.realm),
        nodeId: selfId,
        timeoutMs: 5000,
      });
    } catch (e) {
      log.debug(`мгновенное уведомление держателя не прошло (${e.message}) — дойдёт с heartbeat`);
    }
  }

  /**
   * Запуск счётчика трафика.
   *
   * Неудача здесь не должна мешать работе: без счётчика приложение просто
   * сообщает клиентам порт usbipd напрямую. Цифры активности полезны, но
   * не настолько, чтобы из-за них не заработали устройства.
   */
  async _startTrafficMeter() {
    this.traffic = null;
    if (!this.config.get('meterTraffic')) {
      log.info('учёт трафика выключен настройкой — соединения идут напрямую на usbipd');
      return;
    }
    if (!this.backendInfo.server) {
      log.debug('серверной части USB/IP нет, считать нечего');
      return;
    }

    const proxy = new TrafficProxy({
      listenPort: this.config.get('trafficPort'),
      targetPort: this.config.get('usbipPort'),
      cidr: this.network.cidr,
      // Узлы из других сетей приходят сюда со своих адресов — в рабочую
      // подсеть они не попадают. Пускаем ровно тех, о ком нам рассказали.
      isKnownPeer: (ip) => Boolean(this.peers?.hasAddress(ip)),
    });
    try {
      await proxy.start();
      proxy.on('changed', () => this.api?.pushState());
      // Отказ уже работающего счётчика не должен ронять приложение: просто
      // перестаём считать. Клиенты, уже получившие порт, доработают сеанс.
      proxy.on('failed', (err) => {
        log.error(`счётчик трафика отказал: ${err.message} — учёт отключён`);
        this.traffic = null;
        this.onStateChanged();
      });
      this.traffic = proxy;
    } catch (e) {
      log.warn(`счётчик трафика не запустился (${e.message}) — соединения пойдут напрямую на usbipd`);
      this.traffic = null;
    }
  }

  /**
   * Включение и выключение автозапуска.
   *
   * Состояние после операции перечитывается у системы, а не выводится из
   * намерения: планировщик мог отказать, а показать «включено» на основании
   * нажатой галочки — значит соврать.
   */
  async setAutostart(enabled) {
    this.autostartState = enabled
      ? await this.autostart.enable()
      : await this.autostart.disable();
    this.onStateChanged();
    return this.autostartState;
  }

  /** Сообщить бывшему держателю, что право отозвано. */
  async pushRevocation(holderId, target, reason) {
    const peer = this.peers.get(holderId);
    if (!peer || !peer.online) return;
    try {
      await rpc({
        host: peer.address,
        port: peer.apiPort,
        path: '/api/v1/peer/revoked',
        method: 'POST',
        body: { target, reason },
        key: this.realms.keyFor(peer.realm),
        nodeId: this.config.get('nodeId'),
        timeoutMs: 5000,
      });
    } catch (e) {
      log.debug(`извещение об отзыве не прошло (${e.message}) — держатель узнает по heartbeat`);
    }
  }

  // ----------------------------------------------------------------- настройки

  async applySettings(patch) {
    const before = { ...this.config.data };
    // Круги, в которых мы объявлялись до правки. Снимаем сейчас: realms
    // читает настройки вживую, и после записи прежний состав уже не узнать.
    const wasAnnouncing = this.discovery ? this.realms.announcing().map((r) => ({ realm: r.realm, key: r.key })) : [];
    const allowed = ['name', 'network', 'networks', 'seeOpen', 'showToOpen', 'autoShareNew', 'claimLeaseMs',
      'apiPort', 'discoveryPort', 'usbipPort', 'usbipdPath', 'usbipPath', 'logLevel', 'enabledTypes',
      'meterTraffic', 'trafficPort', 'autoInstall',
      'seeds', 'gossipIntervalMs', 'remotePollIntervalMs', 'announceIntervalMs',
      'announceIdleIntervalMs', 'announceBackoff', 'announceTransport'];
    const clean = {};
    for (const k of allowed) {
      if (patch[k] !== undefined) clean[k] = patch[k];
    }
    if (typeof clean.name === 'string') {
      clean.name = clean.name.trim().slice(0, 64) || before.name;
    }
    if (Array.isArray(clean.enabledTypes)) {
      clean.enabledTypes = clean.enabledTypes.filter((t) => DEVICE_TYPES[t]);
      if (!clean.enabledTypes.length) clean.enabledTypes = ['usb'];
    }
    if (clean.seeds !== undefined) clean.seeds = this._cleanSeeds(clean.seeds);

    if (clean.networks !== undefined) clean.networks = this._cleanNetworks(clean.networks);
    if (clean.seeOpen !== undefined) clean.seeOpen = Boolean(clean.seeOpen);
    if (clean.showToOpen !== undefined) clean.showToOpen = Boolean(clean.showToOpen);
    if (clean.announceTransport !== undefined && !ANNOUNCE_TRANSPORTS.has(clean.announceTransport)) {
      throw new Error(`неизвестный канал анонсов «${clean.announceTransport}»`);
    }
    if (clean.announceBackoff !== undefined) clean.announceBackoff = Boolean(clean.announceBackoff);
    clampMs(clean, 'announceIntervalMs', 1000, 60000);
    clampMs(clean, 'announceIdleIntervalMs', 1000, 600000);
    clampMs(clean, 'gossipIntervalMs', 5000, 3600000);
    clampMs(clean, 'remotePollIntervalMs', 3000, 600000);

    // Медленный темп не может быть быстрее обычного: иначе «в покое»
    // означало бы «чаще», чего никто не ожидает.
    const base = clean.announceIntervalMs ?? before.announceIntervalMs;
    const idle = clean.announceIdleIntervalMs ?? before.announceIdleIntervalMs;
    if (idle < base) {
      throw new Error('интервал в покое не может быть меньше обычного интервала анонсов');
    }

    // Узлы из других сетей без общего ключа не работают, и молча принять
    // такую настройку значит оставить человека с пустым списком и без
    // единой подсказки почему.
    const seedsNow = clean.seeds ?? before.seeds ?? [];
    // Ключ из «--key» здесь тоже считается: он действует только на запуск,
    // но круг доверия задаёт настоящий.
    const networksNow = clean.networks ?? before.networks ?? [];
    const keyedNow = networksNow.filter((n) => n?.key).length || Boolean(this.config.get('preSharedKey'));
    if (seedsNow.length && !keyedNow) {
      throw new Error('для узлов из других сетей нужна сеть с общим ключом — заведите её в этом же окне');
    }

    this.config.set(clean);

    // Пароль удалённого доступа приходит отдельным полем и никогда не
    // хранится открытым.
    if (patch.webPassword !== undefined) {
      this.config.setWebPassword(patch.webPassword || null);
      log.info(patch.webPassword ? 'пароль удалённого доступа установлен' : 'пароль удалённого доступа снят');
    }

    if (clean.logLevel) {
      const { setLevel } = await import('../log.js');
      setLevel(clean.logLevel);
    }

    const needsRestart = ['apiPort', 'discoveryPort', 'usbipPort', 'meterTraffic', 'trafficPort']
      .some((k) => clean[k] !== undefined && clean[k] !== before[k]);

    if (clean.network !== undefined && clean.network !== before.network) {
      const net = resolveNetwork(clean.network);
      if (!net) {
        this.config.set({ network: before.network });
        throw new Error(`сеть ${clean.network} недоступна на этом компьютере`);
      }
      log.info(`рабочая сеть меняется на ${net.cidr} (${net.iface})`);
      this.network = net;
      await this.discovery.stop();
      this.discovery.opts.network = net;
      await this.discovery.start();
    }

    // Темп анонсов меняется на лету: интервал читается при каждом анонсе.
    // А вот канал — это членство в multicast-группе, его без перезапуска
    // сокета не переключить.
    for (const k of ['announceIntervalMs', 'announceIdleIntervalMs', 'announceBackoff']) {
      if (clean[k] !== undefined) this.discovery.opts[k] = clean[k];
    }
    if (clean.announceTransport !== undefined && clean.announceTransport !== before.announceTransport) {
      log.info(`канал анонсов меняется на «${clean.announceTransport}»`);
      await this.discovery.stop();
      this.discovery.opts.announceTransport = clean.announceTransport;
      await this.discovery.start();
    }
    if (clean.announceIntervalMs !== undefined || clean.announceBackoff !== undefined) {
      this.peers.opts.announceIntervalMs = this.config.get('announceIntervalMs');
      this.discovery.announce();
    }

    // Состав кругов доверия применяется сразу, без перезапуска: анонсы
    // читают его при каждой отправке. Забыть чужаков нужно здесь же —
    // сами они провисели бы до истечения таймаута.
    const circlesChanged = ['networks', 'seeOpen', 'showToOpen']
      .some((k) => clean[k] !== undefined && JSON.stringify(clean[k]) !== JSON.stringify(before[k]));
    if (circlesChanged) {
      const mine = this.realms.listening().map((r) => r.realm);
      this.peers.retainRealms(mine);
      const keyed = this.realms.keyed().length;
      log.info(`круги доверия: ключевых сетей ${keyed}`
        + `, узлы без ключа ${this.realms.seeOpen ? 'видим' : 'не видим'}`
        + `, им ${this.realms.showToOpen ? 'видны' : 'не видны'}`);
      if (this.realms.describe().isolated) {
        log.warn('узел не состоит ни в одном круге доверия — он никого не увидит и никому не будет виден');
      }
      // Тем, чей круг мы покинули, говорим об этом сразу, а в оставшихся и
      // новых объявляемся заново и просим соседей представиться.
      const now = new Set(this.realms.announcing().map((r) => r.realm));
      this.discovery.farewell(wasAnnouncing.filter((r) => !now.has(r.realm)));
      this.discovery.refresh();
      this.directory.stop();
      this.directory.start();
    }

    if (clean.remotePollIntervalMs !== undefined && clean.remotePollIntervalMs !== before.remotePollIntervalMs) {
      this.peers.opts.remotePollIntervalMs = clean.remotePollIntervalMs;
      this.peers.retimeRemotePoll();
      log.info(`период опроса узлов из других сетей: ${Math.round(clean.remotePollIntervalMs / 1000)} с`);
    }

    const seedsChanged = clean.seeds !== undefined
      && JSON.stringify(clean.seeds) !== JSON.stringify(before.seeds || []);
    if (seedsChanged || (clean.gossipIntervalMs !== undefined && clean.gossipIntervalMs !== before.gossipIntervalMs)) {
      this.peers.opts.gossipIntervalMs = this.config.get('gossipIntervalMs');
      this.peers.opts.remotePollIntervalMs = this.config.get('remotePollIntervalMs');
      log.info(seedsChanged
        ? `список узлов из других сетей изменён: ${this.config.get('seeds').length} адрес(ов)`
        : 'период обмена каталогом изменён');
      this.directory.stop();
      // Список опустел — значит связь с другими сетями выключают. Оставлять
      // узлы висеть до истечения таймаута нельзя: мы бы ещё минуту
      // рассказывали о них соседям.
      if (!this.config.get('seeds').length) this.peers.forgetRemote();
      this.directory.start();
    }

    if (clean.enabledTypes) await this.share.refresh();
    if (clean.name && clean.name !== before.name) log.info(`имя узла изменено на "${clean.name}"`);

    this.onStateChanged();
    return { ok: true, needsRestart, config: this.publicConfig() };
  }

  /**
   * Разбор и проверка списка ключевых сетей.
   *
   * Ключи сюда приходят открытым текстом — иначе их не задать — и дальше
   * живут только в файле настроек. Наружу отдаются лишь название и
   * отпечаток (см. publicConfig).
   */
  _cleanNetworks(raw) {
    if (!Array.isArray(raw)) throw new Error('список сетей должен быть массивом');
    if (raw.length > MAX_NETWORKS) {
      throw new Error(`сетей не может быть больше ${MAX_NETWORKS}: каждая умножает широковещательный трафик`);
    }

    // Ключи наружу не отдаются, поэтому интерфейс не может прислать их
    // обратно при правке названия. Пустой ключ у сети с известным id
    // означает «оставить прежний» — иначе первое же переименование
    // стирало бы ключ и выбрасывало узел из сети.
    const known = new Map((this.config.get('networks') || []).map((n) => [n.id, n.key]));

    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const key = String(item?.key ?? '').trim() || known.get(item?.id) || '';
      if (!key) continue;
      if (key.length < MIN_KEY_LENGTH) {
        const named = String(item?.label ?? '').trim() || 'без названия';
        throw new Error(`ключ сети «${named}» короче ${MIN_KEY_LENGTH} символов — воспользуйтесь кнопкой «Сгенерировать»`);
      }
      // Два одинаковых ключа — это одна и та же сеть под двумя именами:
      // отпечаток у них общий, и различить их потом будет нечем.
      if (seen.has(key)) {
        throw new Error('две сети с одинаковым ключом — это одна и та же сеть');
      }
      seen.add(key);

      const label = String(item?.label ?? '').trim().slice(0, 48) || `Сеть ${out.length + 1}`;
      const id = typeof item?.id === 'string' && item.id ? item.id : crypto.randomUUID();
      out.push({ id, label, key });
    }
    return out;
  }

  /** Разбор и проверка адресов узлов из других сетей. */
  _cleanSeeds(raw) {
    if (!Array.isArray(raw)) throw new Error('список узлов должен быть массивом адресов');
    const out = [];
    for (const item of raw) {
      const text = String(item ?? '').trim();
      if (!text) continue;
      if (!parseSeed(text, this.config.get('apiPort'))) {
        throw new Error(`адрес «${text}» не разобран — ожидается «хост» или «хост:порт»`);
      }
      if (!out.includes(text)) out.push(text);
    }
    return out;
  }

  publicConfig(access = 'full') {
    const c = this.config.data;
    return {
      // Адреса узлов из других сетей — это карта сети. В режиме
      // только-чтения отдаём лишь их количество.
      seeds: access === 'full' ? (c.seeds || []) : [],
      seedCount: (c.seeds || []).length,
      gossipIntervalMs: c.gossipIntervalMs,
      remotePollIntervalMs: c.remotePollIntervalMs,
      announceIntervalMs: c.announceIntervalMs,
      announceIdleIntervalMs: c.announceIdleIntervalMs,
      announceBackoff: c.announceBackoff,
      announceTransport: c.announceTransport,
      nodeId: c.nodeId,
      name: c.name,
      network: c.network,
      apiPort: c.apiPort,
      discoveryPort: c.discoveryPort,
      usbipPort: c.usbipPort,
      autoShareNew: c.autoShareNew,
      autoInstall: c.autoInstall,
      meterTraffic: c.meterTraffic,
      trafficPort: c.trafficPort,
      enabledTypes: c.enabledTypes,
      claimLeaseMs: c.claimLeaseMs,
      logLevel: c.logLevel,
      // Сами ключи наружу не отдаются никогда — ни при полном доступе,
      // ни тем более при просмотре. Наружу идут название и отпечаток:
      // по отпечатку видно, совпадают ли ключи на двух компьютерах, а
      // восстановить по нему ключ нельзя. Ничего нового он не раскрывает —
      // тот же отпечаток едет в каждом анонсе открытым текстом.
      networks: access === 'full'
        ? this.realms.keyed().filter((n) => n.id !== 'cli')
          .map(({ id, label, realm }) => ({ id, label, realm }))
        : [],
      networkCount: this.realms.keyed().length,
      seeOpen: this.realms.seeOpen,
      showToOpen: this.realms.showToOpen,
      isolated: this.realms.describe().isolated,
      hasWebPassword: this.config.hasWebPassword(),
      usbipdPath: c.usbipdPath || null,
      usbipPath: c.usbipPath || null,
      configFile: this.config.file,
    };
  }

  // ------------------------------------------------------------------ снимок

  /**
   * @param {'full'|'readonly'} access — уровень доступа запрашивающего.
   *   В режиме только для чтения снимок тот же, но интерфейс не покажет
   *   действий; проверка прав на сервере от этого не зависит.
   */
  snapshot(access = 'full') {
    const selfId = this.config.get('nodeId');
    const attachments = this.attach.list();
    const heldByTarget = new Map(attachments.map((a) => [a.id, a]));

    const localDevices = this.share.listAll();
    const localGroups = this.share.listGroups();

    const owners = [{
      nodeId: selfId,
      name: this.config.get('name'),
      address: this.network.address,
      apiPort: this.config.get('apiPort'),
      usbipPort: this.config.get('usbipPort'),
      online: true,
      self: true,
      platform: process.platform,
      startedAt: this.startedAt,
      devices: this.share.listShared(),
      // В каталог идут только опубликованные группы. Неопубликованная —
      // заготовка у владельца: её устройства показываются поодиночке.
      groups: localGroups.filter((g) => g.shared),
    }];
    for (const peer of this.peers.list()) {
      owners.push({
        ...peer,
        self: false,
        devices: peer.devices || [],
        groups: (peer.groups || []).filter((g) => g.shared !== false),
      });
    }

    const catalog = [];
    for (const owner of owners) {
      const grouped = new Set();
      for (const g of owner.groups || []) {
        for (const m of g.members) grouped.add(m);
        const members = g.members
          .map((m) => (owner.devices || []).find((d) => d.deviceId === m))
          .filter(Boolean)
          .map((d) => this._deviceEntry(d, owner, heldByTarget, true));
        catalog.push(this._groupEntry(g, owner, members, heldByTarget));
      }
      for (const d of owner.devices || []) {
        if (grouped.has(d.deviceId)) continue;
        catalog.push(this._deviceEntry(d, owner, heldByTarget, false));
      }
    }

    catalog.sort((a, b) => (a.ownerName || '').localeCompare(b.ownerName || '')
      || (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1)
      || String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));

    // Запросы: адресованные нам (нужен диалог) и наши собственные (нужен ответ).
    const incoming = this.attach.pendingRequests();
    const outgoing = [];
    for (const owner of owners) {
      for (const r of owner.requests || []) {
        if (r.requesterId === selfId) outgoing.push({ ...r, ownerId: owner.nodeId, ownerName: owner.name });
      }
    }
    for (const r of this.share.requestsFor(selfId)) {
      if (r.requesterId === selfId && !outgoing.some((x) => x.id === r.id)) {
        outgoing.push({ ...r, ownerId: selfId, ownerName: this.config.get('name') });
      }
    }

    return {
      access,
      self: {
        nodeId: selfId,
        name: this.config.get('name'),
        platform: process.platform,
        version: this.version,
        startedAt: this.startedAt,
        address: this.network.address,
        iface: this.network.iface,
        network: this.network.cidr,
        apiPort: this.config.get('apiPort'),
        usbipPort: this.config.get('usbipPort'),
        discoveryPort: this.config.get('discoveryPort'),
      },
      backend: {
        name: this.backend.name,
        server: this.backendInfo.server,
        client: this.backendInfo.client,
        tools: this.backendInfo.tools,
        issues: this.backendInfo.issues || [],
        notes: this.backendInfo.notes || [],
      },
      install: this.installer ? this.installer.plan() : null,
      autostart: this.autostartState,
      traffic: {
        enabled: Boolean(this.traffic),
        port: this.traffic ? this.config.get('trafficPort') : null,
        requested: Boolean(this.config.get('meterTraffic')),
      },
      config: this.publicConfig(access),
      networks: listNetworks(),
      deviceTypes: Object.values(DEVICE_TYPES).map((t) => ({ ...t })),
      reservationNote: RESERVATION_NOTE,
      localDevices,
      localGroups,
      catalog,
      requests: { incoming, outgoing },
      peers: this.peers.list().map((p) => ({
        nodeId: p.nodeId,
        name: p.name,
        address: p.address,
        apiPort: p.apiPort,
        platform: p.platform,
        version: p.version,
        online: p.online,
        lastSeen: p.lastSeen,
        startedAt: p.startedAt,
        deviceCount: (p.devices || []).length,
        busyCount: (p.devices || []).filter((d) => d.claim).length,
        stateError: p.stateError || null,
        // Откуда узел известен: из своей подсети или пересказан мостом.
        // Для разбора «почему устройство видно, а занять не выходит» это
        // первое, на что нужно смотреть.
        origin: p.origin,
        network: p.network || null,
        viaName: p.viaName || null,
        // Из какой сети узел. Когда сетей несколько, без подписи в списке
        // не разобрать, почему одно устройство занимается, а другое нет.
        realm: p.realm || null,
        realmLabel: this.realms.labelFor(p.realm),
      })),
      federation: this._federation(access),
      attachments,
      ts: Date.now(),
    };
  }

  /**
   * Состояние обнаружения: темп анонсов и обмен каталогом.
   *
   * Адреса известных узлов — это карта сети, и показывать её в режиме
   * только-чтения незачем; счётчики безобидны и помогают понять, почему
   * список узлов выглядит именно так.
   */
  _federation(access = 'full') {
    const dir = this.directory?.stats() || null;
    return {
      announce: this.discovery?.stats() || null,
      directory: dir && {
        ...dir,
        seeds: access === 'full' ? dir.seeds : [],
      },
      localCount: this.peers.list().filter((p) => p.origin === 'local').length,
      remoteCount: this.peers.list().filter((p) => p.origin !== 'local').length,
    };
  }

  _deviceEntry(d, owner, heldByTarget, inGroup) {
    const selfId = this.config.get('nodeId');
    const target = d.deviceId;
    const held = heldByTarget.get(attachKey(owner.nodeId, target)) || null;
    const info = typeInfo(d.type);
    return {
      kind: 'device',
      id: `${owner.nodeId}|${target}`,
      target,
      inGroup,
      type: d.type,
      typeTitle: info.title,
      icon: d.icon || info.icon,
      title: d.description,
      subtitle: d.title,
      purpose: d.purpose || null,
      hasTransport: d.hasTransport,
      bindState: d.bindState,
      meta: d.meta || {},
      connectedSince: d.connectedSince,
      sharedSince: d.sharedSince,
      lastError: d.lastError || null,
      traffic: d.traffic || null,
      ownerId: owner.nodeId,
      ownerName: owner.name,
      ownerAddress: owner.address,
      ownerOnline: owner.online !== false,
      ownerSelf: owner.nodeId === selfId,
      claim: d.claim || null,
      reservedFor: d.reservedFor || null,
      busy: Boolean(d.claim),
      busyByMe: Boolean(d.claim && d.claim.holderId === selfId),
      attachmentId: held ? held.id : null,
      attachState: held ? held.state : null,
      vhciPort: held ? (held.parts.find((p) => p.vhciPort !== null)?.vhciPort ?? null) : null,
    };
  }

  _groupEntry(g, owner, members, heldByTarget) {
    const selfId = this.config.get('nodeId');
    const target = `group:${g.id}`;
    const held = heldByTarget.get(attachKey(owner.nodeId, target)) || null;
    return {
      kind: 'group',
      id: `${owner.nodeId}|${target}`,
      target,
      groupId: g.id,
      title: g.name,
      purpose: g.description || null,
      members,
      available: g.available !== false,
      partial: Boolean(g.partial),
      traffic: sumTraffic(members),
      ownerId: owner.nodeId,
      ownerName: owner.name,
      ownerAddress: owner.address,
      ownerOnline: owner.online !== false,
      ownerSelf: owner.nodeId === selfId,
      claim: g.claim || null,
      reservedFor: g.reservedFor || null,
      busy: Boolean(g.claim),
      busyByMe: Boolean(g.claim && g.claim.holderId === selfId),
      attachmentId: held ? held.id : null,
      attachState: held ? held.state : null,
      hasTransport: members.some((m) => m.hasTransport),
    };
  }

  async shutdown() {
    if (this.stopping) return;
    this.stopping = true;
    log.info('завершение работы…');

    // Порядок важен: сначала вернуть чужое владельцам, потом перестать
    // анонсироваться, потом закрыть сокеты.
    try {
      await this.attach.detachAll();
    } catch (e) {
      log.warn('не всё удалось освободить:', e.message);
    }

    this.attach?.stop();
    this.share?.stop();
    this.directory?.stop();
    this.peers?.stop();
    await this.discovery?.stop();
    await this.traffic?.stop();
    await this.api?.stop();
    log.info('остановлено');
  }
}

/** Активность группы — сумма по её устройствам: занимается она целиком. */
function sumTraffic(members) {
  const withData = members.filter((m) => m.traffic);
  if (!withData.length) return null;
  return {
    bytesInPerMinute: withData.reduce((a, m) => a + (m.traffic.bytesInPerMinute || 0), 0),
    bytesOutPerMinute: withData.reduce((a, m) => a + (m.traffic.bytesOutPerMinute || 0), 0),
    totalIn: withData.reduce((a, m) => a + (m.traffic.totalIn || 0), 0),
    totalOut: withData.reduce((a, m) => a + (m.traffic.totalOut || 0), 0),
    lastActivity: Math.max(...withData.map((m) => m.traffic.lastActivity || 0)) || null,
  };
}
