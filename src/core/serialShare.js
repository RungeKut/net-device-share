// Проброс последовательного порта: COM владельца работает у занявшего.
//
//   ВЛАДЕЛЕЦ:  COMx ⇄ насос (helper.exe) ⇄ SerialShare ⇄ канал «NDS1»
//   ЗАНЯВШИЙ:  канал ⇄ (у занявшего порт появится в этапе C — пара com0com)
//
// Чистый Node не умеет SetCommState: параметры порта и линии задаёт Windows,
// поэтому насос — маленькая консольная программа на C#, собираемая на месте
// через PowerShell Add-Type (npm-зависимостей не появляется). Насос открывает
// порт, читает и пишет байты, сообщает линии CTS/DSR/DCD и применяет то, что
// просит канал: параметры, RTS/DTR, Break. С процессом приложения он говорит
// теми же пакетами, что едут по каналу (serialLink.js), — один формат на оба
// плеча пути.
//
// Параметры, с которыми порт был открыт насосом, запоминаются в настройках
// (serialRestore — по образцу netRestore у карт): занявший меняет их под
// себя, при освобождении возвращаются прежние — даже если приложение
// перезапускали, тогда это делает recover при старте.
//
// LPT здесь нет: вывод — в этапе D, тем же насосом, только запись.
//
// Драйвер порта не пишем и com0com не модифицируем: насос — обычный клиент
// Win32 SerialPort.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger } from '../log.js';
import { run, psQuote } from '../devices/backend.js';
import { configDir } from '../config.js';
import { LinkClient } from '../net/tapLink.js';
import {
  PKT, PacketCutter, packetFrame, encodePortParams, parsePortParams,
  CTRL_RTS_ON, CTRL_RTS_OFF, CTRL_DTR_ON, CTRL_DTR_OFF,
  MSR_CTS, MSR_DSR,
} from '../net/serialLink.js';
import { createPair, removePair, setupcPresent } from '../net/com0com.js';

const log = logger('serial-share');

/** Сколько ждать от насоса: открытия порта и подтверждения параметров. */
const PUMP_TIMEOUT_MS = 10000;

// Протокол насоса по stdin/stdout; формат кадра тот же, что в канале.
export const PUMP = {
  WRITE: 1,          // байты в порт
  PARAMS: 2,         // применить параметры
  CTRL: 3,           // линии RTS/DTR
  BREAK: 4,          // Break на мс
  CLOSE: 5,          // закрыть порт и выйти
  READY: 0x20,       // порт открыт: параметры и линии
  DATA: 0x21,        // байты из порта
  MSR: 0x22,         // линии CTS/DSR/DCD
  PARAMS_RESULT: 0x23, // 1 — параметры применились
  ERROR: 0x24,       // сообщение о проблеме
};

