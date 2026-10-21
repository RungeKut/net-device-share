// Обнаружение узлов: UDP multicast + направленный broadcast как запасной путь.
// Broadcast нужен потому, что в части корпоративных сетей и на Wi-Fi-точках
// multicast режется, и без него узлы просто не увидят друг друга.
//
// НЕСКОЛЬКО СЕТЕЙ. Узел объявляется и слушает на каждом из переданных
// интерфейсов (opts.networks): приём — один сокет на 0.0.0.0 со вступлением в
// группу на каждом интерфейсе, отправка — свой сокет у каждого интерфейса,
// чтобы пакет ушёл именно в ту сеть. Адрес соседа берётся из источника
// пакета, поэтому «в какой сети его услышали» определяется само.
//
// Оба канала не выходят за пределы подсети: broadcast не маршрутизируется
// вовсе, multicast — только там, где включена маршрутизация multicast, а в
// корпоративных сетях её обычно нет. Узлы из других сегментов приходят не
// сюда, а через обмен каталогом (cluster/directory.js).
//
// ТЕМП АНОНСОВ. Анонс каждые три секунды — это широковещательный трафик,
// который обрабатывает каждый хост подсети, нужен он ему или нет. Поэтому
// темп адаптивный: пока состояние меняется, узел анонсируется часто; как
// только всё успокоилось, интервал удваивается до announceIdleIntervalMs.
// Любое изменение возвращает быстрый темп мгновенно. Чтобы соседи знали,
// когда ждать следующий пакет, интервал едет в самом анонсе (поле next) —
// иначе замедлившийся узел они сочли бы пропавшим.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { PROTO, MSG, encodeDatagram, unpackDatagram } from './protocol.js';
import { broadcastAddress, ipInCidr, normalizeIp } from './interfaces.js';

const log = logger('discovery');

/**
 * Минимальный промежуток между анонсами.
 *
 * Изменения приходят пачками: опубликовали группу из пяти устройств — пять
 * событий подряд. Без этого порога каждая пачка превращалась бы в пачку
 * широковещательных пакетов, хотя соседям достаточно одного.
 */
const MIN_GAP_MS = 500;

