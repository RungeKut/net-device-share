// Обнаружение узлов: UDP multicast + направленный broadcast как запасной путь.
// Broadcast нужен потому, что в части корпоративных сетей и на Wi-Fi-точках
// multicast режется, и без него узлы просто не увидят друг друга.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { PROTO, MSG, encodeDatagram, decodeDatagram, realmOf } from './protocol.js';
import { broadcastAddress, ipInCidr, normalizeIp } from './interfaces.js';

const log = logger('discovery');

export class Discovery extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./interfaces.js').listNetworks} opts.network — выбранный интерфейс
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.socket = null;
    this.realm = realmOf(opts.preSharedKey);
    this.timer = null;
    this.seq = 0;
    this.stopped = false;
  }

  async start() {
    const { port } = this.opts;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = sock;

    sock.on('error', (err) => {
      log.error('ошибка UDP-сокета:', err.message);
      this.emit('error', err);
    });

    sock.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));

    await new Promise((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(port, '0.0.0.0', () => {
        sock.removeListener('error', reject);
        resolve();
      });
    });

    const localAddr = this.opts.network.address;
    try {
      sock.setBroadcast(true);
      sock.setMulticastTTL(2);           // хватает на LAN + один маршрутизатор
      sock.setMulticastLoopback(false);  // свои же пакеты нам не нужны
      sock.setMulticastInterface(localAddr);
      sock.addMembership(this.opts.multicastAddress, localAddr);
      this.multicastOk = true;
      log.info(`multicast ${this.opts.multicastAddress}:${port} на ${localAddr} (${this.opts.network.iface})`);
    } catch (e) {
      this.multicastOk = false;
      log.warn('multicast недоступен, работаем только через broadcast:', e.message);
    }

    this.broadcastAddr = broadcastAddress(localAddr, this.opts.network.prefix);
    this._scheduleAnnounce();
    this.announce();
    this.query();
    return this;
  }

  _scheduleAnnounce() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.announce(), this.opts.announceIntervalMs);
    this.timer.unref?.();
  }

  _onMessage(buf, rinfo) {
    const from = normalizeIp(rinfo.address);

    // Жёсткая привязка к рабочей сети: пакеты извне выбранной подсети
    // не рассматриваем вообще.
    if (!ipInCidr(from, this.opts.network.cidr)) {
      log.trace('пакет вне рабочей сети от', from);
      return;
    }

    const { message, error } = decodeDatagram(buf, this.opts.preSharedKey);
    if (error) {
      if (error === 'bad-signature') log.warn('отклонён пакет с неверной подписью от', from);
      else log.trace(`пакет отброшен (${error}) от ${from}`);
      return;
    }
    if (message.nodeId === this.opts.nodeId) return; // собственный анонс

    // Узлы с другим общим ключом — не наша сеть. Проверять только подпись
    // недостаточно: узел без ключа принимает любые пакеты и иначе показывал
    // бы в списке соседей, с которыми не сможет договориться.
    if (message.realm !== this.realm) {
      log.trace(`пакет из другого круга доверия (${message.realm}) от ${from}`);
      return;
    }

    switch (message.type) {
      case MSG.ANNOUNCE:
        this.emit('announce', { ...message, address: from });
        break;
      case MSG.BYE:
        this.emit('bye', { ...message, address: from });
        break;
      case MSG.QUERY:
        // Новый узел просит представиться — отвечаем без ожидания таймера.
        this.announce();
        break;
      default:
        log.trace('неизвестный тип сообщения', message.type);
    }
  }

  _send(message) {
    if (!this.socket || this.stopped) return;
    const buf = encodeDatagram(message, this.opts.preSharedKey);
    const targets = [];
    if (this.multicastOk) targets.push(this.opts.multicastAddress);
    if (this.broadcastAddr) targets.push(this.broadcastAddr);

    for (const addr of targets) {
      this.socket.send(buf, 0, buf.length, this.opts.port, addr, (err) => {
        if (err) log.debug(`отправка на ${addr} не удалась: ${err.message}`);
      });
    }
  }

  announce() {
    const snapshot = this.opts.getSnapshot();
    this._send({
      proto: PROTO,
      type: MSG.ANNOUNCE,
      nodeId: this.opts.nodeId,
      realm: this.realm,
      name: snapshot.name,
      seq: ++this.seq,
      ts: Date.now(),
      apiPort: this.opts.apiPort,
      usbipPort: this.opts.usbipPort,
      network: this.opts.network.cidr,
      platform: process.platform,
      version: snapshot.version,
      startedAt: snapshot.startedAt,
      stateHash: snapshot.stateHash,
      deviceCount: snapshot.deviceCount,
      busyCount: snapshot.busyCount,
    });
  }

  query() {
    this._send({
      proto: PROTO,
      type: MSG.QUERY,
      nodeId: this.opts.nodeId,
      realm: this.realm,
      ts: Date.now(),
    });
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (!this.socket) return;

    // Прощальный пакет: соседи уберут узел из списка сразу,
    // не дожидаясь истечения таймаута.
    try {
      const buf = encodeDatagram(
        { proto: PROTO, type: MSG.BYE, nodeId: this.opts.nodeId, realm: this.realm, ts: Date.now() },
        this.opts.preSharedKey,
      );
      const addrs = [this.multicastOk ? this.opts.multicastAddress : null, this.broadcastAddr].filter(Boolean);
      await Promise.all(addrs.map((a) => new Promise((res) => {
        this.socket.send(buf, 0, buf.length, this.opts.port, a, () => res());
      })));
    } catch { /* сеть уже могла отвалиться — не мешаем завершению */ }

    await new Promise((res) => this.socket.close(() => res()));
    this.socket = null;
  }
}
