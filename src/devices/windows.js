// Windows-бэкенд.
//
// На Windows роль сервера и роль клиента обслуживаются РАЗНЫМИ проектами,
// и они устанавливаются независимо. Поэтому наличие серверной и клиентской
// частей проверяется по отдельности: можно раздавать устройства, не имея
// возможности подключать чужие, и наоборот.
//
//   сервер  — usbipd-win  (usbipd.exe): публикация локальных устройств
//   клиент  — usbip-win2  (usbip.exe):  VHCI-драйвер, устройство появляется
//                                       в «Диспетчере устройств»
//
// Подробности установки — в docs/WINDOWS-SETUP.md.

import { UsbBackend, run, firstExistingPath } from './backend.js';
import { logger } from '../log.js';

const log = logger('usb:win');

const USBIPD_CANDIDATES = [
  'usbipd.exe',
  'C:\\Program Files\\usbipd-win\\usbipd.exe',
  'C:\\Program Files (x86)\\usbipd-win\\usbipd.exe',
];

const USBIP_CANDIDATES = [
  'usbip.exe',
  'C:\\Program Files\\usbip-win2\\usbip.exe',
  'C:\\Program Files\\usbip-win\\usbip.exe',
  'C:\\Program Files\\USBIP\\usbip.exe',
];

export class WindowsBackend extends UsbBackend {
  constructor(opts = {}) {
    super(opts);
    this.name = 'windows';
    this.usbipd = null;
    this.usbip = null;
  }

  async _resolveTools() {
    // Явные пути из конфигурации имеют приоритет: у пользователя
    // утилиты могут лежать где угодно.
    const dPath = this.opts.usbipdPath || null;
    const cPath = this.opts.usbipPath || null;

    this.usbipd = (dPath && (await this._works(dPath, ['--version'])) ? dPath : null)
      || (await this._firstWorking(USBIPD_CANDIDATES, ['--version']));

    this.usbip = (cPath && (await this._works(cPath, ['version'])) ? cPath : null)
      || (await this._firstWorking(USBIP_CANDIDATES, ['version']));
  }

  async _works(cmd, args) {
    const r = await run(cmd, args, { timeoutMs: 8000 });
    // Некоторые сборки usbip.exe печатают версию и выходят с ненулевым кодом,
    // поэтому успехом считаем сам факт запуска процесса.
    return !r.spawnError && !r.timedOut;
  }

  async _firstWorking(candidates, args) {
    const literal = firstExistingPath(candidates.filter((c) => c.includes('\\')));
    const ordered = literal ? [candidates[0], literal] : [candidates[0]];
    for (const c of ordered) {
      if (await this._works(c, args)) return c;
    }
    return null;
  }

  async probe() {
    await this._resolveTools();
    const issues = [];
    if (!this.usbipd) {
      issues.push('Не найден usbipd.exe (usbipd-win) — раздача своих устройств недоступна. См. docs/WINDOWS-SETUP.md');
    }
    if (!this.usbip) {
      issues.push('Не найден usbip.exe (usbip-win2) — подключение чужих устройств недоступно. См. docs/WINDOWS-SETUP.md');
    }
    return {
      available: Boolean(this.usbipd || this.usbip),
      server: Boolean(this.usbipd),
      client: Boolean(this.usbip),
      tools: { usbipd: this.usbipd, usbip: this.usbip },
      issues,
    };
  }

  async listLocal() {
    if (!this.usbipd) await this._resolveTools();
    if (!this.usbipd) return this._listViaPowerShell();

    // usbipd state отдаёт JSON — это основной путь, текстовый разбор
    // остаётся только для старых сборок.
    const j = await run(this.usbipd, ['state'], { timeoutMs: 10000 });
    if (j.ok && j.stdout.trim().startsWith('{')) {
      try {
        return this._parseStateJson(JSON.parse(j.stdout));
      } catch (e) {
        log.debug('не разобрался JSON от "usbipd state":', e.message);
      }
    }

    const t = await run(this.usbipd, ['list'], { timeoutMs: 10000 });
    if (t.ok) return this._parseListText(t.stdout);

    log.warn('не удалось получить список устройств:', t.stderr.trim() || t.stdout.trim());
    return this._listViaPowerShell();
  }

