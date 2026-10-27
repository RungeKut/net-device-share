// Перечисление портов и сетевых интерфейсов.
//
// Эти типы пока только бронируются — проброса данных по сети для них нет
// (см. RESERVATION_NOTE в types.js). Но перечислять их нужно по-настоящему:
// в каталоге они участвуют наравне с USB, входят в группы, занимаются и
// освобождаются по тем же правилам.
//
// Сетевые интерфейсы берутся именно как интерфейсы, а не как физические
// карты: на машине бывают программный мост, виртуальные адаптеры Hyper-V,
// WSL и туннели — с точки зрения стенда это разные ресурсы.

import os from 'node:os';
import fsp from 'node:fs/promises';
import { psJson, run } from './backend.js';
import { registryExpr, fromRegistry } from '../net/ipConfig.js';
import { logger } from '../log.js';
import { makeDeviceId } from './types.js';

const log = logger('devices:ports');

// ------------------------------------------------------------- COM и LPT

/**
 * Последовательные и параллельные порты.
 *
 * На Windows оба типа живут в одном классе устройств Ports, поэтому
 * запрашиваются одним вызовом и разделяются по имени порта в названии.
 */
export async function listPorts() {
  if (process.platform === 'win32') return listPortsWindows();
  if (process.platform === 'linux') return listPortsLinux();
  return [];
}

const PNP_PORTS_CMD = 'Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue | '
  + 'Select-Object -Property FriendlyName,InstanceId,Status';

async function listPortsWindows() {
  return portsFromPnp(await psJson(`${PNP_PORTS_CMD} | ConvertTo-Json -Compress -Depth 3`));
}

/** Разбор ответа Get-PnpDevice: общий для одиночного и совмещённого опроса. */
export function portsFromPnp(items) {
  const out = [];
  for (const d of items) {
    const name = d.FriendlyName || '';
    // Имя порта Windows показывает в скобках: "USB-SERIAL CH340 (COM19)".
    const m = name.match(/\((COM\d+|LPT\d+)\)/i);
    if (!m) continue;

    const port = m[1].toUpperCase();
    const type = port.startsWith('COM') ? 'com' : 'lpt';
    const label = name.replace(/\s*\((COM\d+|LPT\d+)\)\s*/i, '').trim();

    out.push({
      type,
      key: port,
      deviceId: makeDeviceId(type, port),
      title: port,
      description: label || (type === 'com' ? 'Последовательный порт' : 'Параллельный порт'),
      details: {
        instanceId: d.InstanceId || null,
        status: d.Status || null,
        // Порт на USB-переходнике исчезнет вместе с переходником — про это
        // полезно знать тому, кто его бронирует.
        viaUsb: /^USB\\/i.test(d.InstanceId || ''),
      },
      present: true,
    });
  }
  return out.sort(byPortNumber);
}

async function listPortsLinux() {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir('/dev');
  } catch (e) {
    log.debug('/dev недоступен:', e.message);
    return out;
  }

  for (const name of entries) {
    const serial = /^tty(S|USB|ACM)\d+$/.test(name);
    const parallel = /^lp\d+$/.test(name);
    if (!serial && !parallel) continue;

    const type = serial ? 'com' : 'lpt';
    out.push({
      type,
      key: name,
      deviceId: makeDeviceId(type, name),
      title: `/dev/${name}`,
      description: serial ? 'Последовательный порт' : 'Параллельный порт',
      details: { path: `/dev/${name}`, viaUsb: /^ttyUSB|^ttyACM/.test(name) },
      present: true,
    });
  }
  return out.sort(byPortNumber);
}

function byPortNumber(a, b) {
  return String(a.key).localeCompare(String(b.key), undefined, { numeric: true });
}

// ------------------------------------------------------- сетевые интерфейсы

export async function listNetInterfaces() {
  if (process.platform === 'win32') return listNetWindows();
  return listNetGeneric();
}

