// Запуск приложения при входе в систему.
//
// Главное ограничение задаёт не удобство, а права: публикация устройств
// требует администратора (usbipd bind), поэтому обычные способы автозапуска
// не годятся.
//
//   реестр Run и папка автозагрузки — запускают с ОБЫЧНЫМИ правами, и
//     приложение поднимется наполовину: каталог виден, публикация падает;
//   планировщик заданий с «наивысшими правами» — запускает с правами
//     администратора и БЕЗ запроса UAC при каждом входе;
//   служба Windows — работала бы и до входа в систему, но Node не является
//     служебным исполняемым файлом: нужна обёртка вроде nssm, то есть новая
//     внешняя зависимость.
//
// Выбран планировщик. Его ограничение честное и понятное: задание срабатывает
// при ВХОДЕ пользователя, а не при включении компьютера. Для стенда, за
// которым работают, это ровно то, что нужно; «работать без входа в систему»
// — отдельная задача, решаемая службой.
//
// На Linux используется пользовательский юнит systemd: root не нужен, потому
// что там права решаются иначе (модули ядра и группы доступа).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../log.js';
import { run } from '../devices/backend.js';

const log = logger('autostart');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASK_NAME = 'NetDeviceShare';
const UNIT_NAME = 'net-device-share.service';

export class Autostart {
  constructor(config) {
    this.config = config;
  }

  /** Текущее состояние. Источник истины — сама система, а не конфигурация. */
  async status() {
    if (process.platform === 'win32') return this._statusWindows();
    if (process.platform === 'linux') return this._statusLinux();
    return {
      supported: false,
      enabled: false,
      method: null,
      hint: 'автозапуск настроен только для Windows и Linux',
    };
  }

  async enable() {
    if (process.platform === 'win32') return this._enableWindows();
    if (process.platform === 'linux') return this._enableLinux();
    throw new Error('автозапуск на этой системе не поддерживается');
  }

  async disable() {
    if (process.platform === 'win32') return this._disableWindows();
    if (process.platform === 'linux') return this._disableLinux();
    throw new Error('автозапуск на этой системе не поддерживается');
  }

  // ------------------------------------------------------------- Windows

  get _launcher() {
    return path.join(ROOT, 'scripts', 'autostart.bat');
  }

  async _statusWindows() {
    const r = await run('schtasks.exe', ['/Query', '/TN', TASK_NAME], { timeoutMs: 15000 });
    const exists = r.ok;

    let runsAsExpected = null;
    if (exists) {
      // Задание могли создать раньше и из другой папки — сверяем путь,
      // иначе галочка показывала бы «включено» для чужого задания.
      const v = await run('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V'], { timeoutMs: 15000 });
      runsAsExpected = v.ok ? v.stdout.toLowerCase().includes(this._launcher.toLowerCase()) : null;
    }

