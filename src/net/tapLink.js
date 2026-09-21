// Канал L2 между двумя машинами: кадры одного TAP-адаптера едут в другой.
//
// ГЛАВНОЕ РЕШЕНИЕ. Формат обмена с посредником и формат на проводе — один и
// тот же: длина кадра двумя байтами, затем кадр. Поэтому связать их можно
// простой перекачкой потоков, и кадры **не попадают в JavaScript вовсе**:
// Node только соединяет трубы, а дальше данные идут мимо него.
//
// Это не микрооптимизация. Через канал пойдёт весь трафик сетевой карты;
// разбирать каждый кадр в основном процессе значило бы получить приложение,
// которое тормозит тем сильнее, чем активнее им пользуются. По той же
// причине счётчик трафика USB/IP считает байты, а не разбирает пакеты.
//
// Обратная сторона: раз кадры мимо нас, то и фильтровать их нечем. Если
// понадобится ограничивать, что ходит через канал, это придётся делать
// либо в посреднике, либо мостом на стороне системы.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { logger } from '../log.js';

const log = logger('tap-link');

/** Столько ждём кадров, прежде чем счесть канал мёртвым. */
const IDLE_TIMEOUT_MS = 60000;

export class TapLink extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./tapRelay.js').TapRelay} o.relay — уже запущенный посредник
   * @param {string} [o.label] — как называть канал в журнале
   */
  constructor({ relay, label = 'канал' }) {
    super();
    this.relay = relay;
    this.label = label;
    this.server = null;
    this.socket = null;
    this.startedAt = null;
  }

  /** Принимающая сторона: ждём подключения того, кто занял интерфейс. */
  listen(port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        // Один канал — одно соединение. Второму вежливо отказываем, иначе
        // кадры пошли бы в два места сразу и адаптер сошёл бы с ума.
        if (this.socket) {
          log.warn(`${this.label}: уже занят, отклоняем ${socket.remoteAddress}`);
          socket.destroy();
          return;
        }
        this._join(socket);
      });

      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        log.info(`${this.label}: ожидание подключения на ${host}:${port}`);
        resolve(this);
      });
    });
  }

  /** Подключающаяся сторона: тот, кто занял чужой интерфейс. */
  connect(host, port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port }, () => {
        this._join(socket);
        resolve(this);
      });
      socket.once('error', (e) => reject(new Error(`${this.label}: не подключиться к ${host}:${port} — ${e.message}`)));
    });
  }

  /**
   * Сращивание: поток посредника в сокет и обратно.
   *
   * Обе стороны — потоки Node, поэтому встречный напор регулируется сам:
   * если сеть не успевает, чтение из адаптера притормозит, а не наберёт
   * гигабайт в память.
   */
  _join(socket) {
    this.socket = socket;
    this.startedAt = Date.now();
    socket.setNoDelay(true);       // кадры мелкие, задержка важнее упаковки
    socket.setTimeout(IDLE_TIMEOUT_MS);

    const from = `${socket.remoteAddress}:${socket.remotePort}`;
    log.info(`${this.label}: соединение с ${from}`);

    const streams = this.relay.attach(socket);
    if (!streams) {
      log.error(`${this.label}: посредник не готов — соединение закрыто`);
      socket.destroy();
      return;
    }

    socket.on('timeout', () => {
      log.warn(`${this.label}: ${IDLE_TIMEOUT_MS / 1000} с без кадров — соединение закрыто`);
      socket.destroy();
    });
    socket.on('error', (e) => log.warn(`${this.label}: ошибка соединения — ${e.message}`));
    socket.once('close', () => {
      log.info(`${this.label}: соединение с ${from} закрыто`);
      this.socket = null;
      this.emit('disconnected');
    });

    this.emit('connected', { address: socket.remoteAddress, port: socket.remotePort });
  }

  stats() {
    return {
      label: this.label,
      connected: Boolean(this.socket),
      since: this.startedAt,
      bytesIn: this.socket ? this.socket.bytesRead : 0,
      bytesOut: this.socket ? this.socket.bytesWritten : 0,
    };
  }

  async stop() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }
}