const PUMP_SOURCE = `
using System;
using System.IO;
using System.IO.Ports;
using System.Text;
using System.Threading;

// Насос последовательного порта: открывает порт из argv, по stdin/stdout
// говорит бинарными кадрами [u16 длина][u8 тип][данные] — типы см. PUMP в
// core/serialShare.js. Линии выхода (RTS/DTR) и параметры держит сам; линии
// входа опрашивает: у SerialPort уровня RI нет, поэтому CTS/DSR/DCD.
public static class Pump
{
    const byte CTS = 0x10, DSR = 0x20, DCD = 0x80;

    static SerialPort port;
    static object ioLock = new object();
    static Stream stdOut;

    static int Main(string[] args)
    {
        stdOut = Console.OpenStandardOutput();
        try
        {
            port = new SerialPort(args[0]);
            port.ReadBufferSize = 65536;
            port.WriteBufferSize = 65536;
            port.Open();
        }
        catch (Exception e)
        {
            Send(0x24, Encoding.UTF8.GetBytes(e.Message));
            return 1;
        }

        port.DataReceived += OnData;
        Send(0x20, Ready());
        var lines = new Thread(PollLines);
        lines.IsBackground = true;
        lines.Start();

        Stream stdin = Console.OpenStandardInput();
        while (true)
        {
            byte[] head = ReadExact(stdin, 3);
            if (head == null) break;
            int len = head[0] | (head[1] << 8);
            byte[] body = ReadExact(stdin, len - 1);
            if (body == null) break;
            if (!Handle(head[2], body)) break;
        }
        try { port.Close(); } catch {}
        return 0;
    }

    static bool Handle(byte type, byte[] body)
    {
        try
        {
            switch (type)
            {
                case 1:
                    if (body.Length > 0) port.Write(body, 0, body.Length);
                    return true;
                case 2:
                    port.BaudRate = (int)ReadU32(body, 0);
                    port.Parity = (Parity)body[4];
                    port.DataBits = body[5];
                    port.StopBits = MapStop(body[6]);
                    Send(0x23, new byte[] { 1 });
                    return true;
                case 3:
                    if ((body[0] & 1) != 0) port.RtsEnable = true;
                    if ((body[0] & 2) != 0) port.RtsEnable = false;
                    if ((body[0] & 4) != 0) port.DtrEnable = true;
                    if ((body[0] & 8) != 0) port.DtrEnable = false;
                    return true;
                case 4:
                    int ms = body[0] | (body[1] << 8);
                    port.BreakState = true;
                    Thread.Sleep(ms);
                    port.BreakState = false;
                    return true;
                default:
                    return false;
            }
        }
        catch (Exception e)
        {
            Send(0x24, Encoding.UTF8.GetBytes(e.Message));
            return true;
        }
    }

    static void OnData(object sender, SerialDataReceivedEventArgs e)
    {
        try
        {
            var buf = new byte[8192];
            while (true)
            {
                int n = port.BytesToRead;
                if (n <= 0) return;
                if (n > buf.Length) n = buf.Length;
                int got = port.Read(buf, 0, n);
                if (got <= 0) return;
                var part = new byte[got];
                Array.Copy(buf, part, got);
                Send(0x21, part);
            }
        }
        catch (Exception ex)
        {
            Send(0x24, Encoding.UTF8.GetBytes(ex.Message));
        }
    }

    static void PollLines()
    {
        byte last = 0xFF;
        while (true)
        {
            try
            {
                byte m = Lines();
                if (m != last) { last = m; Send(0x22, new byte[] { m }); }
            }
            catch { return; }
            Thread.Sleep(100);
        }
    }

    static byte Lines()
    {
        byte m = 0;
        if (port.CtsHolding) m |= CTS;
        if (port.DsrHolding) m |= DSR;
        if (port.CDHolding) m |= DCD;
        return m;
    }

    static byte[] Ready()
    {
        var b = new byte[8];
        WriteU32(b, 0, (uint)port.BaudRate);
        b[4] = (byte)port.Parity;
        b[5] = (byte)port.DataBits;
        b[6] = port.StopBits == StopBits.OnePointFive ? (byte)1 : port.StopBits == StopBits.Two ? (byte)2 : (byte)0;
        b[7] = Lines();
        return b;
    }

    static StopBits MapStop(byte v)
    {
        if (v == 1) return StopBits.OnePointFive;
        if (v == 2) return StopBits.Two;
        return StopBits.One;
    }

    static byte[] ReadExact(Stream s, int n)
    {
        var buf = new byte[n];
        int at = 0;
        while (at < n)
        {
            int got = s.Read(buf, at, n - at);
            if (got <= 0) return null;
            at += got;
        }
        return buf;
    }

    static void Send(byte type, byte[] payload)
    {
        if (payload == null) payload = new byte[0];
        lock (ioLock)
        {
            var head = new byte[] { (byte)((payload.Length + 1) >> 8), (byte)(payload.Length + 1), type };
            stdOut.Write(head, 0, 3);
            stdOut.Write(payload, 0, payload.Length);
            stdOut.Flush();
        }
    }

    static void WriteU32(byte[] b, int at, uint v)
    {
        b[at] = (byte)(v >> 24); b[at + 1] = (byte)(v >> 16); b[at + 2] = (byte)(v >> 8); b[at + 3] = (byte)v;
    }

    static uint ReadU32(byte[] b, int at)
    {
        return ((uint)b[at] << 24) | ((uint)b[at + 1] << 16) | ((uint)b[at + 2] << 8) | b[at + 3];
    }
}
`;

let compiling = null;

/**
 * Собрать насос, если ещё нет. Кэш — в каталоге настроек: переезд приложения
 * при обновлении его не теряет, а новая версия исходников даёт новое имя.
 */