  _parseStateJson(state) {
    const devices = state?.Devices || state?.devices || [];
    return devices.map((d) => {
      const instanceId = d.InstanceId || d.instanceId || '';
      const { vendorId, productId } = parseIds(d.HardwareId || instanceId);
      const clientIp = d.ClientIPAddress || d.clientIPAddress || null;
      const persisted = d.PersistedGuid || d.persistedGuid || null;
      const stub = d.StubInstanceId || d.stubInstanceId || null;
      return {
        busid: d.BusId || d.busId,
        vendorId,
        productId,
        description: d.Description || d.description || 'USB-устройство',
        serial: extractSerial(instanceId),
        instanceId,
        // «bound» здесь означает «отдано драйверу-заглушке», то есть
        // устройство готово принимать подключения по сети.
        bound: Boolean(persisted || stub),
        attachedByIp: clientIp,
        raw: d,
      };
    }).filter((d) => d.busid);
  }

  _parseListText(text) {
    const out = [];
    const re = /^\s*(\d+-\d+(?:\.\d+)*)\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s+(.+?)\s{2,}(\S.*?)\s*$/;
    let inConnected = false;

    for (const line of text.split(/\r?\n/)) {
      if (/^Connected:/i.test(line)) { inConnected = true; continue; }
      if (/^Persisted:/i.test(line)) { inConnected = false; continue; }
      if (!inConnected || /^\s*BUSID/i.test(line)) continue;

      const m = line.match(re);
      if (!m) continue;
      const stateText = m[5].trim();
      out.push({
        busid: m[1],
        vendorId: m[2].toLowerCase(),
        productId: m[3].toLowerCase(),
        description: m[4].trim(),
        serial: null,
        instanceId: null,
        bound: /shared|attached/i.test(stateText) && !/not shared/i.test(stateText),
        attachedByIp: /attached/i.test(stateText) ? 'unknown' : null,
        raw: { state: stateText },
      });
    }
    return out;
  }

