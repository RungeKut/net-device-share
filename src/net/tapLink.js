// Канал L2 между двумя машинами: кадры одного TAP-адаптера едут в другой.
//
// Формат на проводе тот же, что у посредника: длина кадра двумя байтами,
// затем кадр. Поэтому кадры не разбираются на объекты — поток только
// режется по границам кадров (см. FrameCutter в tapRelay.js) и уходит
// дальше кусками. Через канал идёт весь трафик сетевой карты; разбирать
// каждый кадр в основном процессе значило бы получить приложение, которое
// тормозит тем сильнее, чем активнее им пользуются.
//
// ВХОД ПО ТОКЕНУ. Соединение с каналом — это доступ к чужой сети на уровне
// L2, то есть ровно то же, что воткнуть кабель в чужой коммутатор. Поэтому
// принимающая сторона пускает только того, кому владелец выдал право:
// токен приезжает в ответе на занятие, а первым делом в соединении идёт
// приветствие с этим токеном. Токен у каждого занятия свой и умирает вместе
// с ним — освобождённый интерфейс не впустит прежнего держателя обратно.
//
//   клиент → сервер:  "NDL1" + токен (32 байта)
//   сервер → клиент:  "NDL1" + 1 байт: 1 — принят, 0 — отказ
//
// Дальше — кадры в обе стороны.
//
// Тот же порт несёт и байтовый режим для COM-портов (см. serialLink.js):
// приветствие «NDS1» означает пакеты порта вместо кадров. Токен одного
// режима не открывает другой — сеансы хранятся в одной карте, но при входе
// режим сверяется с тем, для которого сеанс открыт.
//
// ОДИН ПОРТ НА ВСЕ ЗАНЯТИЯ. Сервер слушает один порт и по токену понимает,
// к какому адаптеру относится соединение. Правило брандмауэра нужно одно, и
// его не надо переоткрывать на каждое занятие.
//
// Кадры не шифруются — как и данные USB/IP. Канал рассчитан на рабочую
// сеть; для недоверенной среды нужен туннель поверх.

import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { FrameCutter } from './tapRelay.js';
import { PacketCutter, packetFrame } from './serialLink.js';

const log = logger('tap-link');

const MAGIC = Buffer.from('NDL1', 'ascii');
/** Приветствие байтового режима (COM-порты), см. serialLink.js. */
export const SERIAL_MAGIC = Buffer.from('NDS1', 'ascii');
export const TOKEN_BYTES = 32;
const HELLO_TIMEOUT_MS = 8000;
/** Проверка живости соединения: мёртвый собеседник обнаружится за ~20 с. */
const KEEPALIVE_MS = 10000;

/** Новый токен для занятия. */
export function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function tokenKey(tokenBuf) {
  return crypto.createHash('sha256').update(tokenBuf).digest('hex');
}

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

/**
 * Прочитать ровно n байт приветствия. Остаток (если собеседник сразу
 * прислал и кадры) возвращается отдельно — терять его нельзя.
 */
function readHello(socket, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    let got = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('нет приветствия')), timeoutMs);
    const onData = (chunk) => {
      got = got.length ? Buffer.concat([got, chunk]) : chunk;
      if (got.length >= n) finish(null);
    };
    const onEnd = () => finish(new Error('соединение закрыто до приветствия'));
    function finish(err) {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', onEnd);
      socket.removeListener('error', onEnd);
      socket.pause();
      if (err) reject(err);
      else resolve({ hello: got.subarray(0, n), rest: got.subarray(n) });
    }
    socket.on('data', onData);
    socket.once('close', onEnd);
    socket.once('error', onEnd);
    socket.resume();
  });
}

/**
 * Сращивание соединения с посредником: кадры адаптера — в сокет, кадры из
 * сокета — в адаптер. Обе стороны с встречным напором.
 */
