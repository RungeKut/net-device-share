// Запуск приложения вместе с системой.
//
// Главное ограничение задаёт не удобство, а права: публикация устройств
// требует администратора (usbipd bind), поэтому обычные способы автозапуска
// не годятся.
//
//   реестр Run и папка автозагрузки — запускают с ОБЫЧНЫМИ правами, и
//     приложение поднимется наполовину: каталог виден, публикация падает;
//   задание планировщика от имени ПОЛЬЗОВАТЕЛЯ с «наивысшими правами» —
//     повышает права только тому, у кого они есть. Если на машине входят
//     пользователи без прав администратора, приложение у них не стартует;
//   служба Windows — Node не является служебным исполняемым файлом: нужна
//     обёртка вроде nssm, то есть новая внешняя зависимость.
//
// Выбрано задание планировщика от имени SYSTEM (S-1-5-18) с запуском при
// ЗАГРУЗКЕ системы и при входе любого пользователя. По свойствам это и есть
// служба: работает до входа, не зависит от того, кто вошёл и есть ли у него
// права, окна нет (сеанс 0), повторного запроса UAC нет. Второй экземпляр не
// поднимается (IgnoreNew + код 77 приложения), поэтому вход пользователя
// ничего не дублирует.
//
// Задание от SYSTEM исполняет файл из каталога приложения с полными правами,
// поэтому оно создаётся только если этот каталог недоступен на запись
// обычным пользователям (установка в Program Files). Иначе любой локальный
// пользователь подменил бы autostart.bat и получил SYSTEM. В открытой для
// записи папке (распаковали на рабочий стол) включается прежний режим — от
// имени включившего пользователя; в настройках об этом сказано прямо.
//
// Каталог настроек у SYSTEM свой (профиль службы), а не пользовательский.
// У установленного приложения он общий — ProgramData из installed.json. Для
// переносимого комплекта рядом с лаунчером кладётся autostart.home с путём
// настроек того, кто включал автозапуск: узел сохраняет имя, ключи и nodeId.
//
// ОКНО КОНСОЛИ у режима «от пользователя». Задание, созданное обычной
// командой schtasks, получает LogonType=InteractiveToken и запускает
// приложение в сеансе пользователя — с видимым окном консоли. Убирается это
// штатным режимом планировщика LogonType=S4U («независимо от входа
// пользователя», без хранения пароля): окна нет, а учётная запись и
// %APPDATA% прежние. Способ намеренно не «спрятать окно, которое всё равно
// создаётся»: скрытые wscript и powershell -WindowStyle Hidden неотличимы от
// приёмов вредоносных программ. S4U задаётся только в XML, поэтому задание
// создаётся из XML. Если система откажет (нет права «Вход в качестве
// пакетного задания»), включается способ с окном — и об этом сообщается.
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
import { baseDir, codeDir } from './paths.js';
import { configDir } from '../config.js';

const log = logger('autostart');