export async function buildPump() {
  const dir = path.join(configDir(), 'serial-pump');
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha256').update(PUMP_SOURCE).digest('hex').slice(0, 8);
  const exe = path.join(dir, `ndspump-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;
  if (compiling) return compiling;

  compiling = (async () => {
    const cs = path.join(dir, 'pump.cs');
    // BOM: без него csc читает файл в кодировке консоли и ломает кириллицу комментариев.
    fs.writeFileSync(cs, '\ufeff' + PUMP_SOURCE, 'utf8');
    const script = `Add-Type -Path ${psQuote(cs)} -OutputAssembly ${psQuote(exe)} -OutputType ConsoleApplication`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 180000 });
    if (!r.ok || !fs.existsSync(exe)) {
      throw new Error(`насос не собрался: ${(r.stderr || r.stdout || '').trim().slice(-200) || 'PowerShell ничего не ответил'}`);
    }
    // Прошлые версии насоса больше не нужны.
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('ndspump-') && f.endsWith('.exe') && f !== path.basename(exe)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
    return exe;
  })();

  try {
    return await compiling;
  } finally {
    compiling = null;
  }
}

function spawnPump(exe, com) {
  return spawn(exe, [com], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

/** Кадры насоса, разобранные на события: ready, data, msr, params, pumpError, exit. */
class PumpProc extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-300); });
    // Насос мог умереть, а мы что-то дописываем: EPIPE — не авария приложения.
    this.stdin.on('error', (e) => log.debug(`насос: stdin — ${e.message}`));

    const cutter = new PacketCutter();
    this.stdout.on('data', (chunk) => {
      let packets;
      try {
        packets = cutter.push(chunk);
      } catch (e) {
        this.emit('pumpError', e.message);
        return;
      }
      for (const p of packets) this._dispatch(p.type, p.payload);
    });
    child.on('exit', (code) => this.emit('exit', code, stderr.trim()));
    child.on('error', (e) => this.emit('exit', -1, e.message));
  }

  _dispatch(type, payload) {
    switch (type) {
      case PUMP.READY:
        this.emit('ready', parsePortParams(payload), payload[7] || 0);
        break;
      case PUMP.DATA:
        this.emit('data', payload);
        break;
      case PUMP.MSR:
        this.emit('msr', payload[0]);
        break;
      case PUMP.PARAMS_RESULT:
        this.emit('params', payload[0] === 1);
        break;
      case PUMP.ERROR:
        this.emit('pumpError', payload.toString('utf8'));
        break;
    }
  }

  write(bytes) {
    return this.stdin.write(packetFrame(PUMP.WRITE, bytes));
  }

  setParams(params) {
    return this.stdin.write(packetFrame(PUMP.PARAMS, encodePortParams(params)));
  }

  ctrl(mask) {
    return this.stdin.write(packetFrame(PUMP.CTRL, Buffer.from([mask])));
  }

  breakFor(ms) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(ms, 0);
    return this.stdin.write(packetFrame(PUMP.BREAK, b));
  }

  close() {
    try {
      this.stdin.write(packetFrame(PUMP.CLOSE));
      this.stdin.end();
    } catch { /* насос уже умер — закрытие сделало само */ }
  }

  kill() {
    try {
      this.child.kill();
    } catch { /* нечего убивать */ }
  }
}

function errWith(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export class SerialShare extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('../config.js').Config} o.config
   * @param {boolean} [o.supported] — подмена платформы для тестов
   * @param {{ compile?: () => Promise<string>, spawn?: (exe: string, com: string) => object }} [o.pump]
   *   подмена насоса для тестов (эмуляция пайпами вместо процесса)
   */
  constructor({ config, supported, pump = {}, com0com = null } = {}) {
    super();
    this.config = config;
    this.supported = supported ?? process.platform === 'win32';
    this.server = null;
    /** @type {Map<string, object>} deviceId → отданный порт */
    this.lends = new Map();
    /** @type {Map<string, object>} ключ занятия → взятый порт */
    this.borrows = new Map();
    this._compile = pump.compile || buildPump;
    this._spawn = pump.spawn || spawnPump;
    this._com0com = com0com || { createPair, removePair, present: setupcPresent };
  }

  /** Канал берётся у NetShare (его LinkServer): свой порт заводить не нужно. */
  async start({ server }) {
    this.server = server || null;
    if (!this.supported) return this;
    // Насос собирается заранее: к моменту занятия он нужен мгновенно, а
    // первая сборка через csc занимает десятки секунд.
    this._compile().catch((e) => log.debug(`насос заранее не собран: ${e.message}`));
    if (!this.server) return this;
    await this._recover();
    await this._recoverPairs();
    return this;
  }

  async stop() {
    for (const lend of [...this.lends.values()]) {
      await this._teardown(lend).catch((e) => log.warn(`при выходе: ${e.message}`));
    }
    for (const b of [...this.borrows.values()]) {
      await this._stopBorrow(b).catch((e) => log.warn(`при выходе: ${e.message}`));
    }
  }

  /** Почему этот порт нельзя пробросить (null — можно). */
  lendBlocker(dev) {
    if (!this.supported) return 'проброс COM-портов пока есть только на Windows';
    if (dev.type !== 'com') return 'по сети пробрасываются только последовательные порты';
    if (!this.server) return 'канал для байтов не запущен';
    return null;
  }

  // ------------------------------------------------------ сторона владельца

  /**
   * Отдать порт держателю: поднять насос и открыть байтовый сеанс.
   *
   * @param {object} dev — устройство из ShareManager
   * @param {{ holderId: string, holderAddress?: string|null }} holder
   * @returns {Promise<{ port: number, token: string, mode: 'serial', params: object }>}
   *   params — с чем порт открыт: занявший поставит их своему виртуальному порту
   */
  async lend(dev, { holderId, holderAddress = null } = {}) {
    const blocker = this.lendBlocker(dev);
    if (blocker) throw errWith('unavailable', blocker);

    const existing = this.lends.get(dev.deviceId);
    if (existing) {
      if (existing.holderId === holderId && existing.session) return this._grant(existing);
      // Порт передаётся другому держателю: прежний пропуск больше не действует.
      existing.session.close();
      this._openSession(existing, holderId, holderAddress);
      log.info(`порт «${existing.com}» передан другому держателю`);
      return this._grant(existing);
    }

    const lend = {
      deviceId: dev.deviceId,
      com: dev.key,
      name: dev.description || dev.title,
      pump: null,
      session: null,
      holderId: null,
      params: null,
      failed: null,
      stopped: false,
    };
    this.lends.set(dev.deviceId, lend);
    try {
      lend.pump = await this._startPump(lend);
      this._remember(lend);
      this._openSession(lend, holderId, holderAddress);
      log.info(`порт «${lend.com}» отдан, канал на порту ${this.config.get('netLinkPort')}`);
      this.emit('changed');
      return this._grant(lend);
    } catch (e) {
      log.error(`порт «${dev.key}» отдать не удалось: ${e.message}`);
      await this._teardown(lend);
      throw e;
    }
  }

  async unlend(dev) {
    const lend = this.lends.get(dev.deviceId);
    if (!lend) return { ok: true };
    this.lends.delete(dev.deviceId);
    await this._teardown(lend);
    return { ok: true };
  }

  /** Запустить насос на порту и дождаться, когда он его откроет. */
  async _openPump(com) {
    const exe = await this._compile();
    const pump = new PumpProc(this._spawn(exe, com));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('насос не открыл порт')), PUMP_TIMEOUT_MS);
      pump.once('ready', (params, msr) => { clearTimeout(timer); resolve({ params, msr }); });
      pump.once('pumpError', (m) => { clearTimeout(timer); reject(new Error(m)); });
      pump.once('exit', (code, err) => { clearTimeout(timer); reject(new Error(`насос завершился (${code}): ${err || 'без сообщений'}`)); });
    });
    return { pump, ready };
  }

  async _startPump(lend) {
    const { pump, ready } = await this._openPump(lend.com);
    lend.params = ready.params;

    pump.on('data', (bytes) => {
      if (lend.stopped) return;
      if (!lend.session?.send(PKT.DATA, bytes)) {
        pump.stdout.pause();
        lend.session?.onceDrain(() => pump.stdout.resume());
      }
    });
    pump.on('msr', (mask) => lend.session?.send(PKT.MSR, Buffer.from([mask])));
    pump.on('params', (ok) => lend.session?.send(PKT.PARAMS_RESULT, Buffer.from([ok ? 1 : 0])));
    pump.on('pumpError', (m) => log.warn(`порт «${lend.com}»: ${m}`));
    pump.on('exit', (code, err) => {
      if (lend.stopped) return;
      lend.failed = `насос порта завершился (${code})${err ? `: ${err}` : ''}`;
      log.warn(`порт «${lend.com}»: ${lend.failed} — соединение с держателем закрыто`);
      lend.session?.close();
      this.emit('changed');
    });

    lend.onPacket = (type, payload) => {
      if (lend.stopped) return;
      switch (type) {
        case PKT.DATA:
          if (payload.length && !pump.write(payload)) {
            lend.session?.pause();
            pump.stdin.once('drain', () => lend.session?.resume());
          }
          break;
        case PKT.PARAMS:
          if (payload.length) pump.setParams(parsePortParams(payload));
          break;
        case PKT.CTRL:
          if (payload.length) pump.ctrl(payload[0]);
          break;
        case PKT.BREAK:
          if (payload.length >= 2) pump.breakFor(Math.min(payload.readUInt16BE(0), 10000));
          break;
        // MSR, PARAMS_RESULT, ERROR — только от владельца; клиент их не шлёт.
      }
    };
    return pump;
  }

  _openSession(lend, holderId, holderAddress) {
    lend.session = this.server.openSerial({
      onPacket: (type, payload) => lend.onPacket(type, payload),
      // Свой компьютер ходит к себе с адреса, а не с петли — адрес здесь не сужаем.
      allowAddress: holderAddress && !/^127\.|^::1$/.test(holderAddress) ? holderAddress : null,
      label: `порт «${lend.com}»`,
      deviceId: lend.deviceId,
    });
    lend.holderId = holderId;
  }

  _grant(lend) {
    return {
      port: this.config.get('netLinkPort'),
      token: lend.session.token,
      mode: 'serial',
      com: lend.com,
      params: lend.params,
    };
  }

  /** Исходные параметры — в настройки: вернуть их надо даже после перезапуска. */
  _remember(lend) {
    const held = { ...(this.config.get('serialRestore') || {}) };
    held[lend.deviceId] = { com: lend.com, name: lend.name, params: lend.params };
    this.config.set({ serialRestore: held });
  }

  async _teardown(lend) {
    lend.stopped = true;
    lend.session?.close();
    lend.session = null;
    const held = { ...(this.config.get('serialRestore') || {}) };
    delete held[lend.deviceId];
    this.config.set({ serialRestore: held });
    if (lend.pump) {
      try {
        if (lend.params) await this._applyParams(lend.pump, lend.params);
        lend.pump.close();
        await this._waitExit(lend.pump);
        log.info(`порт «${lend.com}» возвращён владельцу`);
      } catch (e) {
        log.warn(`порт «${lend.com}» закрыт с ошибкой: ${e.message}`);
        lend.pump.kill();
      }
      lend.pump = null;
    }
    this.emit('changed');
  }

  async _applyParams(pump, params) {
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), PUMP_TIMEOUT_MS);
      pump.once('params', (good) => { clearTimeout(timer); resolve(good); });
      pump.setParams(params);
    });
    if (!ok) throw new Error('параметры порта не применены');
  }

  _waitExit(pump, ms = 3000) {
    return new Promise((resolve) => {
      if (pump.child.exitCode !== null || pump.child.signalCode) return resolve();
      const t = setTimeout(() => { pump.kill(); resolve(); }, ms);
      pump.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  /**
   * Прошлый запуск завершился, не вернув параметры порта: насос открывает
   * порт, возвращает прежние параметры и сразу закрывается. Порта может уже
   * не быть — тогда запись всё равно гасим.
   */
  async _recover() {
    const held = { ...(this.config.get('serialRestore') || {}) };
    for (const [deviceId, rec] of Object.entries(held)) {
      delete held[deviceId];
      this.config.set({ serialRestore: held });
      try {
        await this._withPump(rec.com, (pump, ready) => this._applyParams(pump, rec.params || ready.params));
        log.info(`порту «${rec.com}» возвращены прежние параметры`);
      } catch (e) {
        log.warn(`параметры порта «${rec.com}» не возвращены: ${e.message}`);
      }
    }
  }

  /** Насос на короткую работу: открыл, сделал — закрылся. */
  async _withPump(com, fn) {
    const exe = await this._compile();
    const pump = new PumpProc(this._spawn(exe, com));
    try {
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('насос не открыл порт')), PUMP_TIMEOUT_MS);
        pump.once('ready', (params, msr) => { clearTimeout(timer); resolve({ params, msr }); });
        pump.once('pumpError', (m) => { clearTimeout(timer); reject(new Error(m)); });
        pump.once('exit', (code, err) => { clearTimeout(timer); reject(new Error(`насос завершился (${code}): ${err || 'без сообщений'}`)); });
      });
      return await fn(pump, ready);
    } finally {
      pump.close();
      await this._waitExit(pump);
    }
  }

  // ------------------------------------------------------ сторона занявшего

  /** Почему этот компьютер не может занять чужой COM-порт (null — может). */
  borrowBlocker() {
    if (!this.supported) return 'подключать чужие COM-порты пока можно только на Windows';
    if (!this._com0com.present()) return 'нет com0com — доустановите компоненты приложения';
    return null;
  }

  /**
   * Взять чужой COM-порт: пара com0com, наш конец под насосом, второй —
   * под именем порта владельца.
   *
   * Линии едут через штатную перекрёстную проводку пары: CTS владельца
   * выставляет наш RTS (у человека это CTS его порта), человек выставляет
   * RTS — у владельца уходит CTRL на настоящий RTS. DCD и RING так не
   * передаются.
   *
   * @param {object} o
   * @param {string} o.key — ключ занятия (узел + устройство)
   * @param {string} o.host — адрес владельца
   * @param {number} o.port — порт канала у владельца
   * @param {string} o.token — пропуск, выданный владельцем
   * @param {string} [o.com] — имя порта владельца («COM12»), под ним появится наш
   * @param {object|null} [o.params] — параметры порта владельца; применяются нашему концу
   * @param {string} [o.label]
   * @param {(stage: string) => void} [o.onStage]
   * @returns {Promise<{ com: string, params: object|null, note: string|null }>}
   */
  async borrow({ key, host, port, token, com = null, params = null, label = 'порт', onStage = () => {} }) {
    const blocker = this.borrowBlocker();
    if (blocker) throw errWith('unavailable', blocker);
    if (this.borrows.has(key)) await this.giveBack(key);

    const b = {
      key, pair: null, pump: null, client: null, stopped: false, label,
      params: null, failed: null, note: null, ownerLines: null, localLines: null,
    };
    this.borrows.set(key, b);
    try {
      onStage('создаётся пара виртуальных портов');
      b.pair = await this._com0com.createPair(com || null);
      this._rememberPair(b);
      // Имя владельца могло не достаться: рядом с парой живёт объяснение.
      b.note = b.pair.theirsNote || null;

      onStage('открывается наш конец пары');
      const { pump } = await this._openPump(b.pair.ours);
      b.pump = pump;
      // Насос начинается слушать раньше сети: байты из порта человека не
      // теряются за время подключения к владельцу.
      pump.on('data', (bytes) => {
        if (b.stopped) return;
        if (!b.client?.send(PKT.DATA, bytes)) {
          pump.stdout.pause();
          b.client?.onceDrain(() => pump.stdout.resume());
        }
      });
      // Человек выставил линии на своём порту: доезжают до владельца как RTS/DTR.
      pump.on('msr', (mask) => this._localLinesChanged(b, mask));
      pump.on('exit', (code, err) => {
        if (b.stopped) return;
        b.failed = `насос порта завершился (${code})${err ? `: ${err}` : ''}`;
        log.warn(`порт «${b.pair.theirs}»: ${b.failed} — соединение с владельцем закрыто`);
        b.client?.stop();
        this.emit('changed');
      });

      if (params) {
        await this._applyParams(pump, params);
        b.params = params;
      }

      onStage('подключение к порту владельца');
      b.client = new LinkClient({ host, port, token, label: `порт «${b.pair.theirs}»`, serial: true, onPacket: (t, p) => this._netPacket(b, t, p) });
      b.client.on('connected', () => this.emit('changed'));
      b.client.on('disconnected', () => this.emit('changed'));
      b.client.on('rejected', () => this.emit('changed'));
      await this._connect(b.client);

      log.info(`чужой порт подключён как «${b.pair.theirs}» (наш конец «${b.pair.ours}»), канал на ${host}:${port}`);
      this.emit('changed');
      return { com: b.pair.theirs, params: b.params, note: b.note };
    } catch (e) {
      await this._stopBorrow(b);
      throw e;
    }
  }

  /** Первое подключение к каналу — с повторами, как у сетевых карт. */
  async _connect(client, attempts = 4) {
    for (let i = 1; ; i++) {
      try {
        await client.start();
        return;
      } catch (e) {
        if (e.code === 'rejected' || i >= attempts) throw e;
        log.debug(`${client.label}: канал не ответил (${e.message}), попытка ${i} из ${attempts}`);
        await new Promise((r) => setTimeout(r, 1500 * i));
      }
    }
  }

  _netPacket(b, type, payload) {
    if (b.stopped) return;
    switch (type) {
      case PKT.DATA:
        if (payload.length && !b.pump.write(payload)) {
          b.client?.pause();
          b.pump.stdin.once('drain', () => b.client?.resume());
        }
        break;
      // Линии владельца — к перекрёстной проводке нашего конца: CTS владельца
      // станет RTS у нас, и человек увидит его как CTS своего порта.
      case PKT.MSR: {
        const want = { rts: Boolean(payload[0] & MSR_CTS), dtr: Boolean(payload[0] & MSR_DSR) };
        const sig = `${want.rts ? 1 : 0}${want.dtr ? 1 : 0}`;
        if (sig !== b.ownerLines) {
          b.ownerLines = sig;
          b.pump.ctrl((want.rts ? CTRL_RTS_ON : CTRL_RTS_OFF) | (want.dtr ? CTRL_DTR_ON : CTRL_DTR_OFF));
        }
        break;
      }
      case PKT.ERROR:
        b.failed = payload.toString('utf8');
        log.warn(`порт владельца: ${b.failed}`);
        this.emit('changed');
        break;
      // PARAMS, PARAMS_RESULT от владельца не приходят: параметры — слово клиента.
    }
  }

  _localLinesChanged(b, mask) {
    if (b.stopped) return;
    const want = { rts: Boolean(mask & MSR_CTS), dtr: Boolean(mask & MSR_DSR) };
    const sig = `${want.rts ? 1 : 0}${want.dtr ? 1 : 0}`;
    if (sig === b.localLines) return;
    b.localLines = sig;
    b.client?.send(PKT.CTRL, Buffer.from([(want.rts ? CTRL_RTS_ON : CTRL_RTS_OFF) | (want.dtr ? CTRL_DTR_ON : CTRL_DTR_OFF)]));
  }

  _rememberPair(b) {
    const held = { ...(this.config.get('serialPairs') || {}) };
    held[b.key] = { id: b.pair.id, ours: b.pair.ours, theirs: b.pair.theirs };
    this.config.set({ serialPairs: held });
  }

  async giveBack(key) {
    const b = this.borrows.get(key);
    if (!b) return;
    await this._stopBorrow(b);
    log.info(`порт «${b.pair?.theirs}» отключён`);
    this.emit('changed');
  }

  async _stopBorrow(b) {
    b.stopped = true;
    this.borrows.delete(b.key);
    const held = { ...(this.config.get('serialPairs') || {}) };
    delete held[b.key];
    this.config.set({ serialPairs: held });
    b.client?.stop();
    if (b.pump) {
      b.pump.close();
      await this._waitExit(b.pump);
      b.pump = null;
    }
    if (b.pair) {
      await this._com0com.removePair(b.pair.id).catch((e) => log.warn(`пара портов ${b.pair.id} не убрана: ${e.message}`));
      b.pair = null;
    }
    this.emit('changed');
  }

  /** Пары, оставшиеся от прошлого запуска: приложение могло упасть с занятым портом. */
  async _recoverPairs() {
    const held = { ...(this.config.get('serialPairs') || {}) };
    for (const [key, rec] of Object.entries(held)) {
      delete held[key];
      this.config.set({ serialPairs: held });
      try {
        await this._com0com.removePair(rec.id);
        log.info(`убрана пара портов прошлого запуска (${rec.theirs})`);
      } catch (e) {
        log.warn(`пара ${rec.id} (${rec.theirs}) не убрана: ${e.message}`);
      }
    }
  }

  describe() {
    return {
      lends: [...this.lends.values()].map((l) => ({
        deviceId: l.deviceId,
        com: l.com,
        holderId: l.holderId,
        connected: Boolean(l.session?.connected()),
        params: l.params,
        failed: l.failed || null,
      })),
      borrows: [...this.borrows.values()].map((b) => ({
        key: b.key,
        com: b.pair?.theirs || null,
        ours: b.pair?.ours || null,
        connected: Boolean(b.client?.connected),
        params: b.params,
        failed: b.failed || null,
      })),
    };
  }
}
