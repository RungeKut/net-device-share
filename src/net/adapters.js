// Опись сетевых адаптеров компьютера — для карты сети и её настройки.
//
// Одним вызовом PowerShell: адаптеры, привязки (IP включён? в мосту?),
// действующие адреса, профиль сети и настройки из реестра. По отдельности
// это полтора десятка запусков PowerShell и секунды ожидания; разом —
// около секунды.
//
// Здесь только наблюдение. Что из этого наше и что с ним можно делать,
// решает core/netManager.js.

import { psJson, psQuote } from '../devices/backend.js';
import { registryExpr, fromRegistry } from './ipConfig.js';

/** NdisPhysicalMedium беспроводных сред: WirelessLan, WirelessWan, Native802_11. */
const WIRELESS_MEDIA = new Set([1, 8, 9]);

const cleanGuid = (g) => String(g || '').replace(/[{}]/g, '').toUpperCase();

/** Это адаптер самого моста Windows. */
export function isBridgeAdapter(description) {
  return /Multiplexor|MAC Bridge/i.test(description || '');
}

const SCRIPT = [
  '$bind = @{}',
  "Get-NetAdapterBinding -AllBindings -ComponentID ms_tcpip,ms_implat -ErrorAction SilentlyContinue | ForEach-Object { $bind[$_.Name + '|' + $_.ComponentID] = [bool]$_.Enabled }",
  '$ipif = @{}',
  'Get-NetIPInterface -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $ipif[[int]$_.InterfaceIndex] = $_ }',
  '$addr = @{}',
  'Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $k = [int]$_.InterfaceIndex; if (-not $addr.ContainsKey($k)) { $addr[$k] = @() }; '
    + '$addr[$k] += [pscustomobject]@{ address = $_.IPAddress; prefixLength = [int]$_.PrefixLength; origin = [string]$_.PrefixOrigin; state = [string]$_.AddressState } }',
  '$prof = @{}',
  'Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { $prof[[int]$_.InterfaceIndex] = $_ }',
  '$gw = @{}',
  "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | ForEach-Object { $gw[[int]$_.InterfaceIndex] = $true }",
  // MAC меняется, если у драйвера есть свойство NetworkAddress (на вкладке
  // «Дополнительно» оно «Network Address» или «MAC Address»). Значение не
  // пустое — MAC уже задан вместо заводского.
  '$na = @{}',
  'Get-NetAdapterAdvancedProperty -RegistryKeyword NetworkAddress -ErrorAction SilentlyContinue | ForEach-Object { $na[$_.Name] = [string](@($_.RegistryValue) -join \'\') }',
  '$list = @(Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { $i = [int]$_.ifIndex; $p = $prof[$i]; $n = $ipif[$i]; [pscustomobject]@{ '
    + 'Name = $_.Name; Description = $_.InterfaceDescription; Guid = [string]$_.InterfaceGuid; Index = $i; '
    + 'Status = [string]$_.Status; Mac = $_.MacAddress; Speed = $_.LinkSpeed; Hardware = [bool]$_.HardwareInterface; '
    + 'Virtual = [bool]$_.Virtual; ComponentID = $_.ComponentID; Medium = $_.NdisPhysicalMedium; PnP = $_.PnPDeviceID; '
    + "Tcpip = $bind[$_.Name + '|ms_tcpip']; Bridged = $bind[$_.Name + '|ms_implat']; "
    + 'Metric = $(if ($n) { $n.InterfaceMetric } else { $null }); Dad = $(if ($n) { $n.DadTransmits } else { $null }); '
    + 'DefaultRoute = [bool]$gw[$i]; Addr = @($addr[$i]); '
    + 'MacProp = $na.ContainsKey($_.Name); MacSet = $na[$_.Name]; '
    + 'Profile = $(if ($p) { [pscustomobject]@{ name = $p.Name; category = [string]$p.NetworkCategory } } else { $null }); '
    + `Reg = ${registryExpr('$_.InterfaceGuid')} } })`,
  'ConvertTo-Json -InputObject $list -Compress -Depth 5',
].join('; ');

/**
 * Все адаптеры системы.
 *
 * @returns {Promise<object[]>} записи вида { guid, name, description, index,
 *   status, mac, speed, pnpId, hardware, wireless, bridge, tap, virtual,
 *   hyperv, software, macSettable, macCustom, tcpip, bridged, metric, dad,
 *   defaultRoute, addresses, profile, ip }
 */