function splice(relay, socket, rest, label) {
  socket.setNoDelay(true);        // кадры мелкие, задержка важнее упаковки
  socket.setKeepAlive(true, KEEPALIVE_MS);

  const cutter = new FrameCutter();
  const onData = (chunk) => {
    let frames;
    try {
      frames = cutter.push(chunk);
    } catch (e) {
      log.warn(`${label}: ${e.message} — соединение закрыто`);
      socket.destroy();
      return;
    }
    if (frames && !relay.writeFrames(frames)) {
      socket.pause();
      relay.onceDrain(() => socket.resume());
    }
  };

  relay.setSink(socket);
  socket.on('data', onData);
  socket.once('close', () => {
    if (relay.sink === socket) relay.setSink(null);
  });
  if (rest && rest.length) onData(rest);
  socket.resume();
}

/**
 * Сращивание байтового сеанса: пакеты из сокета — обработчику сеанса.
 * Обработчик сам решает, что писать в сокет (session.send), и сам несёт
 * ответственность за напор: при паузе стека — pause() и onceDrain().
 */
function splicePackets(session, socket, rest) {
  socket.setNoDelay(true);        // пакеты мелкие, задержка важнее упаковки
  socket.setKeepAlive(true, KEEPALIVE_MS);

  const cutter = new PacketCutter();
  const onData = (chunk) => {
    let packets;
    try {
      packets = cutter.push(chunk);
    } catch (e) {
      log.warn(`${session.label}: ${e.message} — соединение закрыто`);
      socket.destroy();
      return;
    }
    for (const p of packets) session.onPacket(p.type, p.payload);
  };

  socket.on('data', onData);
  if (rest && rest.length) onData(rest);
  socket.resume();
}

// ------------------------------------------------------------------ сервер

