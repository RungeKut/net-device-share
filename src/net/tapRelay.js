// Работа с TAP-адаптером: кадры Ethernet в обе стороны.
//
// ПОЧЕМУ ЧЕРЕЗ ОТДЕЛЬНЫЙ ПРОЦЕСС. Чтение кадра из TAP блокирует поток, пока
// кадр не придёт. В Node такое чтение уходит в пул потоков libuv, а он на
// четыре потока: пара адаптеров исчерпала бы его целиком, и встало бы всё
// приложение — вместе с файловыми операциями, DNS и crypto. Поэтому
// блокируется отдельный процесс (scripts/tap-relay.ps1), а мы говорим с ним
// по каналам.
//
// Вторая причина та же, что и у COM-порта: адаптер нужно «включить» вызовом
// DeviceIoControl, а из Node он недоступен вовсе.
//
// ФОРМАТ. Длина кадра двумя байтами (старший первый), затем сам кадр.
// Одинаково в обе стороны и одинаково на проводе между машинами. Полутора
// килобайт хватает на кадр Ethernet с запасом на теги VLAN, поэтому двух
// байтов длины достаточно.
//
// ГРАНИЦЫ КАДРОВ. Кадры по-прежнему не разбираются на объекты: поток
// режется на куски, в каждом из которых только целые кадры, и эти куски
// уходят дальше как есть. Но следить за границами обязательно. Связь
// рвётся посреди кадра, и если просто переключить трубу на новое
// соединение, другая сторона прочтёт половину кадра как длину следующего —
// а посредник на такой поток отвечает завершением. Поэтому в посредника
// пишутся только целые кадры, и новый получатель получает поток с начала
// кадра, а не с середины.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../log.js';

const log = logger('tap');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELAY = path.join(ROOT, 'scripts', 'tap-relay.ps1');

/** Кадр Ethernet с запасом на теги VLAN — столько же, сколько у посредника. */
export const MAX_FRAME = 2048;

/**
 * Сколько ждать готовности посредника.
 *
 * Внутри он компилирует вспомогательный код, и на холодной машине это
 * занимает заметное время — секунды, а не миллисекунды.
 */
const READY_TIMEOUT_MS = 20000;

/**
 * Нарезка потока «длина + кадр» на куски из целых кадров.
 *
 * Отдаёт срезы исходных буферов, не копируя их. Копируется только хвост —
 * начатый, но не дошедший кадр, а он не длиннее одного кадра.
 */
export class FrameCutter {
  constructor(maxFrame = MAX_FRAME) {
    this.max = maxFrame;
    this.tail = null;
  }

  /**
   * @param {Buffer} chunk
   * @returns {Buffer|null} целые кадры подряд, либо null, если ни один не
   *   дошёл целиком
   * @throws если в потоке недопустимая длина — дальше его читать нельзя
   */
  push(chunk) {
    const buf = this.tail ? Buffer.concat([this.tail, chunk]) : chunk;
    let end = 0;
    while (buf.length - end >= 2) {
      const len = buf.readUInt16BE(end);
      if (len === 0 || len > this.max) {
        this.tail = null;
        throw new Error(`кадр недопустимой длины ${len}`);
      }
      if (buf.length - end < 2 + len) break;
      end += 2 + len;
    }
    this.tail = end < buf.length ? Buffer.from(buf.subarray(end)) : null;
    return end ? buf.subarray(0, end) : null;
  }

  reset() {
    this.tail = null;
  }
}

export class TapRelay extends EventEmitter {
  /** @param {string} guid GUID сетевого интерфейса TAP-адаптера */
  constructor(guid) {
    super();
    this.guid = String(guid).replace(/[{}]/g, '');
    this.child = null;
    this.ready = false;
    this.stopping = false;
    /** Байты из адаптера (то, что система отправила в «провод»). */
    this.fromTap = 0;
    /** Байты в адаптер (то, что пришло из «провода»). */
    this.toTap = 0;
    this._out = new FrameCutter();
    /** Куда уходят кадры из адаптера. Нет получателя — кадры отбрасываются. */
    this.sink = null;
  }

