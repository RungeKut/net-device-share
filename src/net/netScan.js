// Какие адреса в сети сетевой карты уже заняты, и какой взять следующим.
//
// Сканирует владелец карты: только он стоит в той сети. Пингуем всю подсеть
// одним запуском PowerShell и читаем таблицу соседей (ARP): хост, который не
// отвечает на ping, но отвечает на ARP, всё равно попадёт в таблицу, так что
// ICMP, закрытый брандмауэром, результат не портит. Берутся только записи,
// подтверждённые прямо сейчас: Stale — это память о хосте, которого уже может
// не быть.

import { psJson, psQuote } from '../devices/backend.js';
import { ipToInt, intToIp, networkAddress, broadcastAddress } from './interfaces.js';

/** Больше /22 не сканируем: тысяча адресов — предел разумного для фона. */
const MAX_HOSTS = 1022;

/** Сколько ждать ответа одного адреса, мс. */
const PING_TIMEOUT_MS = 400;

/**
 * Адреса, которые стоит опросить. Подсеть шире /22 сужается до /24, в
 * которой стоит сама карта: сканировать /16 фоном никто не просил.
 */
export function scanTargets(address, prefixLength) {
  let prefix = prefixLength;
  if (prefix < 22) prefix = 24;
  if (prefix >= 31) return [];
  const net = ipToInt(networkAddress(address, prefix));
  const bcast = ipToInt(broadcastAddress(address, prefix));
  const own = ipToInt(address);
  const out = [];
  for (let n = net + 1; n < bcast && out.length < MAX_HOSTS; n++) {
    if (n !== own) out.push(intToIp(n));
  }
  return out;
}

/**
 * Следующий свободный адрес «по порядку»: первый незанятый после адреса
 * владельца, а если подсеть кончилась — первый свободный с начала.
 *
 * @param {{ address: string, prefixLength: number, used: string[], reserved?: string[] }} o
 *   used — занятые адреса (результат сканирования), reserved — что ещё
 *   считать занятым: шлюзы, DNS, адреса самого владельца
 * @returns {string|null}
 */
export function suggestNextIp({ address, prefixLength, used = [], reserved = [] }) {
  if (prefixLength >= 31) return null;
  const net = ipToInt(networkAddress(address, prefixLength));
  const bcast = ipToInt(broadcastAddress(address, prefixLength));
  const taken = new Set([address, ...used, ...reserved].map(ipToInt));
  const start = ipToInt(address);
  for (let n = start + 1; n < bcast; n++) if (!taken.has(n)) return intToIp(n);
  for (let n = net + 1; n < start; n++) if (!taken.has(n)) return intToIp(n);
  return null;
}

/** MAC, который не принадлежит хосту: рассылка и multicast. */
function isHostMac(mac) {
  const m = String(mac || '').toLowerCase().replace(/-/g, ':');
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m)) return false;
  if (m === 'ff:ff:ff:ff:ff:ff') return false;
  return (parseInt(m.slice(0, 2), 16) & 1) === 0;
}

/**
 * Просканировать подсеть карты.
 *
 * @param {{ alias: string, address: string, prefixLength: number }} o
 *   alias — имя подключения в Windows (по нему читается таблица соседей)
 * @returns {Promise<{ ip: string, mac: string }[]>} занятые адреса, без самой карты
 */
export async function scanSubnet({ alias, address, prefixLength }) {
  const targets = scanTargets(address, prefixLength);
  if (!targets.length) return [];
  const script = `$ips = ${psQuote(targets.join(','))}.Split(','); `
    + '$p = foreach ($ip in $ips) { try { (New-Object System.Net.NetworkInformation.Ping).SendPingAsync($ip, ' + PING_TIMEOUT_MS + ') } catch { } }; '
    + 'try { [void][System.Threading.Tasks.Task]::WaitAll(@($p), 20000) } catch { }; '
    + `Get-NetNeighbor -InterfaceAlias ${psQuote(alias)} -AddressFamily IPv4 -ErrorAction SilentlyContinue `
    + "| Where-Object { $_.State -in 'Reachable','Delay','Probe' } "
    + '| ForEach-Object { [pscustomobject]@{ ip = $_.IPAddress; mac = $_.LinkLayerAddress } } | ConvertTo-Json -Compress';
  const rows = await psJson(script, { timeoutMs: 40000, strict: true });
  const within = new Set(targets);
  const seen = new Map();
  for (const r of rows) {
    if (within.has(r.ip) && isHostMac(r.mac)) seen.set(r.ip, String(r.mac).toLowerCase().replace(/:/g, '-'));
  }
  return [...seen].map(([ip, mac]) => ({ ip, mac })).sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
}