export class LinkServer extends EventEmitter {
  /** @param {{ port: number, host?: string }} o */
  constructor({ port, host = '0.0.0.0' }) {
    super();
    this.port = port;
    this.host = host;
    this.server = null;
    /** @type {Map<string, object>} хеш токена → сеанс */
    this.sessions = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this._accept(socket).catch((e) => {
          log.debug(`канал: входящее соединение отклонено — ${e.message}`);
          socket.destroy();
        });
      });
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        // Отказ уже работающего сервера не должен ронять приложение.
        this.server.on('error', (e) => log.error(`канал L2: ${e.message}`));
        log.info(`канал L2 слушает ${this.host}:${this.port}`);
        resolve(this);
      });
    });
  }

  _close(session) {
    this.sessions.delete(session.key);
    if (session.socket) {
      session.socket.destroy();
      session.socket = null;
    }
  }

  /**
   * Открыть сеанс для одного занятия сетевой карты (кадры L2).
   *
   * @param {object} o
   * @param {import('./tapRelay.js').TapRelay} o.relay
   * @param {string|null} [o.allowAddress] — пускать только с этого адреса
   * @param {string} [o.label] — как называть в журнале
   * @returns {{ token: string, close: () => void, connected: () => boolean,
   *   setRelay: (relay: object) => void }}
   */
  open({ relay, allowAddress = null, label = 'канал', deviceId = null }) {
    const session = { kind: 'l2', relay, ...this._session(allowAddress, label, deviceId) };
    this.sessions.set(session.key, session);
    return {
      token: session.token,
      close: () => this._close(session),
      connected: () => Boolean(session.socket),
      // Посредник подняли заново: текущее соединение закрываем, держатель
      // переподключится и попадёт уже на новый.
      setRelay: (next) => {
        session.relay = next;
        session.socket?.destroy();
      },
    };
  }

  /**
   * Открыть байтовый сеанс для занятия COM-порта. Правила входа те же, что
   * у кадров: токен занятия и, при желании, адрес держателя. Обработчик
   * получает пакеты клиента (serialLink.PKT); отвечать — send().
   *
   * @param {object} o
   * @param {(type: number, payload: Buffer) => void} o.onPacket
   * @param {string|null} [o.allowAddress]
   * @param {string} [o.label]
   * @returns {{ token: string, close: () => void, connected: () => boolean,
   *   send: (type: number, payload?: Buffer) => boolean,
   *   pause: () => void, resume: () => void, onceDrain: (cb: () => void) => void }}
   */
  openSerial({ onPacket, allowAddress = null, label = 'порт', deviceId = null }) {
    const session = { kind: 'serial', onPacket, ...this._session(allowAddress, label, deviceId) };
    this.sessions.set(session.key, session);
    return {
      token: session.token,
      close: () => this._close(session),
      connected: () => Boolean(session.socket),
      send: (type, payload) => (session.socket ? session.socket.write(packetFrame(type, payload)) : false),
      // Напор от насоса к сети: сеть не успевает — останавливаем источник.
      pause: () => session.socket?.pause(),
      resume: () => session.socket?.resume(),
      onceDrain: (cb) => session.socket?.once('drain', cb),
    };
  }

  _session(allowAddress, label, deviceId) {
    const token = newToken();
    return {
      key: tokenKey(Buffer.from(token, 'hex')),
      token,
      allowAddress: allowAddress ? normalizeIp(allowAddress) : null,
      label,
      deviceId,
      socket: null,
    };
  }

  async _accept(socket) {
    const from = normalizeIp(socket.remoteAddress);
    socket.on('error', (e) => log.debug(`канал: ${from} — ${e.message}`));

    const { hello, rest } = await readHello(socket, MAGIC.length + TOKEN_BYTES, HELLO_TIMEOUT_MS);
    const head = hello.subarray(0, MAGIC.length);
    const serial = head.equals(SERIAL_MAGIC);
    const session = serial || head.equals(MAGIC)
      ? this.sessions.get(tokenKey(hello.subarray(MAGIC.length)))
      : null;

    // Токен одного режима не работает в другом: сеанс карт не примет пакеты
    // COM и наоборот.
    if (session && (serial ? session.kind !== 'serial' : session.kind === 'serial')) {
      log.warn(`канал: отказ ${from} — токен другого режима канала`);
      socket.end(Buffer.concat([head, Buffer.from([0])]));
      return;
    }

    if (!session || (session.allowAddress && session.allowAddress !== from)) {
      log.warn(`канал: отказ ${from} — ${session ? `ожидался адрес ${session.allowAddress}` : 'неизвестный токен'}`);
      socket.end(Buffer.concat([head, Buffer.from([0])]));
      return;
    }

    // Новое соединение того же держателя вытесняет прежнее: прежнее почти
    // наверняка уже мертво, просто это ещё не обнаружено.
    if (session.socket) {
      log.info(`${session.label}: переподключение с ${from}, прежнее соединение закрыто`);
      const oldSocket = session.socket;
      session.socket = null;
      oldSocket.destroy();
    }
    session.socket = socket;
    socket.write(Buffer.concat([head, Buffer.from([1])]));
    socket.once('close', () => {
      if (session.socket === socket) {
        session.socket = null;
        log.info(`${session.label}: соединение с ${from} закрыто`);
        this.emit('disconnected', { label: session.label, address: from, deviceId: session.deviceId });
      }
    });
    if (serial) splicePackets(session, socket, rest);
    else splice(session.relay, socket, rest, session.label);
    log.info(`${session.label}: подключён ${from}`);
    this.emit('connected', { label: session.label, address: from, deviceId: session.deviceId });
  }

  async stop() {
    for (const s of [...this.sessions.values()]) this._close(s);
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
  }
}

// ------------------------------------------------------------------ клиент

/**
 * Подключающаяся сторона: тот, кто занял чужой интерфейс.
 *
 * Связь восстанавливается сама: пропавший на пару секунд маршрут не должен
 * отбирать у человека сеть. Прекращается переподключение в двух случаях —
 * остановкой (интерфейс освободили) и отказом владельца (токен больше не
 * действует: право отозвано, и heartbeat сейчас это же и подтвердит).
 */
