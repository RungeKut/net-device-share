// TAP-адаптеры Windows: какие есть, создание и удаление, MAC, имя. Удаление,
// MAC и имя годятся и для любого другого сетевого адаптера.
//
// Драйвер — tap-windows6 9.27.0 из installers/windows (подпись attestation
// от Microsoft, поэтому ставится и при включённой Memory Integrity).
// Адаптер создаётся вызовами SetupAPI (scripts/tap-device.ps1): первый
// заодно кладёт драйвер в хранилище, каждый следующий добавляет экземпляр,
// не трогая уже работающие. Права администратора нужны на создание,
// удаление и смену MAC; открывать адаптер и гонять кадры можно и без них.
//
// ЧУЖИЕ АДАПТЕРЫ САМО НЕ ТРОГАЕТ. Тот же драйвер ставит OpenVPN, и его
// адаптер неотличим от нашего ни по драйверу, ни по имени. Поэтому по
// собственному почину приложение пользуется только теми адаптерами, которые
// создало само: их GUID записываются в настройки (поле tapAdapters). Чужой
// адаптер оно подключает к коммутатору, меняет или удаляет только по прямой
// команде человека (core/netManager.js).

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, psJson, psQuote } from '../devices/backend.js';
import { logger } from '../log.js';

const log = logger('tap');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TAP_DIR = path.join(ROOT, 'installers', 'windows', 'tap-windows6-9.27.0');
const DEVCON = path.join(TAP_DIR, 'devcon.exe');
const INF = path.join(TAP_DIR, 'OemVista.inf');
const HWID = 'tap0901';
const DEVICE_SCRIPT = path.join(ROOT, 'scripts', 'tap-device.ps1');

/** Файлы драйвера на месте — адаптер можно создать. */
export function driverFilesPresent() {
  return fs.existsSync(DEVCON) && fs.existsSync(INF);
}

function cleanGuid(g) {
  return String(g || '').replace(/[{}]/g, '').toUpperCase();
}

/** Все сетевые адаптеры системы, коротко: имя, GUID, состояние, MAC, устройство. */
export async function listNetAdapters() {
  const items = await psJson(
    'Get-NetAdapter -ErrorAction SilentlyContinue | '
    + 'Select-Object -Property Name,InterfaceGuid,Status,MacAddress,PnPDeviceID,ComponentID | ConvertTo-Json -Compress -Depth 3',
  );
  return items.map((a) => ({
    name: a.Name,
    guid: cleanGuid(a.InterfaceGuid),
    status: a.Status || null,
    mac: a.MacAddress || null,
    pnpId: a.PnPDeviceID || null,
    tap: String(a.ComponentID || '').toLowerCase() === HWID,
  }));
}

/** Все TAP-адаптеры системы — и наши, и чужие. */
export async function listTaps() {
  return (await listNetAdapters()).filter((a) => a.tap);
}

/**
 * Создать новый TAP-адаптер.
 *
 * ПО ОДНОМУ, НЕ ТРОГАЯ ОСТАЛЬНЫЕ. Основной путь — scripts/tap-device.ps1
 * (SetupAPI): драйвер ставится только на новое устройство. «devcon install»
 * переустанавливает драйвер на всех TAP-адаптерах сразу, и у каждого
 * открытого рвётся чтение — у работающего проброса, у виртуальных адаптеров
 * коммутаторов, у OpenVPN. Он остался запасным путём на случай, если
 * SetupAPI откажет: адаптер важнее, чем секундный обрыв у соседей.
 *
 * Какой именно адаптер появился, devcon не сообщает, поэтому для него
 * сравниваем список до и после. Появляется адаптер не мгновенно — ждём.
 *
 * УСПЕХ — ЭТО ПОЯВИВШИЙСЯ АДАПТЕР, А НЕ КОД ВОЗВРАТА. При первой установке
 * драйвера devcon печатает «Drivers installed successfully.» и выходит с
 * кодом 1 — «готово, но просит перезагрузку». Считать это отказом значило
 * отменить занятие, уже создав адаптер. Перезагрузка адаптеру на деле не
 * нужна — он работает сразу.
 */
