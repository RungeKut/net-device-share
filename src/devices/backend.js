// Абстракция над реализацией USB/IP.
//
// Само проброшенное устройство появляется в «Диспетчере устройств» силами
// драйвера ядра (VHCI). Драйвер написать из прикладного кода нельзя, поэтому
// приложение опирается на существующие подписанные реализации USB/IP и берёт
// на себя всё остальное: обнаружение узлов, каталог, занятость, UI.
//
// Интерфейс намеренно узкий — под новую ОС достаточно реализовать эти методы.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { logger } from '../log.js';

const log = logger('usb');

/** Запуск внешней утилиты с таймаутом. Не бросает — возвращает результат. */
export function run(cmd, args = [], { timeoutMs = 15000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: e.message, spawnError: e.code || 'spawn_failed' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      resolve({ ok: false, code: -1, stdout, stderr: stderr || `таймаут ${timeoutMs} мс`, timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: e.message, spawnError: e.code || 'spawn_failed' });
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      log.trace(`${cmd} ${args.join(' ')} → ${code}`);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/** Строка в одинарных кавычках PowerShell: кавычка внутри удваивается. */
export function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Общая обёртка над PowerShell: кодировка и разбор JSON в одном месте. */
export async function psJson(script, { timeoutMs = 20000 } = {}) {
  // Без явной кодировки PowerShell пишет в перенаправленный поток в кодировке
  // консоли (на русской Windows — CP866), и кириллица приходит мусором.
  const full = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', full], { timeoutMs });
  if (!r.ok || !r.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    log.debug('не разобрался вывод PowerShell:', e.message);
    return [];
  }
}

export function firstExistingPath(candidates) {
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch { /* недоступный путь просто пропускаем */ }
  }
  return null;
}

/** Базовый класс: всё, что не реализовано, честно сообщает об этом. */
export class UsbBackend {
  constructor(opts = {}) {
    this.opts = opts;
    this.name = 'base';
  }

  /** Проверка окружения: что установлено, чего не хватает. */
  async probe() {
    return { available: false, server: false, client: false, tools: {}, issues: ['бэкенд не реализован'], notes: [] };
  }

  /** Локальные USB-устройства, пригодные для публикации. */
  async listLocal() { return []; }

  /** Опубликовать устройство (сделать доступным для подключения по сети). */
  async bind() { throw new Error('не поддерживается'); }

  /** Снять публикацию. */
  async unbind() { throw new Error('не поддерживается'); }

  /** Подключить удалённое устройство к своей машине. */
  async attach() { throw new Error('не поддерживается'); }

  /** Отключить ранее подключённое устройство. */
  async detach() { throw new Error('не поддерживается'); }

  /** Что сейчас подключено к этой машине через VHCI. */
  async listAttached() { return []; }
}

export async function createBackend(kind, opts) {
  const chosen = !kind || kind === 'auto'
    ? (process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'mock')
    : kind;

  switch (chosen) {
    case 'windows': {
      const { WindowsBackend } = await import('./windows.js');
      return new WindowsBackend(opts);
    }
    case 'linux': {
      const { LinuxBackend } = await import('./linux.js');
      return new LinuxBackend(opts);
    }
    case 'mock': {
      const { MockBackend } = await import('./mock.js');
      return new MockBackend(opts);
    }
    default:
      throw new Error(`неизвестный бэкенд: ${chosen}`);
  }
}