// Настройки IP — из реестра тем же вызовом: у отданной карты стек IP
// отвязан, а показать, с какими настройками она работает, всё равно надо.
const NET_ADAPTERS_CMD = 'Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ '
  + 'Name = $_.Name; InterfaceDescription = $_.InterfaceDescription; InterfaceGuid = $_.InterfaceGuid; '
  + 'Status = [string]$_.Status; MacAddress = $_.MacAddress; LinkSpeed = $_.LinkSpeed; Virtual = $_.Virtual; '
  + 'ComponentID = $_.ComponentID; HardwareInterface = $_.HardwareInterface; '
  + 'NdisPhysicalMedium = $_.NdisPhysicalMedium; '
  + `Reg = ${registryExpr('$_.InterfaceGuid')} } }`;

async function listNetWindows() {
  return netsFromAdapters(await psJson(`${NET_ADAPTERS_CMD} | ConvertTo-Json -Compress -Depth 4`));
}

/** Разбор ответа Get-NetAdapter: общий для одиночного и совмещённого опроса. */
export function netsFromAdapters(adapters) {
  if (!adapters.length) return listNetGeneric();

  const addrs = addressesByIface();
  return adapters
    // TAP-адаптеры и сам мост — это наша же проводка для проброса. В
    // каталоге им не место: занять TAP значило бы пробросить проброс.
    .filter((a) => !isPlumbing(a))
    .map((a) => {
      const name = a.Name || a.InterfaceDescription || 'интерфейс';
      return {
        type: 'net',
        key: normalizeKey(name),
        deviceId: makeDeviceId('net', normalizeKey(name)),
        title: name,
        description: a.InterfaceDescription || 'Сетевой интерфейс',
        details: {
          guid: a.InterfaceGuid || null,
          status: a.Status || null,
          mac: a.MacAddress || null,
          linkSpeed: a.LinkSpeed || null,
          virtual: a.Virtual === true || a.Virtual === 'True',
          // Настоящая карта, а не программный адаптер: пробросить можно
          // только её — мостом с физическим проводом.
          hardware: a.HardwareInterface === true || a.HardwareInterface === 'True',
          wireless: WIRELESS_MEDIA.has(Number(a.NdisPhysicalMedium)),
          addresses: addrs.get(name) || [],
          ip: fromRegistry(a.Reg),
        },
        present: true,
      };
    }).sort((x, y) => x.title.localeCompare(y.title));
}

/**
 * NdisPhysicalMedium беспроводных сред: WirelessLan, WirelessWan, Native802_11.
 * Wi-Fi не пропускает кадры с чужим MAC-адресом отправителя, и мост Windows
 * на нём подменяет адреса — сеть за ним работает лишь частично.
 */
const WIRELESS_MEDIA = new Set([1, 8, 9]);

/** TAP-адаптер или мост Windows — служебная проводка проброса. */
export function isPlumbing(a) {
  return /^tap0901$/i.test(a.ComponentID || '')
    || /Multiplexor|MAC Bridge/i.test(a.InterfaceDescription || '');
}

function listNetGeneric() {
  const addrs = addressesByIface();
  return [...addrs.entries()].map(([name, list]) => ({
    type: 'net',
    key: normalizeKey(name),
    deviceId: makeDeviceId('net', normalizeKey(name)),
    title: name,
    description: 'Сетевой интерфейс',
    details: { addresses: list, virtual: null, status: list.length ? 'Up' : null },
    present: true,
  })).sort((x, y) => x.title.localeCompare(y.title));
}

function addressesByIface() {
  const map = new Map();
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    const usable = (list || [])
      .filter((a) => !a.internal)
      .map((a) => ({ family: a.family, address: a.address, mac: a.mac }));
    map.set(name, usable);
  }
  return map;
}

/** Имя интерфейса попадает в идентификатор, поэтому чистим разделители. */
function normalizeKey(name) {
  return String(name).replace(/[|:\s]+/g, '_');
}

// ------------------------------------------------- совмещённый опрос Windows