    return {
      supported: true,
      enabled: exists,
      method: 'Планировщик заданий Windows',
      taskName: TASK_NAME,
      launcher: this._launcher,
      launcherPresent: fs.existsSync(this._launcher),
      pathMatches: runsAsExpected,
      needsAdmin: true,
      hint: 'Задание срабатывает при входе пользователя в систему и выполняется '
        + 'с правами администратора без запроса UAC. Чтобы приложение работало '
        + 'и без входа в систему, нужна служба Windows.',
    };
  }

  async _enableWindows() {
    if (!fs.existsSync(this._launcher)) {
      throw new Error(`не найден ${this._launcher} — без него задание запускать нечего`);
    }

    // Аргумент /TR — один путь в кавычках: поэтому задание и вызывает
    // отдельный файл без параметров. Собирать здесь длинную командную
    // строку значило бы воевать с тройным экранированием.
    const tr = `"${this._launcher}"`;
    const args = ['/Create', '/F', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/TR', tr];

    const r = await elevated('schtasks.exe', args);
    if (r.declined) throw new Error('запрос прав администратора отклонён — автозапуск не включён');
    if (!r.ok) throw new Error(`не удалось создать задание (код ${r.code})`);

    const st = await this._statusWindows();
    if (!st.enabled) throw new Error('задание создано, но система его не показывает');
    log.info(`автозапуск включён: задание «${TASK_NAME}» → ${this._launcher}`);
    return st;
  }

  async _disableWindows() {
    const r = await elevated('schtasks.exe', ['/Delete', '/F', '/TN', TASK_NAME]);
    if (r.declined) throw new Error('запрос прав администратора отклонён — автозапуск не выключен');
    // Отсутствующее задание — не ошибка: результат тот же, которого добивались.
    if (!r.ok) {
      const st = await this._statusWindows();
      if (st.enabled) throw new Error(`не удалось удалить задание (код ${r.code})`);
    }
    log.info('автозапуск выключен');
    return this._statusWindows();
  }

  // --------------------------------------------------------------- Linux

  get _unitPath() {
    return path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_NAME);
  }

  async _statusLinux() {
    const r = await run('systemctl', ['--user', 'is-enabled', UNIT_NAME], { timeoutMs: 10000 });
    return {
      supported: true,
      enabled: r.ok && r.stdout.trim() === 'enabled',
      method: 'Пользовательский юнит systemd',
      taskName: UNIT_NAME,
      launcher: this._unitPath,
      launcherPresent: fs.existsSync(this._unitPath),
      pathMatches: null,
      needsAdmin: false,
      hint: 'Юнит запускается при входе пользователя. Чтобы приложение работало '
        + 'до входа, юнит нужно поставить системным и запускать от root.',
    };
  }

  async _enableLinux() {
    const unit = `[Unit]
Description=Net Device Share
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${process.execPath} ${path.join(ROOT, 'src', 'main.js')} --no-open
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
    await fsp.mkdir(path.dirname(this._unitPath), { recursive: true });
    await fsp.writeFile(this._unitPath, unit, 'utf8');

    await run('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 15000 });
    const r = await run('systemctl', ['--user', 'enable', UNIT_NAME], { timeoutMs: 15000 });
    if (!r.ok) throw new Error(`systemctl enable не удался: ${(r.stderr || '').trim()}`);
    log.info(`автозапуск включён: ${this._unitPath}`);
    return this._statusLinux();
  }

  async _disableLinux() {
    await run('systemctl', ['--user', 'disable', UNIT_NAME], { timeoutMs: 15000 });
    await fsp.rm(this._unitPath, { force: true });
    await run('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 15000 });
    log.info('автозапуск выключен');
    return this._statusLinux();
  }
}

/** ERROR_CANCELLED — Windows так сообщает «пользователь отказался». */
const DECLINED_CODE = 1223;

/**
 * Запуск известной программы с повышением прав.
 *
 * Здесь та же осторожность, что и в установщике компонентов: никаких
 * временных сценариев и никакого обхода политики исполнения. PowerShell
 * нужен лишь как обёртка над ShellExecute с глаголом RunAs — вызвать его
 * из Node напрямую нельзя, — а команда короткая и постоянной формы.
 */
async function elevated(command, args) {
  const fltmc = await run('fltmc.exe', [], { timeoutMs: 8000 });
  if (fltmc.ok) {
    const r = await run(command, args, { timeoutMs: 60000 });
    return { ok: r.ok, code: r.code, declined: false };
  }

  const list = args.map((a) => `'${psQuote(a)}'`).join(',');
  const script = "$ErrorActionPreference='Stop'; "
    + `try { $p = Start-Process -FilePath '${psQuote(command)}' -ArgumentList @(${list}) `
    + '-Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } '
    + `catch { exit ${DECLINED_CODE} }`;

  const r = await run('powershell.exe', ['-NoProfile', '-Command', script], { timeoutMs: 120000 });
  return { ok: r.ok, code: r.code, declined: r.code === DECLINED_CODE };
}

function psQuote(s) {
  return String(s).replace(/'/g, "''");
}
