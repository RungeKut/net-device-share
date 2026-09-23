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

const log = logger('tap-link');

const MAGIC = Buffer.from('NDL1', 'ascii');
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

  /**
   * Открыть сеанс для одного занятия.
   *
   * @param {object} o
   * @param {import('./tapRelay.js').TapRelay} o.relay
   * @param {string|null} [o.allowAddress] — пускать только с этого адреса
   * @param {string} [o.label] — как называть в журнале
   * @returns {{ token: string, close: () => void, connected: () => boolean,
   *   setRelay: (relay: object) => void }}
   */
  open({ relay, allowAddress = null, label = 'канал' }) {
    const token = newToken();
    const key = tokenKey(Buffer.from(token, 'hex'));
    const session = { key, relay, allowAddress: allowAddress ? normalizeIp(allowAddress) : null, label, socket: null };
    this.sessions.set(key, session);
    return {
      token,
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

  _close(session) {
    this.sessions.delete(session.key);
    if (session.socket) {
      session.socket.destroy();
      session.socket = null;
    }
  }

  async _accept(socket) {
    const from = normalizeIp(socket.remoteAddress);
    socket.on('error', (e) => log.debug(`канал: ${from} — ${e.message}`));

    const { hello, rest } = await readHello(socket, MAGIC.length + TOKEN_BYTES, HELLO_TIMEOUT_MS);
    const session = hello.subarray(0, MAGIC.length).equals(MAGIC)
      ? this.sessions.get(tokenKey(hello.subarray(MAGIC.length)))
      : null;

    if (!session || (session.allowAddress && session.allowAddress !== from)) {
      log.warn(`канал: отказ ${from} — ${session ? `ожидался адрес ${session.allowAddress}` : 'неизвестный токен'}`);
      socket.end(Buffer.concat([MAGIC, Buffer.from([0])]));
      return;
    }

    // Новое соединение того же держателя вытесняет прежнее: прежнее почти
    // наверняка уже мертво, просто это ещё не обнаружено.
    if (session.socket) {
      log.info(`${session.label}: переподключение с ${from}, прежнее соединение закрыто`);
      session.socket.destroy();
    }
    session.socket = socket;
    socket.write(Buffer.concat([MAGIC, Buffer.from([1])]));
    splice(session.relay, socket, rest, session.label);
    log.info(`${session.label}: подключён ${from}`);
    this.emit('connected', { label: session.label, address: from });

    socket.once('close', () => {
      if (session.socket === socket) session.socket = null;
      log.info(`${session.label}: соединение с ${from} закрыто`);
      this.emit('disconnected', { label: session.label, address: from });
    });
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
  constructor({ relay, host, port, token, label = 'канал' }) {
    super();
    this.relay = relay;
    this.host = host;
    this.port = port;
    this.token = Buffer.from(token, 'hex');
    this.label = label;
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
        socket.write(Buffer.concat([MAGIC, this.token]));
        let reply;
        try {
          reply = await readHello(socket, MAGIC.length + 1, HELLO_TIMEOUT_MS);
        } catch (e) {
          fail(e);
          return;
        }
        if (!reply.hello.subarray(0, MAGIC.length).equals(MAGIC) || reply.hello[MAGIC.length] !== 1) {
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
        splice(this.relay, socket, reply.rest, this.label);
        socket.once('close', () => this._lost(socket));
        log.info(`${this.label}: соединение с ${this.host}:${this.port} установлено`);
        this.emit('connected');
        resolve();
      });
    });
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
