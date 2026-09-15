// Установка недостающих компонентов USB/IP из вложенных в проект файлов.
//
// Зачем вложенные установщики, а не скачивание по требованию: приложение
// нередко разворачивают там, где выхода в интернет нет вовсе — в цеху, в
// изолированном сегменте, на стенде. Файл, лежащий рядом, ставится всегда.
//
// Перед запуском каждый файл проверяется дважды: SHA-256 по манифесту и
// подпись Authenticode. Мы запускаем установщик драйвера ядра с правами
// администратора — на слово ему верить нельзя.
//
// Все компоненты ставятся одним повышенным процессом, чтобы запрос UAC
// был один, а не по одному на каждый файл.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { logger } from '../log.js';
import { run } from '../usb/backend.js';

const log = logger('installer');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Переопределение каталога нужно двум сценариям: сборке дистрибутива, где
// установщики лежат отдельно от кода, и автотестам механики установки.
const INSTALLERS_DIR = process.env.NDS_INSTALLERS_DIR
  ? path.resolve(process.env.NDS_INSTALLERS_DIR)
  : path.join(ROOT, 'installers');

export class Installer extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => Promise<object>} o.reprobe — перепроверить окружение после установки
   * @param {() => object} o.backendInfo — текущее состояние окружения
   */
  constructor({ reprobe, backendInfo }) {
    super();
    this.reprobe = reprobe;
    this.getBackendInfo = backendInfo;
    this.state = 'idle'; // idle | running | done | error
    this.catalog = [];   // заполняется в init()
    this.steps = [];
    this.startedAt = null;
    this.finishedAt = null;
    this.error = null;
  }

  _step(level, text) {
    const rec = { ts: Date.now(), level, text };
    this.steps.push(rec);
    if (this.steps.length > 200) this.steps.shift();
    log[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](text);
    this.emit('changed');
  }

  async readManifest() {
    try {
      const raw = await fsp.readFile(path.join(INSTALLERS_DIR, 'manifest.json'), 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data.components) ? data.components : [];
    } catch (e) {
      if (e.code !== 'ENOENT') log.warn('манифест установщиков не прочитан:', e.message);
      return [];
    }
  }

  /**
   * Разовое чтение манифеста и проверка наличия файлов.
   * Состав вложенных установщиков за время работы не меняется, а снимок
   * состояния строится синхронно — поэтому дорогая часть считается один раз.
   */
  async init() {
    const all = await this.readManifest();
    this.catalog = all
      .filter((c) => c.platform === process.platform)
      .map((c) => {
        const file = path.join(INSTALLERS_DIR, c.file);
        let size = null;
        try {
          size = fs.statSync(file).size;
        } catch { /* файла нет — отметим ниже */ }
        return {
          id: c.id,
          title: c.title,
          description: c.description,
          signerNote: c.signerNote || null,
          role: c.role,
          version: c.version,
          sourceUrl: c.sourceUrl,
          project: c.project,
          fileAvailable: size !== null,
          sizeMb: size === null ? null : Math.round((size / 1048576) * 10) / 10,
        };
      });
    return this;
  }

  /** Текущий план — синхронно, для снимка состояния. */
  plan() {
    const info = this.getBackendInfo() || {};
    const components = (this.catalog || []).map((c) => {
      const installed = c.role === 'server' ? Boolean(info.server)
        : c.role === 'client' ? Boolean(info.client)
        : false;
      return { ...c, installed, needed: !installed && c.fileAvailable };
    });

    return {
      supported: process.platform === 'win32',
      platform: process.platform,
      components,
      // Ставить есть что только если чего-то не хватает И файл на месте.
      canInstall: process.platform === 'win32' && components.some((c) => c.needed),
      hints: process.platform === 'linux' ? LINUX_HINTS : [],
      state: this.state,
      steps: this.steps,
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }

  /** Запуск установки. Возвращается сразу, ход дела — в plan()/событиях. */
  async start() {
    if (this.state === 'running') throw new Error('установка уже идёт');
    if (process.platform !== 'win32') {
      throw new Error('автоматическая установка сделана только для Windows; для Linux см. подсказки в интерфейсе');
    }

    const todo = this.plan().components.filter((c) => c.needed);
    if (!todo.length) throw new Error('устанавливать нечего: всё необходимое уже есть');

    this.state = 'running';
    this.steps = [];
    this.error = null;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.emit('changed');

    // Сознательно не ждём: установка занимает до минуты, и держать
    // HTTP-запрос открытым всё это время незачем — UI следит по состоянию.
    this._run(todo).catch((e) => {
      this.state = 'error';
      this.error = e.message;
      this.finishedAt = Date.now();
      this._step('error', `установка прервана: ${e.message}`);
    });

    return { started: true, components: todo.map((c) => c.id) };
  }

  async _run(todo) {
    const manifest = await this.readManifest();
    const work = [];

    for (const item of todo) {
      const c = manifest.find((m) => m.id === item.id);
      const file = path.join(INSTALLERS_DIR, c.file);

      this._step('info', `проверка файла: ${path.basename(file)}`);

      const actual = await sha256(file);
      if (actual.toLowerCase() !== String(c.sha256).toLowerCase()) {
        throw new Error(`контрольная сумма ${path.basename(file)} не совпадает с манифестом — файл повреждён или подменён, установка отменена`);
      }
      this._step('info', `  SHA-256 совпадает`);

      const sig = await verifySignature(file);
      if (sig.status !== 'Valid') {
        throw new Error(`подпись ${path.basename(file)} недействительна (${sig.status}) — установка отменена`);
      }
      this._step('info', `  подпись действительна: ${shortSigner(sig.signer)}`);

      work.push({ component: c, file });
    }

    const elevated = await isElevated();
    this._step('info', elevated
      ? 'приложение уже запущено с правами администратора'
      : 'нужны права администратора — появится запрос Windows, подтвердите его');

    const logDir = path.join(os.tmpdir(), 'net-device-share-install');
    await fsp.mkdir(logDir, { recursive: true });
    const workerPath = path.join(logDir, 'install-worker.ps1');
    const workerLog = path.join(logDir, 'worker.log');
    await fsp.writeFile(workerPath, buildWorker(work, logDir, workerLog), 'ascii');
    await fsp.rm(workerLog, { force: true });

    this._step('info', 'запуск установки…');
    const result = elevated
      ? await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', workerPath], { timeoutMs: 600000 })
      : await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', elevateCommand(workerPath)], { timeoutMs: 600000 });

    // Лог пишет повышенный процесс; читаем его в любом случае —
    // при ошибке он и объясняет, что произошло.
    let workerOutput = '';
    try {
      workerOutput = await fsp.readFile(workerLog, 'utf8');
    } catch { /* лога может не быть, если UAC отклонили */ }

    for (const line of workerOutput.split(/\r?\n/)) {
      const t = line.trim();
      if (t) this._step(/FAILED|ERROR/i.test(t) ? 'warn' : 'info', `  ${t}`);
    }

    if (!result.ok) {
      const declined = !workerOutput && /отклон|cancel|denied|1223/i.test(result.stderr || '');
      throw new Error(declined
        ? 'запрос прав администратора отклонён — установка не выполнена'
        : `установщик завершился с ошибкой (код ${result.code}). ${(result.stderr || '').trim().slice(0, 300)}`);
    }

    this._step('info', 'проверка результата…');
    const info = await this.reprobe();

    const failed = [];
    for (const { component } of work) {
      const ok = component.role === 'server' ? info.server : info.client;
      if (ok) this._step('info', `  ${component.id}: установлен`);
      else {
        failed.push(component.id);
        this._step('warn', `  ${component.id}: после установки всё ещё не обнаружен`);
      }
    }

    this.finishedAt = Date.now();
    if (failed.length) {
      this.state = 'error';
      this.error = `не удалось подтвердить установку: ${failed.join(', ')}. Подробности в журнале и в ${logDir}`;
      this._step('error', this.error);
    } else {
      this.state = 'done';
      this._step('info', 'готово: всё необходимое установлено');
    }
    this.emit('changed');
    this.emit('finished', { ok: this.state === 'done' });
  }
}