// Запуск PowerShell стоит секунд процессорного времени (сам процесс, WMI,
// антивирус), поэтому на Windows два перечисления идут одним запуском. Сбой
// одной половины не должен стирать другую: каждая закрыта своим try и
// помечена флагом, а наружу сорвавшийся источник выходит как null.
// Части сериализуются отдельно и склеиваются строкой: ConvertTo-Json общего
// объекта с вложенными списками на этой паре данных тратил около десяти секунд
// там, где разбор каждой части занимает доли секунды.
const COMBINED_SCRIPT = `$pOk = $true; $p = @(); try { $p = @(${PNP_PORTS_CMD}) } catch { $pOk = $false }; `
  + `$nOk = $true; $n = @(); try { $n = @(${NET_ADAPTERS_CMD}) } catch { $nOk = $false }; `
  + '$pj = ConvertTo-Json -InputObject $p -Compress -Depth 3; $nj = ConvertTo-Json -InputObject $n -Compress -Depth 4; '
  + '\'{"portsOk":\' + $pOk.ToString().ToLower() + \',"ports":\' + $pj + \',"netsOk":\' + $nOk.ToString().ToLower() + \',"nets":\' + $nj + \'}\'';

const asArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []));

/**
 * Порты и сетевые интерфейсы разом.
 * null у источника — он сорвался: решение «оставить прошлый список» за вызывающим.
 */
export async function listPortsAndNets({ ports: wantPorts = true, nets: wantNets = true } = {}) {
  if (process.platform === 'win32' && wantPorts && wantNets) {
    const rows = await psJson(COMBINED_SCRIPT, { timeoutMs: 30000, strict: true });
    const r = rows[0];
    if (!r) throw new Error('PowerShell не вернул перечень портов и интерфейсов');
    return {
      ports: r.portsOk === false ? null : portsFromPnp(asArray(r.ports)),
      nets: r.netsOk === false ? null : netsFromAdapters(asArray(r.nets)),
    };
  }
  return {
    ports: wantPorts ? await listPorts().catch((e) => { log.warn('перечисление портов не удалось:', e.message); return null; }) : [],
    nets: wantNets ? await listNetInterfaces().catch((e) => { log.warn('перечисление сетевых интерфейсов не удалось:', e.message); return null; }) : [],
  };
}

// ------------------------------------------------ дешёвый признак «изменилось»

// Раздел реестра с активными COM и LPT-портами: меняется, когда порт
// появляется или исчезает. Читается reg.exe за миллисекунды, без WMI.
const PORT_REG_KEYS = ['HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM', 'HKLM\\HARDWARE\\DEVICEMAP\\PARALLEL PORTS'];

async function regSnapshot(key) {
  const r = await run('reg.exe', ['query', key], { timeoutMs: 5000 });
  if (r.spawnError || r.timedOut) return null;
  // Код 1 — раздела нет, то есть портов этого вида нет: это ответ, а не сбой.
  if (!r.ok && r.code !== 1) return null;
  return r.ok ? r.stdout.replace(/\s+/g, ' ').trim() : '';
}

/** Состав интерфейсов, их MAC и адреса — в самом процессе, без запуска чего-либо. */
export function netSignature() {
  return Object.entries(os.networkInterfaces())
    .map(([name, list]) => [name, (list || []).filter((a) => !a.internal).map((a) => `${a.mac}|${a.address}`).sort().join(',')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((row) => row.join('='))
    .join(';');
}

/**
 * Дешёвый отпечаток того, что перечисляют порты и интерфейсы. Совпал — тяжёлый
 * опрос не нужен. null — отпечаток недоступен (не Windows или сбой чтения):
 * вызывающий обязан перечитать всё по-настоящему.
 */
export async function slowSignature({ ports: wantPorts = true, nets: wantNets = true } = {}) {
  if (process.platform !== 'win32') return null;
  const parts = [];
  if (wantNets) parts.push(`n:${netSignature()}`);
  if (wantPorts) {
    const snaps = await Promise.all(PORT_REG_KEYS.map(regSnapshot));
    if (snaps.some((s) => s === null)) return null;
    parts.push(`c:${snaps[0]}`, `l:${snaps[1]}`);
  }
  return parts.join('\n');
}