export class LinkClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {boolean} [o.serial] — байтовый режим (COM-порт), а не кадры L2
   * @param {(type: number, payload: Buffer) => void} [o.onPacket] — для serial
   */
  constructor({ relay = null, host, port, token, label = 'канал', serial = false, onPacket = null }) {
    super();
    this.relay = relay;
    this.host = host;
    this.port = port;
    this.token = Buffer.from(token, 'hex');
    this.label = label;
    this.serial = serial;
    this.onPacket = onPacket;
    this.socket = null;
    this.stopped = false;
    this.retryMs = 1000;
    this.retryTimer = null;
    this.connectedAt = null;
  }

  /** Первое подключение: его ошибка — ошибка занятия. */
  async start() {
    await this._connect();
    return this;
  }

  get connected() {
    return Boolean(this.socket);
  }

  /**
   * Отправить владельцу кадр от своего имени — так, будто его отправил наш
   * адаптер. Нужно для объявления адреса (см. garpFrame в vswitch.js).
   *
   * Поток не собьётся: посредник пишет в сокет только целые кадры, и этот
   * кадр встаёт между ними, а не посреди.
   */
  inject(frame) {
    if (!this.socket || !frame?.length) return false;
    const buf = Buffer.allocUnsafe(2 + frame.length);
    buf.writeUInt16BE(frame.length, 0);
    frame.copy(buf, 2);
    return this.socket.write(buf);
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(e);
      };
      socket.setTimeout(HELLO_TIMEOUT_MS, () => fail(new Error('нет ответа')));
      socket.once('error', (e) => fail(e));

      socket.once('connect', async () => {
        const magic = this.serial ? SERIAL_MAGIC : MAGIC;
        socket.write(Buffer.concat([magic, this.token]));
        let reply;
        try {
          reply = await readHello(socket, magic.length + 1, HELLO_TIMEOUT_MS);
        } catch (e) {
          fail(e);
          return;
        }
        if (!reply.hello.subarray(0, magic.length).equals(magic) || reply.hello[magic.length] !== 1) {
          const e = new Error('владелец не принял соединение — право на интерфейс больше не действует');
          e.code = 'rejected';
          fail(e);
          return;
        }
        if (this.stopped) { fail(new Error('остановлено')); return; }

        settled = true;
        socket.setTimeout(0);
        socket.removeAllListeners('error');
        socket.on('error', (e) => log.debug(`${this.label}: ${e.message}`));
        this.socket = socket;
        this.connectedAt = Date.now();
        this.retryMs = 1000;
        if (this.serial) splicePackets(this, socket, reply.rest);
        else splice(this.relay, socket, reply.rest, this.label);
        socket.once('close', () => this._lost(socket));
        log.info(`${this.label}: соединение с ${this.host}:${this.port} установлено`);
        this.emit('connected');
        resolve();
      });
    });
  }

  /** Пакет владельцу (только serial-режим). false — буфер полон, нужен пауза/onceDrain. */
  send(type, payload) {
    const s = this.socket;
    return s ? s.write(packetFrame(type, payload)) : false;
  }

  pause() {
    this.socket?.pause();
  }

  resume() {
    this.socket?.resume();
  }

  onceDrain(cb) {
    this.socket?.once('drain', cb);
  }

  _lost(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    if (this.stopped) return;
    log.warn(`${this.label}: связь потеряна — переподключение`);
    this.emit('disconnected');
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.stopped) return;
      try {
        await this._connect();
      } catch (e) {
        if (e.code === 'rejected') {
          log.warn(`${this.label}: ${e.message}`);
          this.stopped = true;
          this.emit('rejected', e);
          return;
        }
        log.debug(`${this.label}: переподключение не удалось (${e.message})`);
        this.retryMs = Math.min(this.retryMs * 2, 15000);
        this._scheduleRetry();
      }
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  /** Посредник подняли заново — переподключаемся уже через него. */
  setRelay(relay) {
    this.relay = relay;
    this.socket?.destroy();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      s.destroy();
    }
  }
}