const LINUX_HINTS = [
  'Установите пакет с утилитами: Debian/Ubuntu — sudo apt install linux-tools-generic usbip; Fedora — sudo dnf install usbip.',
  'Загрузите модули ядра: sudo modprobe usbip_host vhci_hcd (автозагрузка — /etc/modules-load.d/usbip.conf).',
  'Запускайте приложение через scripts/run-linux.sh — он сделает это сам.',
];

/** Скрипт для повышенного процесса. Только ASCII: PowerShell 5.1 без BOM читает файл как ANSI. */
function buildWorker(work, logDir, logFile) {
  const lines = [
    '$ErrorActionPreference = "Continue"',
    `$log = '${psQuote(logFile)}'`,
    'function W([string]$m) { Add-Content -Path $log -Value $m -Encoding utf8 }',
    'W "worker started"',
    '$failed = 0',
  ];

  for (const { component, file } of work) {
    const logPath = path.join(logDir, `${component.id}.log`);
    const args = component.args.map((a) => a
      .replace('{file}', file)
      .replace('{log}', logPath));
    const command = component.command.replace('{file}', file);

    lines.push(
      '',
      `W "=== ${component.id} ${component.version} ==="`,
      `$p = Start-Process -FilePath '${psQuote(command)}' -ArgumentList @(${args.map((a) => `'${psQuote(a)}'`).join(',')}) -Wait -PassThru`,
      `W ("${component.id} exit code: " + $p.ExitCode)`,
      `if ($p.ExitCode -ne 0) { W "${component.id} FAILED"; $failed = 1 }`,
    );

    for (const p of component.verifyPaths || []) {
      lines.push(`W ("  exists ${psQuote(p).replace(/\\/g, '\\')} : " + (Test-Path '${psQuote(p)}'))`);
    }
  }

  lines.push('', 'W "worker finished"', 'exit $failed');
  return lines.join('\r\n') + '\r\n';
}

/** Команда, поднимающая worker через UAC и возвращающая его код выхода. */
function elevateCommand(workerPath) {
  return `$p = Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${workerPath}"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
}

function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

async function isElevated() {
  // fltmc отрабатывает только с повышенными правами — этим и проверяем.
  const r = await run('fltmc.exe', [], { timeoutMs: 8000 });
  return r.ok;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('data', (d) => hash.update(d));
    s.on('end', resolve);
    s.on('error', reject);
  });
  return hash.digest('hex');
}

async function verifySignature(file) {
  const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + `$s = Get-AuthenticodeSignature -LiteralPath '${psQuote(file)}'; `
    + '[pscustomobject]@{ status = $s.Status.ToString(); signer = $s.SignerCertificate.Subject } | ConvertTo-Json -Compress';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30000 });
  if (!r.ok) return { status: 'Unknown', signer: null };
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return { status: 'Unknown', signer: null };
  }
}

function shortSigner(subject) {
  if (!subject) return 'неизвестен';
  const cn = String(subject).match(/(?:^|,\s*)(?:CN|O)=("[^"]+"|[^,]+)/);
  return cn ? cn[1].replace(/^"|"$/g, '') : String(subject).slice(0, 60);
}
