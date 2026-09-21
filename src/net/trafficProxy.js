// Счётчик трафика USB/IP.
//
// Данные USB/IP идут между драйвером клиента и службой usbipd мимо нашего
// процесса, поэтому «изнутри» их не посчитать. Единственный способ узнать
// точный объём по каждому устройству — встать в разрыв соединения.
//
// Клиенту сообщается не порт usbipd (3240), а порт этого посредника; он
// принимает соединение, открывает своё к usbipd на локальном адресе и
// перекладывает байты, считая их. Утилита usbip умеет подключаться к
// произвольному порту (--tcp-port), так что никаких ухищрений не нужно.
//
// Плата очевидна: наш процесс оказывается в тракте данных. Поэтому
// посредник отключается настройкой, а при любом сбое запуска приложение
// возвращается к прямому соединению — измерения ценны, но не ценой работы
// самих устройств.
//
// Кому принадлежит соединение, выясняется из первого пакета: протокол
// USB/IP начинается с запроса OP_REQ_IMPORT, в котором открытым текстом
// лежит busid запрашиваемого устройства.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { ipInCidr, normalizeIp } from './interfaces.js';

const log = logger('traffic');

/** Заголовок протокола USB/IP: version(2) code(2) status(4), затем busid[32]. */
const OP_REQ_IMPORT = 0x8003;
const IMPORT_HEADER = 8;
const BUSID_LEN = 32;
const IMPORT_PACKET = IMPORT_HEADER + BUSID_LEN;

/** Сколько секундных отсчётов держим: ровно минута, как и просили показывать. */
const WINDOW_SECONDS = 60;

