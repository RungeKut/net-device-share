// Сборка приложения: конфигурация, бэкенд USB/IP, обнаружение узлов,
// реестр соседей, публикация, подключения и HTTP-интерфейс.
//
// Здесь же формируется единый снимок состояния — то, что видит пользователь:
// каталог устройств всей сети, склеенный из собственных устройств и данных,
// полученных от соседей.

import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { resolveNetwork, listNetworks } from '../net/interfaces.js';
import { Discovery } from '../net/discovery.js';
import { PeerRegistry } from '../cluster/peers.js';
import { ShareManager } from './shareManager.js';
import { AttachManager } from './attachManager.js';
import { Installer } from './installer.js';
import { ApiServer } from '../api/httpServer.js';
import { createBackend } from '../usb/backend.js';
import { deviceKey } from '../net/protocol.js';

const log = logger('app');

export const VERSION = '1.0.0';

export class App extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.version = VERSION;
    this.startedAt = Date.now();
    this.network = null;
    this.backend = null;
    this.backendInfo = null;
    this.share = null;
    this.attach = null;
    this.peers = null;
    this.discovery = null;
    this.api = null;
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
    for (const issue of this.backendInfo.issues) log.warn(issue);

    this.installer = new Installer({
      reprobe: () => this.reprobeBackend(),
      backendInfo: () => this.backendInfo,
    });
    await this.installer.init();
    this.installer.on('changed', () => this.api?.pushState());
    this.installer.on('finished', () => this.onStateChanged());

    const plan = this.installer.plan();
    if (plan.canInstall) {
      log.info(`недостающие компоненты можно установить из папки installers: ${
        plan.components.filter((c) => c.needed).map((c) => c.id).join(', ')}`);
    }

    this.share = new ShareManager({ backend: this.backend, config: this.config });
    this.attach = new AttachManager({ backend: this.backend, config: this.config, share: this.share });
    this.peers = new PeerRegistry({
      nodeId: this.config.get('nodeId'),
      preSharedKey: this.config.get('preSharedKey'),
      peerTimeoutMs: this.config.get('peerTimeoutMs'),
      peerForgetMs: this.config.get('peerForgetMs'),
    });

    this.share.on('changed', () => this.onStateChanged());
    this.attach.on('changed', () => this.onStateChanged());
    this.peers.on('changed', () => this.api?.pushState());

    // Если у соседа отобрали право на наше устройство, у него же надо
    // прекратить и само подключение — иначе в его системе останется
    // «висящее» устройство, которое уже никуда не ведёт.
    this.share.on('claim-revoked', ({ busid }) => {
      const id = deviceKey(this.config.get('nodeId'), busid);
      if (this.attach.attachments.has(id)) {
        this.attach.detach(id, { keepClaim: true }).catch((e) => log.warn(e.message));
      }
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
      multicastAddress: this.config.get('multicastAddress'),
      announceIntervalMs: this.config.get('announceIntervalMs'),
      preSharedKey: this.config.get('preSharedKey'),
      getSnapshot: () => this._announceSnapshot(),
    });
    this.discovery.on('announce', (m) => this.peers.onAnnounce(m));
    this.discovery.on('bye', (m) => this.peers.onBye(m));
    await this.discovery.start();

    log.info(`узел "${this.config.get('name')}" готов; сеть ${this.network.cidr}, адрес ${this.network.address}`);
    return this;
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
    };
  }

  /** Состояние изменилось: анонсируем соседям и обновляем UI. */
  onStateChanged() {
    if (this.stopping) return;
    this.discovery?.announce();
    this.api?.pushState();
  }

  /**
   * Перечитать окружение USB/IP. Нужна после установки компонентов: пути к
   * утилитам бэкенд кеширует при первой проверке, и без повторной пробы
   * приложение продолжало бы считать, что ничего не установлено.
   */
  async reprobeBackend() {
    this.backendInfo = await this.backend.probe();
    log.info(`окружение перепроверено (раздача: ${this.backendInfo.server ? 'да' : 'нет'}, подключение: ${this.backendInfo.client ? 'да' : 'нет'})`);
    this.onStateChanged();
    return this.backendInfo;
  }

  async refreshAll() {
    await this.reprobeBackend();
    await this.share.refresh();
    await this.attach.reconcile();
    this.discovery?.query();
    this.onStateChanged();
  }

  /** Занять и подключить устройство из общего каталога. */
  async attachDevice(nodeId, busid) {
    if (!this.backendInfo.client) {
      throw new Error('на этом компьютере нет клиентской части USB/IP — подключать устройства невозможно. См. docs/WINDOWS-SETUP.md');
    }

    // Собственное устройство: адрес берём из своего интерфейса. Занимать
    // своё устройство разрешено намеренно — остальные увидят его занятым.
    if (nodeId === this.config.get('nodeId')) {
      const dev = this.share.listAll().find((d) => d.busid === busid);
      if (!dev) throw new Error('устройство не найдено');
      if (!dev.shared) throw new Error('сначала опубликуйте устройство');
      const r = await this.attach.attach({
        nodeId,
        nodeName: `${this.config.get('name')} (этот компьютер)`,
        host: this.network.address,
        apiPort: this.config.get('apiPort'),
        usbipPort: this.config.get('usbipPort'),
        busid,
        description: dev.description,
        vendorId: dev.vendorId,
        productId: dev.productId,
      });
      this.onStateChanged();
      return r;
    }

    const peer = this.peers.get(nodeId);
    if (!peer) throw new Error('узел-владелец не найден в сети');
    if (!peer.online) throw new Error(`узел "${peer.name}" сейчас недоступен`);

    const dev = (peer.devices || []).find((d) => d.busid === busid);
    if (!dev) throw new Error('устройство не найдено у владельца');

    const r = await this.attach.attach({
      nodeId,
      nodeName: peer.name,
      host: peer.address,
      apiPort: peer.apiPort,
      usbipPort: peer.usbipPort,
      busid,
      description: dev.description,
      vendorId: dev.vendorId,
      productId: dev.productId,
    });

    // Владелец только что изменил состояние — забираем его сразу,
    // не дожидаясь очередного анонса.
    this.peers.refreshPeerState(peer).catch(() => {});
    this.onStateChanged();
    return r;
  }

  /** Применение настроек из UI. Возвращает признак необходимости перезапуска. */
  async applySettings(patch) {
    const before = { ...this.config.data };
    const allowed = ['name', 'network', 'preSharedKey', 'autoShareNew', 'claimLeaseMs',
                     'apiPort', 'discoveryPort', 'usbipPort', 'usbipdPath', 'usbipPath', 'logLevel'];
    const clean = {};
    for (const k of allowed) {
      if (patch[k] !== undefined) clean[k] = patch[k];
    }
    if (typeof clean.name === 'string') {
      clean.name = clean.name.trim().slice(0, 64) || before.name;
    }
    this.config.set(clean);

    if (clean.logLevel) {
      const { setLevel } = await import('../log.js');
      setLevel(clean.logLevel);
    }

    // Порты и ключ меняют способ, которым нас находят и проверяют соседи, —
    // корректно применить это на лету нельзя, нужен перезапуск.
    const needsRestart = ['apiPort', 'discoveryPort', 'usbipPort', 'preSharedKey']
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

    if (clean.name && clean.name !== before.name) {
      log.info(`имя узла изменено на "${clean.name}"`);
    }

    this.onStateChanged();
    return { ok: true, needsRestart, config: this.publicConfig() };
  }

  publicConfig() {
    const c = this.config.data;
    return {
      nodeId: c.nodeId,
      name: c.name,
      network: c.network,
      apiPort: c.apiPort,
      discoveryPort: c.discoveryPort,
      usbipPort: c.usbipPort,
      autoShareNew: c.autoShareNew,
      claimLeaseMs: c.claimLeaseMs,
      logLevel: c.logLevel,
      // Сам ключ наружу не отдаём — только факт его наличия.
      hasKey: Boolean(c.preSharedKey),
      usbipdPath: c.usbipdPath || null,
      usbipPath: c.usbipPath || null,
      configFile: this.config.file,
    };
  }

  /** Полный снимок для интерфейса. */
  snapshot() {
    const selfId = this.config.get('nodeId');
    const attachments = this.attach.list();
    const attachedByDevice = new Map(attachments.map((a) => [a.id, a]));

    const localDevices = this.share.listAll();
    const catalog = [];

    // Собственные опубликованные устройства — на равных с чужими:
    // пользователь занимает их тем же действием.
    for (const d of localDevices) {
      if (!d.shared || !d.busid) continue;
      catalog.push(this._catalogEntry(d, {
        nodeId: selfId,
        name: this.config.get('name'),
        address: this.network.address,
        online: true,
        self: true,
        platform: process.platform,
        startedAt: this.startedAt,
      }, attachedByDevice));
    }

    for (const peer of this.peers.list()) {
      for (const d of peer.devices || []) {
        catalog.push(this._catalogEntry(d, peer, attachedByDevice));
      }
    }

    catalog.sort((a, b) => (a.ownerName || '').localeCompare(b.ownerName || '')
      || String(a.busid).localeCompare(String(b.busid), undefined, { numeric: true }));

    return {
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
        issues: this.backendInfo.issues,
      },
      install: this.installer ? this.installer.plan() : null,
      config: this.publicConfig(),
      networks: listNetworks(),
      localDevices,
      catalog,
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
      })),
      attachments,
      ts: Date.now(),
    };
  }

  _catalogEntry(d, owner, attachedByDevice) {
    const id = deviceKey(owner.nodeId, d.busid);
    const att = attachedByDevice.get(id) || null;
    const selfId = this.config.get('nodeId');
    return {
      id,
      busid: d.busid,
      description: d.description,
      vendorId: d.vendorId,
      productId: d.productId,
      serial: d.serial,
      note: d.note || null,
      bindState: d.bindState,
      connectedSince: d.connectedSince,
      sharedSince: d.sharedSince,
      lastError: d.lastError || null,
      ownerId: owner.nodeId,
      ownerName: owner.name,
      ownerAddress: owner.address,
      ownerOnline: owner.online !== false,
      ownerSelf: owner.nodeId === selfId,
      ownerPlatform: owner.platform,
      claim: d.claim || null,
      busy: Boolean(d.claim),
      busyByMe: Boolean(d.claim && d.claim.holderId === selfId),
      attachmentId: att ? att.id : null,
      attachState: att ? att.state : null,
      vhciPort: att ? att.vhciPort : null,
    };
  }

  async shutdown() {
    if (this.stopping) return;
    this.stopping = true;
    log.info('завершение работы…');

    // Порядок важен: сначала вернуть чужие устройства владельцам,
    // потом перестать анонсироваться, потом закрыть сокеты.
    try {
      await this.attach.detachAll();
    } catch (e) {
      log.warn('не все устройства удалось отключить:', e.message);
    }

    this.attach?.stop();
    this.share?.stop();
    this.peers?.stop();
    await this.discovery?.stop();
    await this.api?.stop();
    log.info('остановлено');
  }
}
