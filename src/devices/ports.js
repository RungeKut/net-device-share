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
import { psJson } from './backend.js';
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

async function listPortsWindows() {
  const items = await psJson(
    'Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue | '
    + 'Select-Object -Property FriendlyName,InstanceId,Status | ConvertTo-Json -Compress -Depth 3',
  );

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

async function listNetWindows() {
  const adapters = await psJson(
    // Настройки IP — из реестра тем же вызовом: у отданной карты стек IP
    // отвязан, а показать, с какими настройками она работает, всё равно надо.
    'Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ '
    + 'Name = $_.Name; InterfaceDescription = $_.InterfaceDescription; InterfaceGuid = $_.InterfaceGuid; '
    + 'Status = [string]$_.Status; MacAddress = $_.MacAddress; LinkSpeed = $_.LinkSpeed; Virtual = $_.Virtual; '
    + 'ComponentID = $_.ComponentID; HardwareInterface = $_.HardwareInterface; '
    + 'NdisPhysicalMedium = $_.NdisPhysicalMedium; '
    + `Reg = ${registryExpr('$_.InterfaceGuid')} } } `
    + '| ConvertTo-Json -Compress -Depth 4',
  );
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