export async function createTap() {
  if (!driverFilesPresent()) {
    throw new Error(`нет файлов драйвера TAP в ${path.relative(ROOT, TAP_DIR)}`);
  }
  const before = new Set((await listTaps()).map((t) => t.guid));

  log.info('создаётся TAP-адаптер…');
  let said;
  let code;
  try {
    const res = await deviceScript(['-Action', 'create', '-Inf', INF]);
    const guid = cleanGuid(res.guid);
    const fresh = await waitTaps((list) => list.find((t) => t.guid === guid));
    if (fresh) {
      log.info(`TAP-адаптер создан: «${fresh.name}» ${fresh.guid}${res.reboot ? ' (Windows просит перезагрузку, адаптеру она не нужна)' : ''}`);
      return fresh;
    }
    said = `адаптер ${guid} создан, но в системе так и не появился`;
    code = 0;
  } catch (e) {
    log.warn(`создать адаптер по одному не вышло (${e.message}) — пробую devcon; открытые TAP-адаптеры при этом перезапустятся`);
    const r = await run(DEVCON, ['install', INF, HWID], { timeoutMs: 120000, cwd: TAP_DIR });
    said = (r.stdout + r.stderr).trim().split(/\r?\n/).filter(Boolean).pop() || `код ${r.code}`;
    code = r.code;
    const fresh = await waitTaps((list) => list.find((t) => !before.has(t.guid)));
    if (fresh) {
      if (r.code !== 0) log.info(`devcon ответил кодом ${r.code} («${said}»), но адаптер создан`);
      log.info(`TAP-адаптер создан: «${fresh.name}» ${fresh.guid}`);
      return fresh;
    }
  }
  throw new Error(`TAP-адаптер не создан: ${said} (код ${code})`);
}

/** Ждать, пока список адаптеров станет таким, как нужно (до ms). */
async function waitTaps(pick, ms = 30000, list = listTaps) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const found = pick(await list());
    if (found) return found;
    await new Promise((res) => setTimeout(res, 700));
  }
  return null;
}

async function deviceScript(args) {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', DEVICE_SCRIPT, ...args], { timeoutMs: 120000 });
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('NDS-RESULT '));
  if (!line) {
    throw new Error((r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).pop() || `код ${r.code}`);
  }
  const res = JSON.parse(line.slice('NDS-RESULT '.length));
  if (!res.ok) throw new Error(res.message || 'отказ без объяснения');
  return res;
}

/**
 * Удалить сетевой адаптер — устройство целиком (DIF_REMOVE), как «Удалить
 * устройство» в Диспетчере устройств. Годится для программных адаптеров:
 * физическую карту Windows нашла бы снова при следующем опросе шины. Можно
 * ли удалять этот адаптер, решает вызывающий. Уже удалённый — не ошибка.
 */
export async function removeAdapter(guid) {
  const t = (await listNetAdapters()).find((x) => x.guid === cleanGuid(guid));
  if (!t) return false;
  if (!t.pnpId) throw new Error(`у адаптера «${t.name}» не прочитан идентификатор устройства`);
  await deviceScript(['-Action', 'remove', '-InstanceId', t.pnpId]);
  const gone = await waitTaps((list) => (list.some((x) => x.guid === t.guid) ? null : true), 15000, listNetAdapters);
  if (!gone) throw new Error(`адаптер «${t.name}» удалён, но всё ещё виден в системе`);
  log.info(`${t.tap ? 'TAP-адаптер' : 'адаптер'} «${t.name}» удалён`);
  return true;
}

/** Удалить TAP-адаптер, созданный приложением. */
export const removeTap = removeAdapter;

// ------------------------------------------------------------------ MAC

