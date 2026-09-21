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
// Одинаково в обе стороны. Полутора килобайт хватает на кадр Ethernet с
// запасом на теги VLAN, поэтому двух байтов длины достаточно.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../log.js';

const log = logger('tap');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELAY = path.join(ROOT, 'scripts', 'tap-relay.ps1');

/** Кадр Ethernet с запасом на теги VLAN — столько же, сколько у посредника. */
const MAX_FRAME = 2048;

/**
 * Сколько ждать готовности посредника.
 *
 * Внутри он компилирует вспомогательный код, и на холодной машине это
 * занимает заметное время — секунды, а не миллисекунды.
 */
const READY_TIMEOUT_MS = 20000;

export class TapRelay extends EventEmitter {
  /** @param {string} guid GUID сетевого интерфейса TAP-адаптера */
  constructor(guid) {
    super();
    this.guid = String(guid).replace(/[{}]/g, '');
    this.child = null;
    this.ready = false;
    this.stopping = false;
    this.rx = 0;
    this.tx = 0;
    this.rxFrames = 0;
    this.txFrames = 0;
    this._buf = Buffer.alloc(0);
    this.attached = null;
    this._onStdout = (chunk) => this._onData(chunk);
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
        reject(new Error(`посредник не ответил за ${READY_TIMEOUT_MS} мс`));
        this.stop();
      }, READY_TIMEOUT_MS);

      this.child.stdout.on('data', this._onStdout);

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
          log.warn(`посредник завершился: ${why}`);
          this.emit('closed', why);
          reject(new Error(why));
        }
      });
    });
  }

  /**
   * Разбор потока кадров.
   *
   * Канал отдаёт байты как придётся: кадр может прийти по частям, а может
   * несколько сразу. Поэтому накапливаем и отрезаем по длине.
   */
  _onData(chunk) {
    this.rx += chunk.length;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    while (this._buf.length >= 2) {
      const len = this._buf.readUInt16BE(0);
      if (len === 0 || len > MAX_FRAME) {
        log.error(`посредник прислал кадр длиной ${len} — обмен прекращён`);
        this.stop();
        return;
      }
      if (this._buf.length < 2 + len) return; // кадр ещё не целиком

      const frame = this._buf.subarray(2, 2 + len);
      this._buf = this._buf.subarray(2 + len);
      this.rxFrames++;
      this.emit('frame', Buffer.from(frame));
    }
  }

  /**
   * Сквозной режим: поток кадров уходит прямо в переданный поток.
   *
   * Формат обмена с посредником и формат на проводе совпадают, поэтому
   * связать их можно перекачкой, и кадры не попадают в JavaScript вовсе.
   * Через канал идёт весь трафик карты — разбирать каждый кадр в основном
   * процессе значило бы получить приложение, которое тормозит тем сильнее,
   * чем активнее им пользуются.
   *
   * Пока действует сквозной режим, событие «frame» не возникает.
   *
   * @param {import('node:stream').Duplex} duplex
   * @returns {object|null} null, если посредник не готов
   */
  attach(duplex) {
    if (!this.child || !this.ready) return null;
    if (this.attached) throw new Error('посредник уже переключён на сквозную передачу');

    this.child.stdout.removeListener('data', this._onStdout);
    if (this._buf.length) {
      // Хвост, накопленный до переключения, дописываем как есть: это
      // те же кадры в том же формате.
      duplex.write(this._buf);
      this._buf = Buffer.alloc(0);
    }

    this.child.stdout.pipe(duplex);
    // end: false — обрыв связи не должен закрывать ввод посредника:
    // адаптер остаётся поднятым и ждёт, пока подключатся заново.
    duplex.pipe(this.child.stdin, { end: false });

    this.attached = duplex;
    duplex.once('close', () => this.detach());
    return { detach: () => this.detach() };
  }

  /** Вернуться к разбору кадров внутри приложения. */
  detach() {
    if (!this.attached) return;
    const duplex = this.attached;
    this.attached = null;
    try {
      this.child?.stdout.unpipe(duplex);
      duplex.unpipe(this.child?.stdin);
    } catch { /* поток мог уже закрыться */ }
    if (this.child) this.child.stdout.on('data', this._onStdout);
  }

  /** Отправить кадр в адаптер. */
  write(frame) {
    if (!this.child || !this.ready) return false;
    if (this.attached) {
      log.warn('кадр не отправлен: посредник в сквозном режиме');
      return false;
    }
    if (!Buffer.isBuffer(frame) || !frame.length || frame.length > MAX_FRAME) {
      log.warn(`кадр длиной ${frame?.length} не отправлен: вне допустимого размера`);
      return false;
    }
    const header = Buffer.allocUnsafe(2);
    header.writeUInt16BE(frame.length, 0);
    const ok = this.child.stdin.write(header) && this.child.stdin.write(frame);
    this.tx += frame.length;
    this.txFrames++;
    return ok;
  }

  stats() {
    return {
      guid: this.guid,
      ready: this.ready,
      rxFrames: this.rxFrames,
      txFrames: this.txFrames,
      rxBytes: this.rx,
      txBytes: this.tx,
    };
  }

  async stop() {
    if (!this.child) return;
    this.stopping = true;
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
  2: 'адаптер не найден — проверьте, что драйвер установлен и адаптер создан',
  3: 'адаптер не удалось поднять (DeviceIoControl)',
};