  /**
   * Запасной путь, когда usbipd не установлен: показать устройства всё равно
   * нужно, иначе пользователь видит пустой экран и не понимает, что не так.
   * Такие записи помечаются как непригодные к публикации.
   */
  async _listViaPowerShell() {
    // Без явной установки кодировки PowerShell пишет в перенаправленный поток
    // в кодировке консоли (на русской Windows — CP866), и названия устройств
    // превращаются в мусор при разборе как UTF-8.
    const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
      + 'Get-PnpDevice -Class USB -PresentOnly -ErrorAction SilentlyContinue | '
      + 'Select-Object -Property InstanceId,FriendlyName,Status | ConvertTo-Json -Compress -Depth 3';
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 20000 });
    if (!r.ok || !r.stdout.trim()) return [];

    let items;
    try {
      const parsed = JSON.parse(r.stdout);
      items = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }

    return items
      .filter((d) => d && typeof d.InstanceId === 'string' && d.InstanceId.startsWith('USB\\VID_'))
      .map((d) => {
        const { vendorId, productId } = parseIds(d.InstanceId);
        return {
          busid: null, // без usbipd номер шины неизвестен — публикация невозможна
          instanceId: d.InstanceId,
          vendorId,
          productId,
          description: d.FriendlyName || 'USB-устройство',
          serial: extractSerial(d.InstanceId),
          bound: false,
          attachedByIp: null,
          unavailableReason: 'Не установлен usbipd-win — публикация невозможна',
          raw: d,
        };
      });
  }

  async bind(busid) {
    if (!this.usbipd) throw new Error('usbipd-win не установлен');
    const r = await run(this.usbipd, ['bind', '--busid', busid], { timeoutMs: 20000 });
    if (r.ok) return { ok: true };
    if (/already (shared|bound)/i.test(r.stderr + r.stdout)) return { ok: true, already: true };

    // Композитные устройства и устройства, занятые собственным драйвером,
    // отдаются только принудительной привязкой.
    const forced = await run(this.usbipd, ['bind', '--busid', busid, '--force'], { timeoutMs: 20000 });
    if (forced.ok) return { ok: true, forced: true };
    throw new Error(cleanErr(r) || cleanErr(forced) || 'bind не удался');
  }

  async unbind(busid) {
    if (!this.usbipd) throw new Error('usbipd-win не установлен');
    const r = await run(this.usbipd, ['unbind', '--busid', busid], { timeoutMs: 20000 });
    if (!r.ok && !/not shared|not bound/i.test(r.stderr + r.stdout)) {
      throw new Error(cleanErr(r) || 'unbind не удался');
    }
    return { ok: true };
  }

  async attach({ host, busid, port }) {
    if (!this.usbip) throw new Error('usbip-win2 (клиент) не установлен');
    // --tcp-port у usbip — глобальная опция и идёт ДО подкоманды. Порт
    // назначает владелец: при включённом учёте трафика это порт его
    // счётчика, а не стандартный 3240.
    const args = port ? ['-t', String(port)] : [];
    args.push('attach', '-r', host, '-b', busid);
    const r = await run(this.usbip, args, { timeoutMs: 30000 });
    if (!r.ok) throw new Error(cleanErr(r) || 'attach не удался');

    // Номер VHCI-порта надёжнее выяснить из списка, чем разбирать вывод attach:
    // формат сообщения отличается между сборками usbip-win2.
    const attached = await this.listAttached();
    const found = attached.find((a) => a.host === host && a.busid === busid);
    return { ok: true, vhciPort: found ? found.vhciPort : null, output: r.stdout.trim() };
  }

  async detach(vhciPort) {
    if (!this.usbip) throw new Error('usbip-win2 (клиент) не установлен');
    const r = await run(this.usbip, ['detach', '-p', String(vhciPort)], { timeoutMs: 20000 });
    if (!r.ok && !/not attached|no such/i.test(r.stderr + r.stdout)) {
      throw new Error(cleanErr(r) || 'detach не удался');
    }
    return { ok: true };
  }

  async listAttached() {
    if (!this.usbip) return [];
    const r = await run(this.usbip, ['port'], { timeoutMs: 10000 });
    if (!r.ok && !r.stdout) return [];
    return parsePortOutput(r.stdout);
  }
}

/** Разбор вывода `usbip port`: порт VHCI ↔ адрес и busid источника. */
export function parsePortOutput(text) {
  const out = [];
  let current = null;

  for (const line of String(text).split(/\r?\n/)) {
    const portMatch = line.match(/^\s*Port\s+(\d+):\s*(.*)$/i);
    if (portMatch) {
      if (current) out.push(current);
      current = { vhciPort: Number(portMatch[1]), status: portMatch[2].trim(), host: null, busid: null };
      continue;
    }
    if (!current) continue;

    const urlMatch = line.match(/usbip:\/\/([^:/\s]+):(\d+)\/(\S+)/i);
    if (urlMatch) {
      current.host = urlMatch[1];
      current.usbipPort = Number(urlMatch[2]);
      current.busid = urlMatch[3];
      continue;
    }
    const idMatch = line.match(/\(([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\)/);
    if (idMatch) {
      current.vendorId = idMatch[1].toLowerCase();
      current.productId = idMatch[2].toLowerCase();
    }
  }
  if (current) out.push(current);
  return out.filter((p) => p.host && p.busid);
}

function parseIds(str) {
  const m = String(str || '').match(/VID_([0-9a-fA-F]{4})&PID_([0-9a-fA-F]{4})/);
  if (m) return { vendorId: m[1].toLowerCase(), productId: m[2].toLowerCase() };
  const plain = String(str || '').match(/^([0-9a-fA-F]{4}):([0-9a-fA-F]{4})$/);
  if (plain) return { vendorId: plain[1].toLowerCase(), productId: plain[2].toLowerCase() };
  return { vendorId: null, productId: null };
}

function extractSerial(instanceId) {
  const parts = String(instanceId || '').split('\\');
  if (parts.length < 3) return null;
  const last = parts[2];
  // Последний сегмент — либо серийный номер, либо позиционный ключ вида "5&1a2b&0&2".
  return /&/.test(last) ? null : last;
}

function cleanErr(r) {
  return (r.stderr || r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join('; ');
}