  start() {
    if (this.child) throw new Error('посредник уже запущен');

    return new Promise((resolve, reject) => {
      // -NoProfile обязателен: профиль пользователя может печатать что угодно
      // в поток вывода, а там у нас кадры.
      this.child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', RELAY, '-Guid', this.guid],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

      const timer = setTimeout(() => {
        reject(new Error(`посредник не ответил за ${READY_TIMEOUT_MS / 1000} с`));
        this.stop();
      }, READY_TIMEOUT_MS);

      this.child.stdout.on('data', (chunk) => this._fromAdapter(chunk));
      // Запись в посредника после его смерти даёт EPIPE. Это не авария
      // приложения: о завершении посредника и так сообщит событие exit.
      this.child.stdin.on('error', (e) => log.debug(`канал в посредника: ${e.message}`));

      // Диагностика посредника идёт в поток ошибок: поток вывода занят
      // кадрами и обязан оставаться двоично чистым.
      this.child.stderr.on('data', (d) => {
        const text = String(d).trim();
        if (!text) return;
        // Признак латиницей: поток ошибок может прийти в любой кодировке,
        // а искать в нём русские слова — значит зависеть от неё.
        if (!this.ready && text.includes('RELAY-READY')) {
          this.ready = true;
          clearTimeout(timer);
          log.info(`адаптер ${this.guid} поднят`);
          this.emit('ready');
          resolve(this);
          return;
        }
        log.debug(`посредник: ${text}`);
      });

      this.child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`посредник не запустился: ${e.message}`));
      });

      this.child.on('exit', (code) => {
        clearTimeout(timer);
        this.child = null;
        this.ready = false;
        if (!this.stopping) {
          const why = EXIT_REASONS[code] || `код ${code}`;
          log.warn(`посредник ${this.guid} завершился: ${why}`);
          this.emit('closed', why);
          reject(new Error(why));
        }
      });
    });
  }

  /** Поток из адаптера: целыми кадрами — получателю, если он есть. */
  _fromAdapter(chunk) {
    let frames;
    try {
      frames = this._out.push(chunk);
    } catch (e) {
      log.error(`посредник прислал ${e.message} — обмен прекращён`);
      this.stop();
      return;
    }
    if (!frames) return;
    this.fromTap += frames.length;

    const sink = this.sink;
    if (!sink) return;
    // Встречный напор: сеть не успевает — перестаём читать посредника,
    // и он притормозит чтение адаптера, а не наберёт гигабайт в память.
    if (!sink.write(frames) && this.child) {
      const out = this.child.stdout;
      out.pause();
      const resume = () => {
        sink.removeListener('drain', resume);
        sink.removeListener('close', resume);
        if (this.sink === sink || !this.sink) out.resume();
      };
      sink.once('drain', resume);
      sink.once('close', resume);
    }
  }

  /**
   * Назначить получателя кадров из адаптера.
   *
   * Поток уже выровнен по кадрам, так что новый получатель начинает ровно с
   * начала кадра.
   *
   * @param {import('node:stream').Writable|null} sink
   */
  setSink(sink) {
    this.sink = sink;
    // Если чтение стояло из-за прежнего получателя — возобновляем.
    if (this.child && this.child.stdout.isPaused()) this.child.stdout.resume();
  }

  /**
   * Отправить в адаптер целые кадры (один или несколько подряд).
   * @returns {boolean} false — посредник не успевает, подождите onceDrain
   */
  writeFrames(frames) {
    if (!this.child || !this.ready) return true;
    this.toTap += frames.length;
    return this.child.stdin.write(frames);
  }

  /** Сколько байт ждут отправки в посредника. */
  backlog() {
    return this.child ? this.child.stdin.writableLength : 0;
  }

  /** Ждать, пока посредник примет накопленное. */
  onceDrain(fn) {
    if (!this.child) { fn(); return; }
    this.child.stdin.once('drain', fn);
  }

  /** Отправить в адаптер один кадр. */
  write(frame) {
    if (!Buffer.isBuffer(frame) || !frame.length || frame.length > MAX_FRAME) {
      log.warn(`кадр длиной ${frame?.length} не отправлен: вне допустимого размера`);
      return false;
    }
    const header = Buffer.allocUnsafe(2);
    header.writeUInt16BE(frame.length, 0);
    return this.writeFrames(Buffer.concat([header, frame]));
  }

  stats() {
    return {
      guid: this.guid,
      ready: this.ready,
      fromTap: this.fromTap,
      toTap: this.toTap,
    };
  }

  async stop() {
    if (!this.child) return;
    this.stopping = true;
    this.sink = null;
    const child = this.child;

    // Закрытие потока ввода — это и есть просьба завершиться: посредник
    // увидит конец потока, опустит адаптер и выйдет сам.
    try { child.stdin.end(); } catch { /* уже закрыт */ }

    await new Promise((resolve) => {
      const kill = setTimeout(() => {
        log.warn('посредник не завершился сам — снимаем');
        try { child.kill(); } catch { /* уже мёртв */ }
        resolve();
      }, 3000);
      child.once('exit', () => { clearTimeout(kill); resolve(); });
    });

    this.child = null;
    this.ready = false;
    this.stopping = false;
  }
}

/** Коды возврата посредника — чтобы в журнале была причина, а не число. */
const EXIT_REASONS = {
  2: 'адаптер не найден или занят другой программой',
  3: 'адаптер не удалось поднять (DeviceIoControl)',
};
