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
// Компоненты ставятся по очереди, каждый своим установщиком. Так в окне UAC
// виден издатель настоящего установщика, а не посредник вроде PowerShell,
// и в системе не появляется временный сценарий, запускаемый в обход политики.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { logger } from '../log.js';
import { run } from '../devices/backend.js';

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
      : `нужны права администратора — Windows запросит подтверждение на каждый компонент (${todo.length} шт.)`);

    const logDir = path.join(os.tmpdir(), 'net-device-share-install');
    await fsp.mkdir(logDir, { recursive: true });

    // Компоненты ставятся по очереди, каждый своим установщиком. Без
    // повышенных прав на каждый будет отдельный запрос UAC — зато в нём
    // виден издатель настоящего установщика, а не посредник.
    for (const { component, file } of work) {
      const logPath = path.join(logDir, `${component.id}.log`);
      const command = component.command.replace('{file}', file);
      const args = component.args.map((a) => a.replace('{file}', file).replace('{log}', logPath));

      this._step('info', `установка ${component.id} ${component.version}…`);
      const r = await runInstaller(command, args, elevated);

      if (r.declined) {
        throw new Error('запрос прав администратора отклонён — установка не выполнена');
      }
      if (!r.ok) {
        throw new Error(`установщик ${component.id} завершился с ошибкой (код ${r.code}). Подробный журнал: ${logPath}`);
      }
      this._step('info', `  установщик отработал успешно`);

      const found = (component.verifyPaths || []).find((p) => fs.existsSync(p));
      if (found) this._step('info', `  файл на месте: ${found}`);
      else this._step('warn', '  ожидаемый файл по известным путям не найден');
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

// ERROR_CANCELLED — код, которым Windows сообщает «пользователь отказался».
const DECLINED_CODE = 1223;

/**
 * Запуск одного установщика, при необходимости — с повышением прав.
 *
 * Здесь намеренно НЕТ ни временного файла сценария, ни `-ExecutionPolicy
 * Bypass`. Прежняя реализация сбрасывала .ps1 в %TEMP% и запускала его с
 * обходом политики исполнения от имени администратора — то есть повторяла
 * связку «сбросил скрипт → обошёл политику → поднял права», по которой
 * антивирусы опознают загрузчики вредоносного кода. Претензия справедливая:
 * со стороны это неотличимо.
 *
 * Теперь PowerShell нужен только как обёртка над ShellExecute с глаголом
 * RunAs — из Node вызвать его напрямую нельзя. Команда короткая, постоянной
 * формы, а `-Command` под политику исполнения не подпадает: она действует
 * на файлы сценариев.
 *
 * Побочная выгода важнее технической: в окне UAC пользователь видит издателя
 * настоящего установщика, а не «Windows PowerShell». Плата — отдельный запрос
 * на каждый компонент вместо одного общего.
 */
async function runInstaller(command, args, elevated) {
  if (elevated) {
    const r = await run(command, args, { timeoutMs: 600000 });
    return { ok: r.ok, code: r.code, declined: false };
  }

  const list = args.map((a) => `'${psQuote(a)}'`).join(',');
  const script = "$ErrorActionPreference='Stop'; "
    + `try { $p = Start-Process -FilePath '${psQuote(command)}'`
    + (args.length ? ` -ArgumentList @(${list})` : '')
    + ' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } '
    + `catch { exit ${DECLINED_CODE} }`;

  const r = await run('powershell.exe', ['-NoProfile', '-Command', script], { timeoutMs: 600000 });
  return { ok: r.ok, code: r.code, declined: r.code === DECLINED_CODE };
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
