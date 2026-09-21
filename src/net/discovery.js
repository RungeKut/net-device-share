// Обнаружение узлов: UDP multicast + направленный broadcast как запасной путь.
// Broadcast нужен потому, что в части корпоративных сетей и на Wi-Fi-точках
// multicast режется, и без него узлы просто не увидят друг друга.
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
   * @param {import('./interfaces.js').listNetworks} opts.network — выбранный интерфейс
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.socket = null;
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

    const localAddr = this.opts.network.address;
    const transport = this.opts.announceTransport || 'both';

    if (transport === 'broadcast') {
      this.multicastOk = false;
      log.info('multicast выключен настройкой — анонсы идут только broadcast');
    } else {
      try {
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
    }

    if (transport === 'multicast') {
      this.broadcastAddr = null;
      if (this.multicastOk) log.info('broadcast выключен настройкой — анонсы идут только multicast');
      else log.error('broadcast выключен настройкой, а multicast недоступен — узел не объявит о себе');
    } else {
      try {
        sock.setBroadcast(true);
        this.broadcastAddr = broadcastAddress(localAddr, this.opts.network.prefix);
      } catch (e) {
        this.broadcastAddr = null;
        log.warn('broadcast недоступен:', e.message);
      }
    }

    this.interval = this.opts.announceIntervalMs;
    this.announce();
    this.query();
    return this;
  }

  _onMessage(buf, rinfo) {
    const from = normalizeIp(rinfo.address);

    // Жёсткая привязка к рабочей сети: пакеты извне выбранной подсети
    // не рассматриваем вообще. Ослаблять эту проверку нельзя — подделать
    // UDP-пакет проще, чем установить TCP-соединение, а узлы из других
    // сегментов и так приходят не сюда, а через обмен каталогом.
    if (!ipInCidr(from, this.opts.network.cidr)) {
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

  _targets() {
    const targets = [];
    if (this.multicastOk) targets.push(this.opts.multicastAddress);
    if (this.broadcastAddr) targets.push(this.broadcastAddr);
    return targets;
  }

  /**
   * Отправка в каждый круг доверия, в котором мы объявляем о себе.
   *
   * Подпись в пакете одна, а кругов несколько, поэтому и пакетов столько же:
   * узел с ключом «Цех» обязан принять наш анонс, и узел с ключом
   * «Лаборатория» тоже, а один пакет удовлетворить обоим не может.
   *
   * Цена прямая: трафик умножается на число кругов. Поэтому замедление
   * анонсов в покое (см. выше) с несколькими сетями важнее, чем с одной.
   */
  _send(base) {
    if (!this.socket) return;
    const targets = this._targets();
    if (!targets.length) return;

    for (const r of this.opts.realms.announcing()) {
      const buf = encodeDatagram({ ...base, realm: r.realm }, r.key);
      for (const addr of targets) {
        this.socket.send(buf, 0, buf.length, this.opts.port, addr, (err) => {
          if (err) log.debug(`отправка на ${addr} не удалась: ${err.message}`);
        });
      }
    }
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
      network: this.opts.network.cidr,
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
    for (const r of circles) {
      const buf = encodeDatagram(
        { proto: PROTO, type: MSG.BYE, nodeId: this.opts.nodeId, realm: r.realm, ts: Date.now() },
        r.key,
      );
      for (const addr of this._targets()) {
        this.socket.send(buf, 0, buf.length, this.opts.port, addr, (err) => {
          if (err) log.debug(`прощание в круге ${r.realm} не ушло: ${err.message}`);
        });
      }
      log.debug(`прощание отправлено в круг ${r.realm}`);
    }
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
      multicast: Boolean(this.multicastOk),
      broadcast: Boolean(this.broadcastAddr),
      sent: this.sent,
      // Пакетов на один анонс: кругов доверия × каналов. Полезно видеть,
      // потому что число кругов умножает широковещательный трафик.
      realms: this.opts.realms.announcing().length,
      perAnnounce: this.opts.realms.announcing().length * this._targets().length,
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
      for (const r of this.opts.realms.announcing()) {
        const buf = encodeDatagram(
          { proto: PROTO, type: MSG.BYE, nodeId: this.opts.nodeId, realm: r.realm, ts: Date.now() },
          r.key,
        );
        for (const a of this._targets()) {
          sends.push(new Promise((res) => {
            this.socket.send(buf, 0, buf.length, this.opts.port, a, () => res());
          }));
        }
      }
      await Promise.all(sends);
    } catch { /* сеть уже могла отвалиться — не мешаем завершению */ }

    this.stopped = true;
    await new Promise((res) => this.socket.close(() => res()));
    this.socket = null;
  }
}
