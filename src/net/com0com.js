// Пары виртуальных COM-портов com0com: то, через что чужой порт появляется
// у занявшего. Наш конец пары держит насос приложения, второй назван именем
// порта владельца — приложение человека открывает COM12, как открыло бы его
// у владельца. Управление — утилитой setupc из установленного com0com,
// своими руками драйвер не трогаем (GPL-2.0, не модифицируем).
//
// Провода пары по умолчанию соединены крест-накрест: RTS(A)→CTS(B),
// DTR(A)→DSR(B) и симметрично. Поэтому линии владельца доезжают без своей
// проводки: CTS владельца → наш RTS → CTS у человека. DCD и RING так не
// передаются — для них нужен IOCTL к OUT1/OUT2, это вне этапа.

import fs from 'node:fs';
import { logger } from '../log.js';
import { run } from '../devices/backend.js';

const log = logger('com0com');

/** Где setupc оставляет установщик com0com (те же пути, что в manifest.json). */
const SETUPC_PATHS = [
  'C:\\Program Files\\com0com\\setupc.exe',
  'C:\\Program Files (x86)\\com0com\\setupc.exe',
];

export function findSetupc() {
  for (const p of SETUPC_PATHS) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* недоступный путь просто пропускаем */ }
  }
  return null;
}

export function setupcPresent() {
  return findSetupc() !== null;
}

function requireSetupc() {
  const exe = findSetupc();
  if (!exe) throw new Error('com0com не установлен');
  return exe;
}

/**
 * Список портов com0com. Строка списка: «CNCA0 PortName=COM#,RealPortName=COM3»;
 * «PortName=-» — порту не задано имя. COM# означает «имя выбрал класс-установщик
 * Windows», настоящее имя тогда в RealPortName.
 */
export function parseList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^CNC([AB])(\d+)\s+(\S.*)$/);
    if (!m) continue;
    const params = {};
    for (const kv of m[3].split(',')) {
      const at = kv.indexOf('=');
      if (at > 0) params[kv.slice(0, at).trim()] = kv.slice(at + 1).trim();
    }
    const chosen = params.PortName && params.PortName !== '-' && params.PortName !== 'COM#'
      ? params.PortName : null;
    out.push({
      side: m[1],
      id: Number(m[2]),
      portName: chosen,
      realPortName: params.RealPortName || null,
      name: chosen || (params.RealPortName && params.RealPortName !== '-' ? params.RealPortName : null),
    });
  }
  return out;
}

export async function listPairs() {
  const exe = findSetupc();
  if (!exe) throw new Error('com0com не установлен');
  const r = await run(exe, ['list'], { timeoutMs: 30000 });
  if (!r.ok) throw new Error(`setupc list не удался (код ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return parseList(r.stdout);
}

/** COM-имена, уже занятые в системе: из DEVICEMAP\SERIALCOMM, без WMI. */
export async function usedComNames(runFn = run) {
  const r = await runFn('reg.exe', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'], { timeoutMs: 5000 });
  const out = new Set();
  if (!r.ok) return out;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/REG_SZ\s+(\S+)/);
    if (m) out.add(m[1].toUpperCase());
  }
  return out;
}

/**
 * Создать пару: сторона A — порт человека под именем владельца (или свободное,
 * если такое имя здесь занято), сторона B — наш конец с любым свободным именем.
 *
 * @param {string|null} ownerName — имя порта владельца («COM12»)
 * @param {object} [o]
 * @param {(cmd: string, args: string[], opts?: object) => Promise<object>} [o.runFn]
 * @param {() => Promise<Set<string>>} [o.usedNames]
 * @returns {Promise<{ id: number, ours: string, theirs: string, theirsNote: string|null }>}
 */
export async function createPair(ownerName, { runFn = null, usedNames = usedComNames } = {}) {
  // Подмена runFn — для тестов: настоящий setupc не ищется.
  const exe = runFn ? 'setupc' : requireSetupc();
  const run1 = runFn || run;

  const existing = parseList((await run1(exe, ['list'], { timeoutMs: 30000 })).stdout);
  const id = existing.reduce((max, p) => Math.max(max, p.id), -1) + 1;

  const used = await usedNames(run1);
  let theirsParam = 'PortName=COM#';
  let theirsNote = null;
  if (ownerName && !used.has(String(ownerName).toUpperCase())) {
    theirsParam = `PortName=${ownerName}`;
  } else if (ownerName) {
    theirsNote = `имя ${ownerName} на этом компьютере занято — порту выбрано свободное`;
  }

  const r = await run1(exe, ['install', String(id), theirsParam, 'PortName=COM#'], { timeoutMs: 120000 });
  if (!r.ok) throw new Error(`пара портов не создана (код ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);

  const after = parseList((await run1(exe, ['list'], { timeoutMs: 30000 })).stdout);
  const a = after.find((p) => p.side === 'A' && p.id === id);
  const b = after.find((p) => p.side === 'B' && p.id === id);
  if (!a?.name || !b?.name) {
    throw new Error(`пара ${id} создана, но имена портов не читаются — проверьте «Диспетчер устройств»`);
  }
  return { id, ours: b.name, theirs: a.name, theirsNote };
}

/** Убрать пару. Пары нет — не ошибка: уборка после сбоя вызывает это же. */
export async function removePair(id, { runFn = null } = {}) {
  const exe = runFn ? 'setupc' : findSetupc();
  if (!exe) return false;
  const run1 = runFn || run;
  const r = await run1(exe, ['remove', String(id)], { timeoutMs: 60000 });
  if (!r.ok) {
    log.debug(`setupc remove ${id}: ${(r.stderr || r.stdout).trim().slice(0, 120)}`);
    return false;
  }
  return true;
}