export class Discovery extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object[]} opts.networks — интерфейсы, на которых работаем
   *   (элементы listNetworks()); для совместимости принимается и одиночный opts.network
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.socket = null;
    /** @type {Map<string, object>} адрес интерфейса → отправитель */
    this.legs = new Map();
    this.timer = null;
    this.seq = 0;
    this.stopped = false;

    this.interval = opts.announceIntervalMs;
    this.lastHash = null;
    this.lastDir = null;
    this.lastSentAt = 0;
    this.sent = 0;
  }

  /** Медленный темп не может быть быстрее обычного — это была бы опечатка. */
  get idleInterval() {
    return Math.max(this.opts.announceIdleIntervalMs || 0, this.opts.announceIntervalMs);
  }

  async start() {
    const { port } = this.opts;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = sock;
    this.stopped = false;

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

    this.transport = this.opts.announceTransport || 'both';
    if (this.transport === 'broadcast') {
      log.info('multicast выключен настройкой — анонсы идут только broadcast');
    } else if (this.transport === 'multicast') {
      log.info('broadcast выключен настройкой — анонсы идут только multicast');
    }
    await this._syncLegs();
    if (![...this.legs.values()].some((l) => l.multicastOk || l.broadcastAddr)) {
      log.error('ни multicast, ни broadcast не доступны — узел не объявит о себе');
    }

    this.interval = this.opts.announceIntervalMs;
    this.announce();
    this.query();
    return this;
  }

  _onMessage(buf, rinfo) {
    const from = normalizeIp(rinfo.address);

    // Жёсткая привязка к рабочим сетям: пакеты извне подсетей наших
    // интерфейсов не рассматриваем вообще. Ослаблять эту проверку нельзя —
    // подделать UDP-пакет проще, чем установить TCP-соединение, а узлы из
    // других сегментов и так приходят не сюда, а через обмен каталогом.
    if (!this._nets().some((n) => ipInCidr(from, n.cidr))) {
      log.trace('пакет вне рабочей сети от', from);
      return;
    }

    // Ключ выбирается по метке круга доверия из самого пакета. Круг, в
    // котором мы не состоим, отсекается здесь же — и это единственное, что
    // отделяет соседние сети друг от друга: проверки подписи мало, потому
    // что узел без ключа принимает любую.
    const { message, error, realm } = unpackDatagram(buf, (r) => this.opts.realms.keyFor(r, 'listening'));
    if (error) {
      if (error === 'bad-signature') log.warn(`отклонён пакет с неверной подписью от ${from} (круг ${realm})`);
      else if (error === 'other-realm') log.trace(`пакет из чужого круга доверия (${realm}) от ${from}`);
      else log.trace(`пакет отброшен (${error}) от ${from}`);
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    if (message.nodeId === this.opts.nodeId) return; // собственный анонс

    switch (message.type) {
      case MSG.ANNOUNCE:
        this.emit('announce', { ...message, address: from, realm });
        break;
      case MSG.BYE:
        this.emit('bye', { ...message, address: from, realm });
        break;
      case MSG.QUERY:
        // Новый узел просит представиться — отвечаем без ожидания таймера.
        this.announce();
        break;
      default:
        log.trace('неизвестный тип сообщения', message.type);
    }
  }

  _nets() {
    return this.opts.networks || (this.opts.network ? [this.opts.network] : []);
  }

  /**
   * Привести отправителей в соответствие со списком интерфейсов: для новых
   * открыть сокет и вступить в группу, для ушедших — закрыть. Вызывается при
   * старте и когда меняется набор сетей (воткнули кабель, появился адаптер).
   */
  async _syncLegs() {
    const want = new Map(this._nets().map((n) => [n.address, n]));
    for (const [addr, leg] of [...this.legs]) {
      if (want.has(addr)) continue;
      this.legs.delete(addr);
      try { this.socket?.dropMembership(this.opts.multicastAddress, addr); } catch { /* уже нет */ }
      await new Promise((res) => { try { leg.sock.close(() => res()); } catch { res(); } });
      log.info(`интерфейс ${leg.net.iface} (${addr}) больше не используется для обнаружения`);
    }
    for (const [addr, net] of want) {
      if (this.legs.has(addr)) continue;
      const leg = await this._openLeg(net);
      if (leg) this.legs.set(addr, leg);
    }
  }

  async _openLeg(net) {
    const { port } = this.opts;
    const leg = { net, sock: null, multicastOk: false, broadcastAddr: null };
    try {
      leg.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      leg.sock.on('error', (e) => log.warn(`отправка через ${net.iface}: ${e.message}`));
      await new Promise((resolve, reject) => {
        leg.sock.once('error', reject);
        leg.sock.bind(0, net.address, () => { leg.sock.removeListener('error', reject); resolve(); });
      });
    } catch (e) {
      log.warn(`интерфейс ${net.iface} (${net.address}) для обнаружения не открылся: ${e.message}`);
      try { leg.sock?.close(); } catch { /* не открыт */ }
      return null;
    }

    if (this.transport !== 'broadcast') {
      try {
        leg.sock.setMulticastTTL(2);           // хватает на LAN + один маршрутизатор
        leg.sock.setMulticastLoopback(false);  // свои же пакеты нам не нужны
        leg.sock.setMulticastInterface(net.address);
        this.socket.addMembership(this.opts.multicastAddress, net.address);
        leg.multicastOk = true;
      } catch (e) {
        log.warn(`multicast на ${net.iface} недоступен, работаем только через broadcast: ${e.message}`);
      }
    }
    if (this.transport !== 'multicast') {
      try {
        leg.sock.setBroadcast(true);
        leg.broadcastAddr = broadcastAddress(net.address, net.prefix);
      } catch (e) {
        log.warn(`broadcast на ${net.iface} недоступен: ${e.message}`);
      }
    }
    log.info(`обнаружение на ${net.iface}: ${net.address}/${net.prefix}`
      + `${leg.multicastOk ? `, multicast ${this.opts.multicastAddress}:${port}` : ''}${leg.broadcastAddr ? `, broadcast ${leg.broadcastAddr}` : ''}`);
    return leg;
  }

  /**
   * Набор сетей поменялся: перенастроить отправителей и тут же объявиться
   * в новых. Сам приёмный сокет остаётся — он слушает все интерфейсы.
   */
  async setNetworks(networks) {
    this.opts.networks = networks;
    await this._syncLegs();
    if (this.legs.size) this.refresh();
  }

  _targets(leg) {
    const targets = [];
    if (leg.multicastOk) targets.push(this.opts.multicastAddress);
    if (leg.broadcastAddr) targets.push(leg.broadcastAddr);
    return targets;
  }

  /** Отправить пакет во все сети из всех кругов: base.realm и подпись подставляются здесь. */
  _sendEach(circles, makeBase) {
    for (const leg of this.legs.values()) {
      const targets = this._targets(leg);
      if (!targets.length) continue;
      for (const r of circles) {
        const buf = encodeDatagram({ ...makeBase(leg), realm: r.realm }, r.key);
        for (const addr of targets) {
          leg.sock.send(buf, 0, buf.length, this.opts.port, addr, (err) => {
            if (err) log.debug(`отправка на ${addr} (${leg.net.iface}) не удалась: ${err.message}`);
          });
        }
      }
    }
  }

  /**
   * Отправка в каждый круг доверия, в котором мы объявляем о себе, и в
   * каждую нашу сеть.
   *
   * Подпись в пакете одна, а кругов несколько, поэтому и пакетов столько же:
   * узел с ключом «Цех» обязан принять наш анонс, и узел с ключом
   * «Лаборатория» тоже, а один пакет удовлетворить обоим не может.
   *
   * Цена прямая: трафик умножается на число кругов и на число сетей.
   * Поэтому замедление анонсов в покое (см. выше) важнее с несколькими
   * сетями, чем с одной.
   */
  _send(base) {
    if (!this.socket) return;
    // Отпечаток каталога у каждой сети свой: соседям в сети A надо знать, что
    // у нас есть узлы из сети B, а соседям в B о самих себе рассказывать нечего.
    const perLeg = base.type === MSG.ANNOUNCE && this.opts.dirFor;
    this._sendEach(this.opts.realms.announcing(), (leg) => ({
      ...base,
      network: leg.net.cidr,
      ...(perLeg ? { dir: this.opts.dirFor(leg.net) } : {}),
    }));
  }

  _reschedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.announce('tick'), delay);
    this.timer.unref?.();
  }

  /**
   * Анонс присутствия. Вызывается и по таймеру, и сразу при изменении
   * состояния — оба пути проходят здесь, поэтому здесь же решается,
   * когда будет следующий.
   *
   * Замедляет темп только очередной приход по таймеру и только если
   * объявлять нечего нового. Разделять источники обязательно: при старте и
   * при публикации группы состояние меняется пачкой, и если считать каждый
   * такой вызов «тиком без изменений», узел уезжает на медленный темп за
   * пару секунд — ровно противоположно замыслу.
   *
   * @param {'change'|'tick'} [reason]
   */
  announce(reason = 'change') {
    if (this.stopped || !this.socket) return;

    const snapshot = this.opts.getSnapshot();
    const dir = snapshot.dir || null;
    const changed = snapshot.stateHash !== this.lastHash || dir !== this.lastDir;
    const first = !this.lastSentAt;

    // Объявлять нечего, и никто не ждёт подтверждения жизни — молчим.
    // Это и есть главная экономия: поток событий интерфейса больше не
    // превращается в поток широковещательных пакетов.
    if (!first && !changed && reason !== 'tick') return;

    const now = Date.now();
    const since = now - this.lastSentAt;
    if (!first && since < MIN_GAP_MS) {
      // Слишком часто. Отложим — состояние к тому моменту всё равно
      // перечитается, и уедет самая свежая его версия.
      this._reschedule(MIN_GAP_MS - since);
      return;
    }

    if (this.opts.announceBackoff === false) {
      this.interval = this.opts.announceIntervalMs;
    } else if (changed || first) {
      // Состояние поменялось — соседи должны узнать об этом быстро.
      if (this.interval !== this.opts.announceIntervalMs) {
        log.debug(`состояние изменилось — возврат к темпу ${this.opts.announceIntervalMs} мс`);
      }
      this.interval = this.opts.announceIntervalMs;
    } else {
      const slower = Math.min(this.interval * 2, this.idleInterval);
      if (slower !== this.interval) log.debug(`ничего не меняется — темп анонсов снижен до ${slower} мс`);
      this.interval = slower;
    }

    this.lastHash = snapshot.stateHash;
    this.lastDir = dir;
    this.lastSentAt = now;
    this.sent++;

    this._send({
      proto: PROTO,
      type: MSG.ANNOUNCE,
      nodeId: this.opts.nodeId,
      name: snapshot.name,
      seq: ++this.seq,
      ts: now,
      // Когда ждать следующий анонс. Без этого поля сосед, перешедший на
      // медленный темп, выглядел бы пропавшим уже через 12 секунд.
      next: this.interval,
      apiPort: this.opts.apiPort,
      usbipPort: this.opts.usbipPort,
      trafficPort: this.opts.trafficPort,
      netLinkPort: this.opts.netLinkPort,
      // Сколько у узла сетей: больше одной — он может быть шлюзом между ними.
      nets: this._nets().length,
      platform: process.platform,
      version: snapshot.version,
      startedAt: snapshot.startedAt,
      stateHash: snapshot.stateHash,
      deviceCount: snapshot.deviceCount,
      busyCount: snapshot.busyCount,
      // Отпечаток каталога узлов из других сетей. Непустой только у узла,
      // который сам ходит к seed-адресам. Соседи по нему понимают, что у
      // него есть чем поделиться, и забирают каталог по HTTP.
      dir,
    });

    this._reschedule(this.interval);
  }

  /**
   * Объявиться заново немедленно и попросить соседей представиться.
   *
   * Нужно при смене кругов доверия. Обычный announce здесь бесполезен: он
   * отправляет пакет, только если изменилось СОДЕРЖИМОЕ анонса, а при смене
   * ключей меняется не оно, а набор подписей — и узел молча оставался бы
   * невидимым для новой сети до ближайшего тика, то есть до полуминуты.
   *
   * Запрос соседям нужен по обратной причине: спокойный узел мог уйти на
   * медленный темп, и, войдя в его круг, мы ждали бы его анонса те же
   * полминуты, хотя он всё это время рядом.
   */
  refresh() {
    this.lastHash = null;
    this.lastDir = null;
    this.announce('change');
    this.query();
  }

  /**
   * Прощание в кругах, которые мы покидаем.
   *
   * Без него бывшие соседи держали бы узел в списке до истечения таймаута —
   * на медленном темпе это полторы минуты, и всё это время его устройства
   * выглядели бы доступными, хотя занять их уже нельзя.
   */
  farewell(circles) {
    if (!this.socket || !circles?.length) return;
    this._sendEach(circles, () => ({ proto: PROTO, type: MSG.BYE, nodeId: this.opts.nodeId, ts: Date.now() }));
    for (const r of circles) log.debug(`прощание отправлено в круг ${r.realm}`);
  }

  query() {
    this._send({
      proto: PROTO,
      type: MSG.QUERY,
      nodeId: this.opts.nodeId,
      ts: Date.now(),
    });
  }

  stats() {
    return {
      intervalMs: this.interval,
      baseIntervalMs: this.opts.announceIntervalMs,
      idleIntervalMs: this.idleInterval,
      backoff: this.opts.announceBackoff !== false,
      multicast: [...this.legs.values()].some((l) => l.multicastOk),
      broadcast: [...this.legs.values()].some((l) => l.broadcastAddr),
      interfaces: [...this.legs.values()].map((l) => ({ iface: l.net.iface, address: l.net.address, network: l.net.cidr })),
      sent: this.sent,
      // Пакетов на один анонс: кругов доверия × каналов. Полезно видеть,
      // потому что число кругов умножает широковещательный трафик.
      realms: this.opts.realms.announcing().length,
      perAnnounce: this.opts.realms.announcing().length
        * [...this.legs.values()].reduce((n, l) => n + this._targets(l).length, 0),
    };
  }

  async stop() {
    clearTimeout(this.timer);
    if (!this.socket) {
      this.stopped = true;
      return;
    }

    // Прощальный пакет: соседи уберут узел из списка сразу,
    // не дожидаясь истечения таймаута.
    try {
      // Прощаться нужно в каждом круге, где мы объявлялись: иначе соседи из
      // остальных будут ещё минуту показывать узел, которого уже нет.
      const sends = [];
      for (const leg of this.legs.values()) {
        for (const r of this.opts.realms.announcing()) {
          const buf = encodeDatagram(
            { proto: PROTO, type: MSG.BYE, nodeId: this.opts.nodeId, realm: r.realm, ts: Date.now() },
            r.key,
          );
          for (const a of this._targets(leg)) {
            sends.push(new Promise((res) => {
              leg.sock.send(buf, 0, buf.length, this.opts.port, a, () => res());
            }));
          }
        }
      }
      await Promise.all(sends);
    } catch { /* сеть уже могла отвалиться — не мешаем завершению */ }

    this.stopped = true;
    for (const leg of this.legs.values()) {
      await new Promise((res) => { try { leg.sock.close(() => res()); } catch { res(); } });
    }
    this.legs.clear();
    await new Promise((res) => this.socket.close(() => res()));
    this.socket = null;
  }
}