export class TrafficProxy extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} o.listenPort — порт, который сообщается клиентам
   * @param {number} o.targetPort — порт usbipd
   * @param {string} [o.cidr] — рабочая сеть; соединения извне не принимаем
   * @param {(ip: string) => boolean} [o.isKnownPeer] — узел из другой сети,
   *   которого мы знаем по каталогу. Подписи в тракте данных нет, поэтому
   *   здесь работает список: пускаем только по адресам узлов, о которых нам
   *   рассказали, а не всех, до кого есть маршрут.
   */
  constructor({ listenPort, targetPort, cidr, isKnownPeer = null }) {
    super();
    this.listenPort = listenPort;
    this.targetPort = targetPort;
    this.cidr = cidr;
    this.isKnownPeer = isKnownPeer;
    this.server = null;
    /** @type {Map<string, object>} deviceId → счётчики */
    this.counters = new Map();
    this.sockets = new Set();
    this.tickTimer = null;
  }

  async start() {
    this.server = net.createServer((client) => this._onClient(client));
    // Событие именно 'failed', а не 'error': EventEmitter бросает
    // необработанное исключение, если 'error' испустить без слушателя, —
    // и занятый порт ронял бы всё приложение вместо отката на прямое
    // соединение с usbipd.
    this.server.on('error', (e) => {
      log.error('ошибка сокета счётчика:', e.message);
      this.emit('failed', e);
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.listenPort, '0.0.0.0', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });

    // Раз в секунду сдвигаем окно: так «за последнюю минуту» остаётся
    // честной минутой, а не суммой с начала работы.
    this.tickTimer = setInterval(() => this._tick(), 1000);
    this.tickTimer.unref?.();

    log.info(`счётчик трафика слушает ${this.listenPort}, пересылает на 127.0.0.1:${this.targetPort}`);
    return this;
  }

  async stop() {
    clearInterval(this.tickTimer);
    for (const s of this.sockets) {
      try { s.destroy(); } catch { /* уже закрыт */ }
    }
    this.sockets.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  _counter(deviceId) {
    let c = this.counters.get(deviceId);
    if (!c) {
      c = {
        deviceId,
        totalIn: 0,
        totalOut: 0,
        // Кольцо секундных отсчётов; сумма кольца = объём за минуту.
        ringIn: new Array(WINDOW_SECONDS).fill(0),
        ringOut: new Array(WINDOW_SECONDS).fill(0),
        slot: 0,
        connections: 0,
        since: Date.now(),
        lastActivity: null,
      };
      this.counters.set(deviceId, c);
    }
    return c;
  }

  _tick() {
    for (const c of this.counters.values()) {
      c.slot = (c.slot + 1) % WINDOW_SECONDS;
      c.ringIn[c.slot] = 0;
      c.ringOut[c.slot] = 0;
    }
  }

  _onClient(client) {
    const from = normalizeIp(client.remoteAddress || '');
    const near = !this.cidr || ipInCidr(from, this.cidr) || from.startsWith('127.');
    if (!near && !this.isKnownPeer?.(from)) {
      log.warn(`соединение с ${from} вне рабочей сети отклонено`);
      client.destroy();
      return;
    }
    if (!near) log.debug(`соединение из другой сети с ${from} — узел известен по каталогу`);

    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', (e) => log.debug(`клиентский сокет: ${e.message}`));

    // Ждём первый пакет: из него узнаём, о каком устройстве речь.
    const head = [];
    let headLen = 0;
    let deviceId = null;

    const upstream = net.connect(this.targetPort, '127.0.0.1');
    this.sockets.add(upstream);
    upstream.on('close', () => this.sockets.delete(upstream));
    upstream.on('error', (e) => {
      log.warn(`не удалось соединиться с usbipd: ${e.message}`);
      client.destroy();
    });

    const countIn = (n) => {
      if (!deviceId) return;
      const c = this._counter(deviceId);
      c.totalIn += n;
      c.ringIn[c.slot] += n;
      c.lastActivity = Date.now();
    };
    const countOut = (n) => {
      if (!deviceId) return;
      const c = this._counter(deviceId);
      c.totalOut += n;
      c.ringOut[c.slot] += n;
      c.lastActivity = Date.now();
    };

    client.on('data', (chunk) => {
      if (deviceId === null && headLen < IMPORT_PACKET) {
        head.push(chunk);
        headLen += chunk.length;
        if (headLen >= IMPORT_PACKET) {
          deviceId = parseImport(Buffer.concat(head));
          if (deviceId) {
            const c = this._counter(deviceId);
            c.connections++;
            // Байты заголовка тоже учитываем: они уже прошли по проводу.
            c.totalIn += headLen;
            c.ringIn[c.slot] += headLen;
            c.lastActivity = Date.now();
            log.debug(`соединение ${from} → ${deviceId}`);
            this.emit('changed');
          } else {
            // Неизвестный протокол — просто пересылаем, не считая:
            // ломать соединение из-за неудачного разбора нельзя.
            deviceId = '';
            log.debug(`соединение ${from}: устройство не опознано, пересылаем без учёта`);
          }
        }
      } else {
        countIn(chunk.length);
      }
      if (!upstream.write(chunk)) client.pause();
    });

    upstream.on('drain', () => client.resume());
    client.on('drain', () => upstream.resume());

    upstream.on('data', (chunk) => {
      countOut(chunk.length);
      if (!client.write(chunk)) upstream.pause();
    });

    // Закрытие любой стороны закрывает обе: висящая половина соединения
    // выглядела бы для драйвера как работающее устройство.
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('end', close);
    upstream.on('end', close);
    client.on('close', close);
    upstream.on('close', close);
  }

  /**
   * Завести счётчик заранее, в момент занятия устройства.
   *
   * Без этого «нет счётчика» означало бы сразу две разные вещи: учёт выключен
   * у владельца или учёт идёт, но обмена ещё не было. Нулевой счётчик с
   * момента занятия различает их однозначно.
   */
  begin(deviceId) {
    this._counter(deviceId);
  }

  /** Сведения по одному устройству. */
  statsFor(deviceId) {
    const c = this.counters.get(deviceId);
    if (!c) return null;
    const sum = (ring) => ring.reduce((a, b) => a + b, 0);
    return {
      bytesInPerMinute: sum(c.ringIn),
      bytesOutPerMinute: sum(c.ringOut),
      totalIn: c.totalIn,
      totalOut: c.totalOut,
      connections: c.connections,
      lastActivity: c.lastActivity,
    };
  }

  /** Все счётчики разом — для снимка состояния. */
  all() {
    const out = {};
    for (const deviceId of this.counters.keys()) {
      out[deviceId] = this.statsFor(deviceId);
    }
    return out;
  }

  /** Забыть счётчики устройства: освободили — счёт начинается заново. */
  reset(deviceId) {
    this.counters.delete(deviceId);
  }
}

/**
 * Достаёт busid из запроса OP_REQ_IMPORT.
 * Возвращает идентификатор устройства или null, если это не тот запрос.
 */
export function parseImport(buf) {
  if (buf.length < IMPORT_PACKET) return null;
  const code = buf.readUInt16BE(2);
  if (code !== OP_REQ_IMPORT) return null;

  const raw = buf.subarray(IMPORT_HEADER, IMPORT_HEADER + BUSID_LEN);
  const end = raw.indexOf(0);
  const busid = raw.subarray(0, end < 0 ? BUSID_LEN : end).toString('ascii').trim();
  if (!busid) return null;
  return `usb:${busid}`;
}

/** «12 КБ/мин», «3,4 МБ/мин» — для интерфейса и журнала. */
export function formatRate(bytesPerMinute) {
  if (!bytesPerMinute) return '0 Б/мин';
  if (bytesPerMinute < 1024) return `${bytesPerMinute} Б/мин`;
  if (bytesPerMinute < 1024 * 1024) return `${(bytesPerMinute / 1024).toFixed(1)} КБ/мин`;
  return `${(bytesPerMinute / 1048576).toFixed(2)} МБ/мин`;
}
