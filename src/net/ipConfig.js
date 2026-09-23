// Настройки IPv4 сетевой карты: прочитать у владельца, перенести занявшему.
//
// Зачем. Занявший получает адаптер в сети за картой владельца, но пустой
// адаптер там бесполезен: устройства на стенде настроены на адрес, который
// был у карты владельца, и ждут его. Поэтому занявший получает те же
// настройки — DHCP или адрес, маску, шлюз и DNS. Конфликта адресов нет:
// пока карта отдана, у владельца IP на ней выключен (см. net/bridge.js).
//
// ЧИТАЕМ ИЗ РЕЕСТРА, а не у стека IP. Пока карта в мосту, TCP/IP от неё
// отвязан, и Get-NetIPAddress её не видит вовсе, а настройки в
// Tcpip\Parameters\Interfaces\{GUID} лежат нетронутыми. Там же видно, что
// задано вручную, а что получено по DHCP, — по стеку этого не различить.
//
// ШЛЮЗ И DNS С ПОНИЖЕННЫМ ПРИОРИТЕТОМ. Адаптеру занявшего ставится высокая
// метрика: иначе шлюз стенда перехватил бы выход в интернет самого
// компьютера, а DNS стенда — разрешение имён. Сеть стенда при этом
// доступна полностью, а всё остальное идёт как шло.

import { spawn } from 'node:child_process';
import { psJson, psQuote } from '../devices/backend.js';
import { logger } from '../log.js';

const log = logger('ip');

/** Метрика адаптера занявшего — заведомо хуже любой настоящей карты. */
export const BORROWED_METRIC = 400;

const REG = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\';

/**
 * Фрагмент PowerShell: настройки из реестра для интерфейса с GUID из
 * выражения guidExpr. Отдаёт объект или $null.
 */
export function registryExpr(guidExpr) {
  return `$(`
    + `$p = Get-ItemProperty -LiteralPath (${psQuote(REG)} + ${guidExpr}) -ErrorAction SilentlyContinue; `
    + 'if ($p) { [pscustomobject]@{ EnableDHCP = $p.EnableDHCP; IPAddress = @($p.IPAddress); '
    + 'SubnetMask = @($p.SubnetMask); DefaultGateway = @($p.DefaultGateway); NameServer = [string]$p.NameServer; '
    + 'DhcpIPAddress = [string]$p.DhcpIPAddress; DhcpSubnetMask = [string]$p.DhcpSubnetMask; '
    + 'DhcpDefaultGateway = @($p.DhcpDefaultGateway); DhcpNameServer = [string]$p.DhcpNameServer } } else { $null })';
}

function list(v) {
  // Отсутствующее значение PowerShell отдаёт как @($null) — то есть [null].
  return [].concat(v ?? []).filter((x) => x !== null && x !== undefined)
    .map((x) => String(x).trim()).filter((x) => x && x !== '0.0.0.0');
}

function servers(text) {
  return String(text || '').split(/[\s,]+/).filter(Boolean);
}

export function maskToPrefix(mask) {
  const parts = String(mask).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  const bits = parts.reduce((acc, p) => acc * 256 + p, 0);
  let prefix = 0;
  for (let i = 31; i >= 0 && ((bits / 2 ** i) & 1); i--) prefix++;
  return prefix;
}

/**
 * Настройки из значений реестра.
 *
 * @returns {{ dhcp: boolean, addresses: {address: string, prefixLength: number}[],
 *   gateways: string[], dns: string[], lease: object|null } | null}
 *   addresses, gateways и dns — то, что задано вручную (их и переносим);
 *   lease — что сейчас выдал DHCP (только для показа).
 */