export async function listAdapters() {
  const items = await psJson(SCRIPT, { timeoutMs: 30000 });
  return items.map((a) => ({
    guid: cleanGuid(a.Guid),
    name: a.Name,
    description: a.Description || '',
    index: a.Index,
    status: a.Status || null,
    mac: a.Mac || null,
    speed: a.Speed || null,
    pnpId: a.PnP || null,
    hardware: Boolean(a.Hardware),
    wireless: WIRELESS_MEDIA.has(Number(a.Medium)),
    bridge: isBridgeAdapter(a.Description),
    tap: /^tap0901$/i.test(a.ComponentID || ''),
    virtual: Boolean(a.Virtual),
    // Адаптер Hyper-V (vEthernet): им распоряжается Hyper-V, а не «Сетевые
    // подключения» — удаляется и меняет MAC он вместе с коммутатором Hyper-V.
    hyperv: /^ROOT\\VMS_MP\\/i.test(a.PnP || '') || /Hyper-V Virtual Ethernet/i.test(a.Description || ''),
    // Программное устройство (ROOT\…): его можно удалить, и само оно не
    // вернётся. Физическую карту Windows нашла бы снова.
    software: /^ROOT\\/i.test(a.PnP || ''),
    macSettable: Boolean(a.MacProp),
    macCustom: Boolean(a.MacSet && String(a.MacSet).trim()),
    // null — привязки нет вовсе (у адаптера моста привязки ms_implat нет).
    tcpip: a.Tcpip === undefined ? null : a.Tcpip,
    bridged: Boolean(a.Bridged),
    metric: a.Metric ?? null,
    dad: a.Dad ?? null,
    defaultRoute: Boolean(a.DefaultRoute),
    addresses: [].concat(a.Addr || []).filter((x) => x && x.address)
      .map((x) => ({ address: x.address, prefixLength: x.prefixLength, origin: x.origin, state: x.state })),
    profile: a.Profile ? { name: a.Profile.name, category: a.Profile.category } : null,
    ip: fromRegistry(a.Reg),
  })).sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Кто фильтрует входящие: сторонний сетевой экран (Kaspersky и т. п.) и
 * состояние брандмауэра Windows по профилям.
 *
 * Сторонний экран сам решает, что пускать, и через Windows им не
 * управлять — но человеку надо знать, куда смотреть, если к его серверам
 * не пускают. Центр безопасности есть только в клиентских Windows; на
 * серверных список просто пуст.
 */
export async function firewallState() {
  const products = await psJson(
    'Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct -ErrorAction SilentlyContinue '
    + '| Select-Object displayName,productState | ConvertTo-Json -Compress',
  );
  const profiles = await psJson(
    'Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction SilentlyContinue | ForEach-Object { '
    + '[pscustomobject]@{ name = [string]$_.Name; enabled = [bool]$_.Enabled } } | ConvertTo-Json -Compress',
  );
  return {
    // productState: биты 12–15 — включён ли продукт (1 — да).
    thirdParty: products
      // «Kaspersky … для Windows» — сторонний, поэтому сверяем начало имени.
      .filter((p) => p.displayName && !/^(Windows|Microsoft|Брандмауэр Windows|Защитник Windows)/i.test(p.displayName)
        && ((Number(p.productState) >> 12) & 0xf) === 1)
      .map((p) => p.displayName),
    windows: Object.fromEntries(profiles.map((p) => [p.name, p.enabled])),
  };
}

/**
 * Включить или выключить IP (IPv4 и IPv6) на адаптере по имени.
 * Нужен для адаптера моста: пока карта отдана, IP на нём выключен.
 */
export async function setIpBinding(name, enabled) {
  const verb = enabled ? 'Enable-NetAdapterBinding' : 'Disable-NetAdapterBinding';
  const res = await psJson(`try { ${verb} -Name ${psQuote(name)} -ComponentID ms_tcpip,ms_tcpip6 -ErrorAction Stop; `
    + "'{\"ok\":true}' } catch { ConvertTo-Json @{ ok = $false; error = $_.Exception.Message } -Compress }");
  const r = res[0] || { ok: false, error: 'PowerShell не ответил' };
  if (!r.ok) throw new Error(`IP на «${name}» не ${enabled ? 'включён' : 'выключен'}: ${r.error}`);
}
