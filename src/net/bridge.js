// MAC-мост Windows: связать TAP-адаптер с физической картой и развязать.
//
// Сама работа — в scripts/net-bridge.ps1 (почему мост создаётся командой
// меню «Сетевых подключений», а не netsh или INetCfg — см. docs/HANDOVER.md,
// раздел про мост). Здесь — то, что нужно приложению вокруг неё.
//
// ОЧЕРЕДЬ. Мост в Windows один на компьютер, и его состав меняется
// секундами. Две операции разом перепутали бы друг другу состав, поэтому
// они выполняются строго по очереди.
//
// IP НА МОСТУ ПРИ ПРОБРОСЕ ВЫКЛЮЧАЕТСЯ. Пока карта отдана, её стек IP живёт
// на адаптере моста, и он пошёл бы за адресом в чужую сеть — а с адресом мог
// бы получить и шлюз по умолчанию, то есть переманить к себе трафик самого
// компьютера. Занятая карта принадлежит тому, кто её занял, поэтому на мосту
// протоколы IP снимаются. Владелец может вернуть их вручную — чтобы и самому
// остаться в сети карты (со своим, другим адресом); при освобождении всё
// возвращается как было (core/netShare.js). Перед разборкой привязки
// возвращаются: Windows бывает, что создаёт адаптер моста под прежним
// GUID, и снятые привязки иначе достались бы следующему мосту, собранному
// человеком.
//
// У коммутатора (core/netManager.js) IP на мосту — это доступ самого
// компьютера к сети карты, и включён он или нет, решает человек.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, psJson, psQuote } from '../devices/backend.js';
import { logger } from '../log.js';

const log = logger('bridge');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'net-bridge.ps1');

let chain = Promise.resolve();

/** Выполнить операцию с мостом после всех предыдущих. */
function queued(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function script(action, adapters = []) {
  const list = adapters.length ? ` -Adapter ${adapters.map(psQuote).join(',')}` : '';
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + `& ${psQuote(SCRIPT)} -Action ${action}${list} -Elevated -Json`;
  // -Command, а не -File: при -File список через запятую не разбирается.
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeoutMs: 120000 });
  // Ход работы сценарий пишет в поток ошибок с отметками времени.
  const trace = r.stderr.split(/\r?\n/).filter((l) => /^\d\d:\d\d:\d\d/.test(l));
  for (const l of trace) log.debug(`мост ${action}: ${l}`);
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('NDS-RESULT '));
  if (!line) {
    const last = trace.pop();
    const why = r.timedOut ? `не уложился в ${120} с` : (r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).pop() || `код ${r.code}`;
    throw new Error(`сценарий моста ${why}${last ? ` (последний шаг: ${last})` : ''}`);
  }
  const res = JSON.parse(line.slice('NDS-RESULT '.length));
  res.members = [].concat(res.members || []);
  log.debug(`мост ${action} ${adapters.join(' + ')}: ${res.ok ? 'готово' : res.message}; в мосту: ${res.members.join(', ') || 'никого'}`);
  return res;
}

/** Кто сейчас в мосту (имена подключений). */
export async function bridgeMembers() {
  const items = await psJson(
    "Get-NetAdapterBinding -AllBindings -ErrorAction SilentlyContinue | Where-Object { $_.ComponentID -eq 'ms_implat' -and $_.Enabled } "
    + '| Select-Object -Property Name | ConvertTo-Json -Compress',
  );
  return items.map((i) => i.Name).filter(Boolean);
}

/**
 * Адаптер самого моста: появляется, пока в мосту есть хоть кто-то.
 *
 * Бывает, что Windows создаёт его под тем же GUID, что и в прошлый раз, —
 * вместе с настройками IP прошлого моста; бывает, что под новым (видели
 * оба случая). Поэтому GUID запоминается при каждой сборке, а то, что
 * поменяли на время, возвращается до разборки.
 *
 * MAC у него — MAC первого участника моста. Проброс ставит первым свой
 * TAP: MAC моста не совпадает с MAC карты. Коммутатор — карту: компьютер
 * остаётся в её сети под её MAC, и DHCP выдаёт ему прежний адрес.
 *
 * @returns {Promise<{ name: string, guid: string, mac: string }|null>}
 */
export async function bridgeAdapter() {
  const items = await psJson(
    "Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Multiplexor|MAC Bridge' } "
    + '| Select-Object -Property Name,InterfaceGuid,MacAddress | ConvertTo-Json -Compress',
  );
  const a = items[0];
  return a ? { name: a.Name, guid: String(a.InterfaceGuid).replace(/[{}]/g, '').toUpperCase(), mac: a.MacAddress } : null;
}

/** Включить или выключить IP на адаптере моста (нет моста — ничего). */
export async function setBridgeIp(enabled) {
  const a = await bridgeAdapter();
  if (!a) return false;
  const verb = enabled ? 'Enable-NetAdapterBinding' : 'Disable-NetAdapterBinding';
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `${verb} -Name ${psQuote(a.name)} -ComponentID ms_tcpip,ms_tcpip6 -ErrorAction Stop`], { timeoutMs: 30000 });
  if (!r.ok) {
    const why = r.stderr.trim().split(/\r?\n/)[0] || `код ${r.code}`;
    log.warn(`протоколы IP на мосту не ${enabled ? 'возвращены' : 'сняты'}: ${why}`);
    throw new Error(`IP на мосту не ${enabled ? 'включён' : 'выключен'}: ${why}`);
  }
  return true;
}

/**
 * Связать адаптеры мостом. Повтор безопасен: уже связанные пропускаются.
 * В готовый мост можно добавить и один адаптер.
 *
 * @param {string[]} adapters имена подключений; первый задаёт MAC моста
 * @param {{ hostIp?: boolean }} [o] — оставить ли на мосту IP. Для
 *   проброса — нет: настройки карты уходят к занявшему (см. выше).
 *   Для коммутатора — как решит человек.
 */
export function bridge(adapters, { hostIp = false } = {}) {
  return queued(async () => {
    const res = await script('bridge', adapters);
    if (!res.ok) throw new Error(res.message || 'мост не собрался');
    if (!hostIp) await setBridgeIp(false).catch(() => {});
    return res.members;
  });
}

/**
 * Вывести адаптеры из моста. Мост исчезает сам вместе с последним
 * участником.
 * @param {string[]} adapters имена подключений
 */
export function unbridge(adapters) {
  return queued(async () => {
    const members = await bridgeMembers();
    const ours = adapters.filter((a) => members.includes(a));
    if (!ours.length) return members;
    // Уходят все — мост исчезнет; привязки IP возвращаем до этого.
    if (members.every((m) => ours.includes(m))) await setBridgeIp(true).catch(() => {});
    const res = await script('unbridge', ours);
    if (!res.ok) throw new Error(res.message || 'мост не разобрался');
    return res.members;
  });
}