// База установки, а не каталог кода: после обновления код переезжает в
// app/<версия>/, а задание автозапуска должно остаться тем же (paths.js).
const ROOT = baseDir();
const TASK_NAME = 'NetDeviceShare';
const UNIT_NAME = 'net-device-share.service';
const SYSTEM_SID = 'S-1-5-18';
// schtasks показывает SYSTEM то SID-ом, то именем — зависит от версии Windows.
const SYSTEM_IDS = new Set([SYSTEM_SID, 'SYSTEM', 'NT AUTHORITY\\SYSTEM']);
// FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER
const WRITE_MASK = 0x2 | 0x4 | 0x40 | 0x10000 | 0x40000 | 0x80000;

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
    // В комплекте и в установке файл лежит в корне базы, в исходниках — в scripts/.
    const inRoot = path.join(ROOT, 'autostart.bat');
    return fs.existsSync(inRoot) ? inRoot : path.join(ROOT, 'scripts', 'autostart.bat');
  }

  async _statusWindows() {
    // Запрашиваем сразу XML: в нём и путь, и режим входа, и всё это
    // машиночитаемо. Текстовый вывод /FO LIST переведён на язык системы,
    // и разбирать его — значит зависеть от локали.
    const x = await run('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/XML', 'ONE'], { timeoutMs: 15000 });
    const exists = x.ok;
    const xml = exists ? x.stdout : '';

    // Задание могли создать раньше и из другой папки — сверяем путь,
    // иначе галочка показывала бы «включено» для чужого задания.
    const pathMatches = exists ? xml.toLowerCase().includes(this._launcher.toLowerCase()) : null;
    const logonType = exists ? (/<LogonType>([^<]+)<\/LogonType>/i.exec(xml)?.[1] || null) : null;
    const principal = exists ? (/<Principal\b[\s\S]*?<UserId>([^<]+)<\/UserId>/i.exec(xml)?.[1] || null) : null;
    const system = exists && SYSTEM_IDS.has(String(principal).toUpperCase());
    const bootStart = exists && /<BootTrigger>/i.test(xml);
    // Без окна консоли и у SYSTEM (сеанс 0), и у S4U.
    const silent = system || logonType === 'S4U';

    return {
      supported: true,
      enabled: exists,
      method: 'Планировщик заданий Windows',
      taskName: TASK_NAME,
      launcher: this._launcher,
      launcherPresent: fs.existsSync(this._launcher),
      pathMatches,
      logonType,
      silent,
      runAs: principal,
      system,
      bootStart,
      needsAdmin: true,
      // Приложение работает без окна, поэтому сразу говорим, где смотреть
      // журнал и чем останавливать: иначе единственным известным способом
      // остаётся диспетчер задач.
      stopCommand: `schtasks /End /TN ${TASK_NAME}`,
      startCommand: `schtasks /Run /TN ${TASK_NAME}`,
      hint: system
        ? 'Работает как служба: задание от имени SYSTEM запускается при загрузке системы, '
          + 'ещё до входа пользователя, и не зависит ни от прав вошедшего, ни от UAC. '
          + `Окна консоли нет: журнал — на вкладке «Журнал», остановить — командой schtasks /End /TN ${TASK_NAME} (от администратора).`
        : exists
          ? 'Задание запускается при входе от имени включившего пользователя и работает только '
            + 'если у него есть права администратора. Чтобы приложение стартовало при загрузке и у '
            + 'обычных пользователей, включите автозапуск заново из установленной копии '
            + '(Program Files, каталог не открыт на запись пользователям): задание станет службой от SYSTEM.'
          : 'При включении создаётся задание от имени SYSTEM: приложение стартует при загрузке '
            + 'системы как служба, без входа пользователя и без UAC. Нужно один раз подтвердить '
            + 'повышение прав. Из папки, открытой на запись обычным пользователям, задание от '
            + 'SYSTEM не создаётся (это дало бы им права SYSTEM) — тогда оно запускается при входе '
            + 'от имени включившего.',
    };
  }

  /**
   * XML задания.
   *
   * ExecutionTimeLimit=PT0S обязателен: по умолчанию планировщик убивает
   * задание через трое суток, и приложение молча исчезало бы раз в три дня.
   * IgnoreNew не даёт подняться второй копии, если первая ещё работает.
   *
   * Загрузка с задержкой: сеть и драйверы в первые секунды ещё не готовы.
   * Вход пользователя — второй запуск на случай, если приложение
   * остановили: при работающем он ничего не делает.
   */
  _taskXml({ system, userId }) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const triggers = system
      ? `<BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT30S</Delay>
    </BootTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>`
      : `<LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${esc(userId)}</UserId>
    </LogonTrigger>`;
    const principal = system
      ? `<UserId>${SYSTEM_SID}</UserId>
      <RunLevel>HighestAvailable</RunLevel>`
      : `<UserId>${esc(userId)}</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>HighestAvailable</RunLevel>`;
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Net Device Share: общий доступ к устройствам по сети</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    ${triggers}
  </Triggers>
  <Principals>
    <Principal id="Author">
      ${principal}
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(this._launcher)}</Command>
      <WorkingDirectory>${esc(ROOT)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
  }

  get _userId() {
    const domain = process.env.USERDOMAIN;
    const user = process.env.USERNAME || os.userInfo().username;
    return domain ? `${domain}\\${user}` : user;
  }

  /** Файл рядом с лаунчером: каталог настроек для запуска от SYSTEM (читает autostart.bat). */
  get _homeFile() {
    return path.join(ROOT, 'autostart.home');
  }

  /**
   * Пути, в которые обычный пользователь может писать (и подменить то, что
   * исполнит SYSTEM). Пусто — безопасно. Если проверить не удалось, считаем
   * небезопасным: лучше прежний режим, чем лишние права.
   */
  async _writableByUsers() {
    const dirs = [...new Set([ROOT, codeDir, path.join(ROOT, 'launcher')])];
    const script = `$ErrorActionPreference='Stop'; foreach ($p in @(${dirs.map((d) => `'${psQuote(d)}'`).join(',')})) { `
      + 'if (-not (Test-Path -LiteralPath $p)) { continue }; '
      + 'foreach ($r in (Get-Acl -LiteralPath $p).Access) { '
      + "if ($r.AccessControlType -ne 'Allow') { continue }; "
      + "$sid = try { $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { '' }; "
      + "if (@('S-1-1-0','S-1-5-11','S-1-5-32-545') -notcontains $sid) { continue }; "
      + `if (([int]$r.FileSystemRights -band ${WRITE_MASK}) -ne 0) { $p; break } } }`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30000 });
    if (!r.ok) return [`(проверка прав на каталог не удалась: код ${r.code})`];
    return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }

  /** Каталог настроек, который должен видеть запуск от SYSTEM, или null, если он и так общий. */
  _homeForService() {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'installed.json'), 'utf8'));
      if (info?.home) return null;
    } catch { /* не из установщика */ }
    return process.env.NDS_HOME || configDir();
  }

  async _enableWindows() {
    if (!fs.existsSync(this._launcher)) {
      throw new Error(`не найден ${this._launcher} — без него задание запускать нечего`);
    }

    const open = await this._writableByUsers();
    const system = open.length === 0;
    if (!system) {
      log.warn(`каталог открыт на запись обычным пользователям (${open.join('; ')}) — задание от SYSTEM `
        + 'не создаём, запуск будет от имени включившего пользователя');
    }

    const home = system ? this._homeForService() : null;
    if (home) {
      try {
        await fsp.writeFile(this._homeFile, `${home}\r\n`, 'utf8');
      } catch (e) {
        log.warn(`не записан ${this._homeFile} (${e.code || e.message}): служба возьмёт собственный каталог настроек`);
      }
    } else {
      await fsp.rm(this._homeFile, { force: true }).catch(() => {});
    }

    const xmlFile = path.join(os.tmpdir(), `nds-task-${process.pid}.xml`);
    let created = false;
    try {
      // schtasks /XML читает файл как Unicode. UTF-8 он принимает не везде,
      // а UTF-16LE с меткой порядка байтов — всегда.
      await fsp.writeFile(xmlFile, `﻿${this._taskXml({ system, userId: this._userId })}`, 'utf16le');

      const r = await elevated('schtasks.exe', ['/Create', '/F', '/TN', TASK_NAME, '/XML', xmlFile]);
      if (r.declined) throw new Error('запрос прав администратора отклонён — автозапуск не включён');
      created = r.ok;
      if (!r.ok) {
        log.warn(`задание из XML создать не удалось (код ${r.code}) — пробуем упрощённый режим`);
      }
    } finally {
      await fsp.rm(xmlFile, { force: true }).catch(() => {});
    }

    if (!created) {
      // Запасной путь без XML: для SYSTEM — запуск при старте системы, для
      // пользователя — прежний способ с окном консоли. Хуже, чем XML, но
      // лучше, чем не работающий автозапуск.
      const args = system
        ? ['/Create', '/F', '/TN', TASK_NAME, '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST',
          '/TR', `"${this._launcher}"`]
        : ['/Create', '/F', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/TR', `"${this._launcher}"`];
      const r = await elevated('schtasks.exe', args);
      if (r.declined) throw new Error('запрос прав администратора отклонён — автозапуск не включён');
      if (!r.ok) throw new Error(`не удалось создать задание (код ${r.code})`);
    }

    const st = await this._statusWindows();
    if (!st.enabled) throw new Error('задание создано, но система его не показывает');
    log.info(`автозапуск включён: задание «${TASK_NAME}» → ${this._launcher} `
      + (st.system ? '(служба: SYSTEM, при загрузке системы)' : `(от имени ${st.runAs || this._userId}, при входе)`));
    if (!st.silent) {
      log.warn('окно консоли будет появляться при входе в систему: учётной записи не хватает '
        + 'права «Вход в качестве пакетного задания» для режима без окна');
    }
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
    await fsp.rm(this._homeFile, { force: true }).catch(() => {});
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

  /** Что запускает юнит: лаунчер, если он есть (откат и переключение версий), иначе код напрямую. */
  get _entry() {
    const sup = path.join(ROOT, 'launcher', 'supervisor.mjs');
    return fs.existsSync(sup) ? sup : path.join(ROOT, 'src', 'main.js');
  }

  async _enableLinux() {
    const unit = `[Unit]
Description=Net Device Share
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${process.execPath} ${this._entry} --no-open
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