/** MAC любого вида → 12 шестнадцатеричных цифр в верхнем регистре, либо null. */
export function normalizeMac(text) {
  const hex = String(text || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 12 ? hex : null;
}

/** 02-AA-BB-CC-DD-EE — как показывает Windows. */
export function formatMac(mac) {
  const n = normalizeMac(mac);
  return n ? n.match(/../g).join('-') : String(mac || '');
}

/**
 * Почему этот MAC не годится адаптеру (null — годится).
 *
 * Драйвер TAP принимает только ЛОКАЛЬНО АДМИНИСТРИРУЕМЫЙ одноадресный MAC:
 * второй бит первого байта — 1, младший — 0 (02-…, 06-…, 0A-…). Заводской
 * адрес вида 00-15-… он молча отвергает и остаётся со своим — проверено на
 * стенде. Поэтому MAC настоящей карты адаптеру не присвоить. Драйверы
 * настоящих карт обычно берут любой одноадресный; не взял — это видно по
 * MAC после перезапуска.
 *
 * @param {string} mac
 * @param {{ tap?: boolean }} [o] — tap: false — правило драйвера TAP не действует
 */
export function macProblem(mac, { tap = true } = {}) {
  const n = normalizeMac(mac);
  if (!n) return 'MAC — это 12 шестнадцатеричных цифр, например 02-AA-BB-CC-DD-01';
  if (/^0+$/.test(n)) return 'MAC из одних нулей адаптеру не годится';
  const first = parseInt(n.slice(0, 2), 16);
  if (first & 1) return 'MAC с нечётным первым байтом — групповой, адаптеру такой не годится';
  if (tap && !(first & 2)) return 'драйвер TAP принимает только локальный MAC: первый байт 02, 06, 0A, 0E… (например 02-…)';
  return null;
}

/** Случайный локальный MAC: 02-xx-xx-xx-xx-xx. */
export function randomMac() {
  return `02${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

/**
 * Задать адаптеру MAC (null — вернуть заводской). Адаптер при этом
 * перезапускается, и открытый посредник падает: вызывающий останавливает
 * его заранее и поднимает после.
 *
 * Так же, как вкладка «Дополнительно» в свойствах адаптера: значение
 * NetworkAddress в ключе драйвера. Его читает и TAP, и драйверы большинства
 * карт; поддерживает ли драйвер адрес, видно в описи (macSettable).
 *
 * @param {string} guid
 * @param {string|null} mac
 * @param {{ tap?: boolean }} [o] — tap: false — адаптер не TAP (см. macProblem)
 * @returns {Promise<string>} MAC после перезапуска
 */
export async function setAdapterMac(guid, mac, { tap = true } = {}) {
  const g = cleanGuid(guid);
  if (mac && macProblem(mac, { tap })) throw new Error(macProblem(mac, { tap }));
  const n = mac ? normalizeMac(mac) : null;
  const sel = `$a = Get-NetAdapter -ErrorAction Stop | Where-Object { $_.InterfaceGuid -eq ${psQuote(`{${g}}`)} }; `
    + "if (-not $a) { throw 'адаптер не найден' }; ";
  // Ключ драйвера: там лежит NetworkAddress. Сброс — удалением значения:
  // пустую строку драйвер тоже попытался бы прочесть как адрес.
  const key = "$drv = (Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\' + $a.PnPDeviceID) -Name Driver).Driver; "
    + "$key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\' + $drv; ";
  const change = n
    ? `Set-ItemProperty -LiteralPath $key -Name NetworkAddress -Value ${psQuote(n)} -ErrorAction Stop; `
    : 'Remove-ItemProperty -LiteralPath $key -Name NetworkAddress -ErrorAction SilentlyContinue; ';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `${sel}${key}${change}$a | Restart-NetAdapter -Confirm:$false -ErrorAction Stop`], { timeoutMs: 60000 });
  if (!r.ok) throw new Error(`MAC не изменён: ${r.stderr.trim().split(/\r?\n/)[0] || `код ${r.code}`}`);
  // Адаптер поднимается не мгновенно, и новый MAC виден после подъёма.
  let now = null;
  for (let i = 0; i < 20; i++) {
    now = (await listNetAdapters()).find((t) => t.guid === g)?.mac || null;
    if (now && (!n || normalizeMac(now) === n)) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  if (n && normalizeMac(now) !== n) throw new Error(`драйвер не принял MAC ${formatMac(n)}: у адаптера по-прежнему ${now}`);
  log.info(`у адаптера ${g} MAC ${n ? formatMac(n) : 'заводской'}: ${now}`);
  return now;
}

/** MAC TAP-адаптера: только локальный. */
export function setTapMac(guid, mac) {
  return setAdapterMac(guid, mac, { tap: true });
}

/**
 * Дать адаптеру понятное имя — его человек видит в «Сетевых подключениях».
 * Не удалось — не беда: работать адаптер будет и под прежним. Когда имя
 * просил человек, нужна причина отказа — { explain: true } бросает её.
 */
export async function renameAdapter(guid, newName, { explain = false } = {}) {
  // Адаптер передаётся по конвейеру, а не именем: -Name понимает шаблоны, и
  // имя со скобками [ ] нашло бы не тот адаптер или никакой.
  const script = '$a = Get-NetAdapter -ErrorAction Stop | Where-Object { $_.InterfaceGuid -eq '
    + psQuote(`{${cleanGuid(guid)}}`) + ' }; '
    + 'if ($a -and $a.Name -ne ' + psQuote(newName) + ') { $a | Rename-NetAdapter -NewName '
    + psQuote(newName) + ' -ErrorAction Stop }';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 20000 });
  if (!r.ok) {
    const why = r.stderr.trim().split(/\r?\n/)[0] || `код ${r.code}`;
    log.debug(`адаптер ${guid} не переименован: ${why}`);
    if (explain) throw new Error(`Windows не переименовала адаптер: ${why}`);
    return false;
  }
  return true;
}

/**
 * Включить или отключить адаптер — как «Отключить» в «Сетевых подключениях».
 * Отключённый адаптер пропадает из сети, но остаётся в системе со всеми
 * настройками.
 */
export async function setAdapterEnabled(guid, enabled) {
  const verb = enabled ? 'Enable-NetAdapter' : 'Disable-NetAdapter';
  const script = '$a = Get-NetAdapter -ErrorAction Stop | Where-Object { $_.InterfaceGuid -eq '
    + psQuote(`{${cleanGuid(guid)}}`) + ' }; '
    + `if (-not $a) { throw 'адаптер не найден' }; $a | ${verb} -Confirm:$false -ErrorAction Stop`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 60000 });
  if (!r.ok) throw new Error(`адаптер не ${enabled ? 'включён' : 'отключён'}: ${r.stderr.trim().split(/\r?\n/)[0] || `код ${r.code}`}`);
  // Состояние меняется не мгновенно.
  const g = cleanGuid(guid);
  const ok = await waitTaps((list) => {
    const a = list.find((x) => x.guid === g);
    return a && (a.status === 'Disabled') !== Boolean(enabled) ? a : null;
  }, 15000, listNetAdapters);
  if (!ok) throw new Error(`адаптер так и не ${enabled ? 'включился' : 'отключился'}`);
  log.info(`адаптер «${ok.name}» ${enabled ? 'включён' : 'отключён'}`);
  return true;
}

/** Имя адаптера сейчас: человек мог его переименовать. */
export async function adapterName(guid) {
  const t = (await listTaps()).find((x) => x.guid === cleanGuid(guid));
  return t ? t.name : null;
}

/** Имя для «Сетевых подключений»: коротко и без символов, которых там не любят. */
export function friendlyName(text) {
  return String(text).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}