export function fromRegistry(r) {
  if (!r) return null;
  const dhcp = Number(r.EnableDHCP) === 1;
  const ips = list(r.IPAddress);
  const masks = list(r.SubnetMask);
  const addresses = dhcp ? [] : ips
    .map((address, i) => ({ address, prefixLength: maskToPrefix(masks[i] || '255.255.255.0') }))
    .filter((a) => a.prefixLength !== null);
  const leaseIp = list(r.DhcpIPAddress)[0];
  return {
    dhcp,
    addresses,
    gateways: dhcp ? [] : list(r.DefaultGateway),
    // DNS бывает задан вручную и при DHCP — тогда он главнее выданного.
    dns: servers(r.NameServer),
    lease: dhcp && leaseIp ? {
      address: leaseIp,
      prefixLength: maskToPrefix(list(r.DhcpSubnetMask)[0] || '') ?? null,
      gateways: list(r.DhcpDefaultGateway),
      dns: servers(r.DhcpNameServer),
    } : null,
  };
}

/** Настройки интерфейса по GUID (с фигурными скобками или без). */
export async function readIpConfig(guid) {
  const g = `{${String(guid).replace(/[{}]/g, '')}}`;
  const items = await psJson(`${registryExpr(psQuote(g))} | ConvertTo-Json -Compress -Depth 3`);
  return fromRegistry(items[0] || null);
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const validIp = (s) => IPV4.test(s) && s.split('.').every((p) => Number(p) <= 255);

export function prefixToMask(prefix) {
  const bits = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((s) => (bits >>> s) & 255).join('.');
}

/**
 * netsh с разбором вывода. Сообщения он пишет в OEM-кодировке консоли
 * (на русской Windows — CP866), поэтому вывод декодируется ею, а не UTF-8.
 */
function netsh(args) {
  return new Promise((resolve) => {
    const child = spawn('netsh', ['interface', 'ipv4', ...args], { windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let text;
      try { text = new TextDecoder('ibm866').decode(Buffer.concat(chunks)); } catch { text = Buffer.concat(chunks).toString(); }
      resolve({ ok: code === 0, text: text.trim().split(/\r?\n/).filter(Boolean).join(' ') });
    });
  });
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Применить настройки к адаптеру. Нужны права администратора.
 *
 * ЧЕРЕЗ NETSH, А НЕ КОМАНДЛЕТЫ NetTCPIP. У адаптера, который ни разу не
 * настраивали, запись интерфейса в постоянном хранилище пустая, и
 * New-NetIPAddress на ней отказывает: «Inconsistent parameters PolicyStore
 * PersistentStore and Dhcp Enabled» — даже после явного Set-NetIPInterface
 * -Dhcp Disabled. netsh пишет настройки прямо в реестр и одинаково работает
 * с подключённым и отключённым адаптером. Адаптер задаётся номером: имя
 * бывает кириллическим.
 *
 * Результат проверяется по факту — перечитыванием из реестра.
 *
 * @param {string} guid
 * @param {object} cfg — { dhcp, addresses, gateways, dns }
 * @param {{ metric?: number, dad?: number }} [opts] — метрика интерфейса
 *   (не задана — остаётся как есть) и число проверок адреса на дубликат
 *   (у виртуальных адаптеров одного коммутатора — 0, см. netManager.js)
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function applyIpConfig(guid, cfg, { metric, dad } = {}) {
  // Настройки приходят по сети — в netsh попадают только проверенные
  // адреса, никакой произвольной строки.
  const addrs = (cfg?.addresses || []).filter((a) => validIp(a.address)
    && Number.isInteger(a.prefixLength) && a.prefixLength >= 1 && a.prefixLength <= 32);
  const gws = (cfg?.gateways || []).filter(validIp);
  const dns = (cfg?.dns || []).filter(validIp);
  const dhcp = Boolean(cfg?.dhcp) || !addrs.length;

  const g = `{${String(guid).replace(/[{}]/g, '')}}`;
  const found = await psJson(`Get-NetAdapter | Where-Object { $_.InterfaceGuid -eq ${psQuote(g)} } | Select-Object ifIndex | ConvertTo-Json -Compress`);
  const idx = Number(found[0]?.ifIndex);
  if (!Number.isInteger(idx) || idx <= 0) return { ok: false, error: 'адаптер не найден' };
  const now = await readIpConfig(g);

  const steps = [];
  const iface = [];
  if (Number.isInteger(metric) && metric > 0) iface.push(`metric=${metric}`);
  if (Number.isInteger(dad) && dad >= 0) iface.push(`dadtransmits=${dad}`);
  if (iface.length) steps.push(['set', 'interface', `interface=${idx}`, ...iface]);
  if (dhcp) {
    // netsh отвечает ошибкой «DHCP уже включён» — поэтому только если выключен.
    if (!now?.dhcp) steps.push(['set', 'address', `name=${idx}`, 'source=dhcp']);
  } else {
    const [first, ...rest] = addrs;
    steps.push(['set', 'address', `name=${idx}`, 'source=static', `address=${first.address}`,
      `mask=${prefixToMask(first.prefixLength)}`, `gateway=${gws[0] || 'none'}`]);
    for (const a of rest) steps.push(['add', 'address', `name=${idx}`, `address=${a.address}`, `mask=${prefixToMask(a.prefixLength)}`]);
    for (const gw of gws.slice(1)) steps.push(['add', 'address', `name=${idx}`, `gateway=${gw}`, 'gwmetric=0']);
  }
  if (dns.length) {
    steps.push(['set', 'dnsservers', `name=${idx}`, 'source=static', `address=${dns[0]}`, 'register=none', 'validate=no']);
    dns.slice(1).forEach((d, i) => steps.push(['add', 'dnsservers', `name=${idx}`, `address=${d}`, `index=${i + 2}`, 'validate=no']));
  } else if (now?.dns?.length) {
    steps.push(['set', 'dnsservers', `name=${idx}`, 'source=dhcp']);
  }

  for (const args of steps) {
    const r = await netsh(args);
    if (!r.ok) {
      const why = `netsh ${args.slice(0, 2).join(' ')}: ${r.text || 'ошибка'}`;
      log.warn(`настройки IP не применены к адаптеру ${g}: ${why}`);
      return { ok: false, error: why };
    }
  }

  // Проверка по факту: что теперь записано у адаптера.
  const got = await readIpConfig(g);
  const want = addrs.map((a) => `${a.address}/${a.prefixLength}`);
  const have = (got?.addresses || []).map((a) => `${a.address}/${a.prefixLength}`);
  const okNow = got && got.dhcp === dhcp && (dhcp || sameSet(want, have))
    && (dhcp || sameSet(gws, got.gateways)) && sameSet(dns, got.dns);
  if (!okNow) {
    const why = `после настройки у адаптера не то, что просили: ${JSON.stringify(got)}`;
    log.warn(`адаптер ${g}: ${why}`);
    return { ok: false, error: why };
  }
  return { ok: true };
}

/** Вернуть адаптер в чистое состояние: DHCP, без ручных адресов и DNS. */
export function resetIpConfig(guid) {
  return applyIpConfig(guid, { dhcp: true, addresses: [], gateways: [], dns: [] });
}

/**
 * Проверить и привести к порядку настройки, пришедшие от человека или по
 * сети. Адрес принимается и объектом, и строкой «10.0.0.5/24».
 *
 * @returns {{ dhcp: boolean, addresses: {address: string, prefixLength: number}[],
 *   gateways: string[], dns: string[] }}
 * @throws с объяснением по-русски — его увидит человек
 */
export function validateIpConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('настройки IP не заданы');
  const dhcp = Boolean(cfg.dhcp);
  const addresses = [];
  for (const a of [].concat(cfg.addresses || [])) {
    const [rawIp, rawPrefix] = typeof a === 'string' ? a.trim().split('/') : [a?.address, a?.prefixLength];
    const address = String(rawIp || '').trim();
    if (!address) continue;
    const prefixLength = rawPrefix === undefined || rawPrefix === '' ? 24 : Number(rawPrefix);
    if (!validIp(address)) throw new Error(`«${address}» — не адрес IPv4`);
    if (!Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 32) {
      throw new Error(`у адреса ${address} длина префикса ${rawPrefix} — нужна от 1 до 32 (24 — это маска 255.255.255.0)`);
    }
    if (!addresses.some((x) => x.address === address)) addresses.push({ address, prefixLength });
  }
  const list = (v, what) => {
    const out = [];
    for (const raw of [].concat(v || []).flatMap((x) => String(x).split(/[\s,;]+/))) {
      const s = raw.trim();
      if (!s) continue;
      if (!validIp(s)) throw new Error(`${what}: «${s}» — не адрес IPv4`);
      if (!out.includes(s)) out.push(s);
    }
    return out;
  };
  const gateways = list(cfg.gateways, 'шлюз');
  const dns = list(cfg.dns, 'DNS');
  if (!dhcp && !addresses.length) throw new Error('без DHCP нужен хотя бы один адрес');
  if (addresses.length > 16) throw new Error('больше 16 адресов на одном адаптере — это уже не настройка, а ошибка');
  if (gateways.length > 4 || dns.length > 4) throw new Error('шлюзов и DNS — не больше четырёх');
  return { dhcp, addresses: dhcp ? [] : addresses, gateways: dhcp ? [] : gateways, dns };
}

/**
 * Категория сети Windows у адаптеров: «частная» или «общедоступная».
 *
 * ОТ НЕЁ ЗАВИСИТ, ПУСТЯТ ЛИ К НАМ. Новый адаптер Windows относит к
 * общедоступной сети, и сетевой экран режет на нём входящие — ping,
 * серверы, всё. Причём не только брандмауэр Windows: Kaspersky Endpoint
 * Security берёт тип сети у неё же (проверено на стенде: входящий ping не
 * проходил, пока сеть была общедоступной, и пошёл сразу после перевода в
 * частную). Для сети стенда, куда адаптер для того и включают, это ровно
 * то, что мешает.
 *
 * Пока Windows опознаёт сеть («Идентификация…»), категорию не сменить —
 * такие адаптеры возвращаются с state 'pending', их надо повторить позже.
 *
 * @param {{ guid: string, category: 'Private'|'Public' }[]} items
 * @returns {Promise<{ guid: string, now: string|null, state: 'ok'|'set'|'pending'|'none', error?: string }[]>}
 */
export async function ensureCategories(items) {
  const want = items.filter((i) => i.guid && (i.category === 'Private' || i.category === 'Public'));
  if (!want.length) return [];
  const table = want.map((i) => `${psQuote(`{${String(i.guid).replace(/[{}]/g, '').toUpperCase()}}`)} = ${psQuote(i.category)}`).join('; ');
  const script = `$want = @{ ${table} }; $out = @(); `
    + 'foreach ($a in @(Get-NetAdapter -ErrorAction SilentlyContinue)) { '
    + '$g = ([string]$a.InterfaceGuid).ToUpper(); if (-not $want.ContainsKey($g)) { continue }; '
    + '$p = Get-NetConnectionProfile -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue | Select-Object -First 1; '
    + "if (-not $p) { $out += [pscustomobject]@{ guid = $g; now = $null; state = 'none' }; continue }; "
    + '$now = [string]$p.NetworkCategory; '
    + "if ($now -eq $want[$g] -or $now -eq 'DomainAuthenticated') { $out += [pscustomobject]@{ guid = $g; now = $now; state = 'ok' }; continue }; "
    + 'try { Set-NetConnectionProfile -InterfaceIndex $a.ifIndex -NetworkCategory $want[$g] -ErrorAction Stop; '
    + "$out += [pscustomobject]@{ guid = $g; now = $want[$g]; state = 'set' } } "
    + "catch { $out += [pscustomobject]@{ guid = $g; now = $now; state = 'pending'; error = $_.Exception.Message } } }; "
    + 'ConvertTo-Json -InputObject @($out) -Compress';
  const res = await psJson(script, { timeoutMs: 30000 });
  return res.map((r) => ({ ...r, guid: String(r.guid || '').replace(/[{}]/g, '') }));
}
