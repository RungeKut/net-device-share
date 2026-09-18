// Linux-бэкенд.
//
// Здесь USB/IP есть в самом ядре, отдельных драйверов ставить не нужно —
// достаточно модулей usbip_host (сервер) и vhci_hcd (клиент) и пакета
// linux-tools-usbip / usbip.
//
// Перечисление устройств идёт напрямую из sysfs, а не через разбор вывода
// `usbip list`: sysfs даёт и производителя, и серийный номер, и время
// подключения (по mtime каталога), причём в стабильном формате.

import fs from 'node:fs/promises';
import path from 'node:path';
import { UsbBackend, run } from './backend.js';
import { logger } from '../log.js';

const log = logger('usb:linux');
const SYSFS = '/sys/bus/usb/devices';

export class LinuxBackend extends UsbBackend {
  constructor(opts = {}) {
    super(opts);
    this.name = 'linux';
    this.usbip = opts.usbipPath || 'usbip';
    this.usbipd = opts.usbipdPath || 'usbipd';
  }

  async probe() {
    const issues = [];
    const v = await run(this.usbip, ['version'], { timeoutMs: 8000 });
    const hasTool = !v.spawnError;
    if (!hasTool) {
      issues.push('Не найдена утилита usbip. Установите пакет usbip (Debian/Ubuntu: linux-tools-generic).');
    }

    const vhci = await exists('/sys/devices/platform/vhci_hcd.0') || await exists('/sys/devices/platform/vhci_hcd');
    if (!vhci) issues.push('Модуль vhci_hcd не загружен — выполните: sudo modprobe vhci_hcd');

    const host = await exists('/sys/bus/usb/drivers/usbip-host');
    if (!host) issues.push('Модуль usbip_host не загружен — выполните: sudo modprobe usbip_host');

    if (process.getuid && process.getuid() !== 0) {
      issues.push('Операции bind/attach требуют root — запускайте через sudo.');
    }

    return {
      available: hasTool,
      server: hasTool && host,
      client: hasTool && vhci,
      tools: { usbip: hasTool ? this.usbip : null, usbipd: this.usbipd },
      issues,
    };
  }

  async listLocal() {
    let entries;
    try {
      entries = await fs.readdir(SYSFS);
    } catch (e) {
      log.warn('sysfs недоступна:', e.message);
      return [];
    }

    const out = [];
    for (const name of entries) {
      // Нас интересуют только сами устройства: "1-4", "1-4.2".
      // Интерфейсы ("1-4:1.0") и корневые хабы ("usb1") пропускаем.
      if (name.includes(':') || name.startsWith('usb')) continue;
      if (!/^\d+-\d+(\.\d+)*$/.test(name)) continue;

      const dir = path.join(SYSFS, name);
      const [vendorId, productId, product, manufacturer, serial, driver, stat] = await Promise.all([
        readAttr(dir, 'idVendor'),
        readAttr(dir, 'idProduct'),
        readAttr(dir, 'product'),
        readAttr(dir, 'manufacturer'),
        readAttr(dir, 'serial'),
        readLink(path.join(dir, 'driver')),
        fs.stat(dir).catch(() => null),
      ]);
      if (!vendorId || !productId) continue;

      const description = [manufacturer, product].filter(Boolean).join(' ')
        || `USB ${vendorId}:${productId}`;

      out.push({
        busid: name,
        vendorId: vendorId.toLowerCase(),
        productId: productId.toLowerCase(),
        description,
        serial: serial || null,
        instanceId: name,
        bound: driver === 'usbip-host',
        attachedByIp: null, // сторона сервера не знает адрес клиента штатными средствами
        connectedSince: stat ? stat.mtimeMs : null,
        raw: { driver },
      });
    }
    return out.sort((a, b) => a.busid.localeCompare(b.busid, undefined, { numeric: true }));
  }

  async bind(busid) {
    const r = await run(this.usbip, ['bind', '-b', busid], { timeoutMs: 20000 });
    if (r.ok) return { ok: true };
    if (/already bound/i.test(r.stderr + r.stdout)) return { ok: true, already: true };
    throw new Error(cleanErr(r) || 'bind не удался');
  }

  async unbind(busid) {
    const r = await run(this.usbip, ['unbind', '-b', busid], { timeoutMs: 20000 });
    if (!r.ok && !/not bound/i.test(r.stderr + r.stdout)) {
      throw new Error(cleanErr(r) || 'unbind не удался');
    }
    return { ok: true };
  }

  async attach({ host, busid, port }) {
    // --tcp-port — глобальная опция, до подкоманды; порт назначает владелец.
    const args = port ? ['--tcp-port', String(port)] : [];
    args.push('attach', '-r', host, '-b', busid);
    const r = await run(this.usbip, args, { timeoutMs: 30000 });
    if (!r.ok) throw new Error(cleanErr(r) || 'attach не удался');
    const attached = await this.listAttached();
    const found = attached.find((a) => a.host === host && a.busid === busid);
    return { ok: true, vhciPort: found ? found.vhciPort : null, output: r.stdout.trim() };
  }

  async detach(vhciPort) {
    const r = await run(this.usbip, ['detach', '-p', String(vhciPort)], { timeoutMs: 20000 });
    if (!r.ok && !/not attached/i.test(r.stderr + r.stdout)) {
      throw new Error(cleanErr(r) || 'detach не удался');
    }
    return { ok: true };
  }

  async listAttached() {
    const r = await run(this.usbip, ['port'], { timeoutMs: 10000 });
    if (!r.ok && !r.stdout) return [];
    // Формат вывода совпадает с Windows-сборкой usbip — используем тот же разбор.
    const { parsePortOutput } = await import('./windows.js');
    return parsePortOutput(r.stdout);
  }
}

async function readAttr(dir, name) {
  try {
    return (await fs.readFile(path.join(dir, name), 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readLink(p) {
  try {
    return path.basename(await fs.readlink(p));
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function cleanErr(r) {
  return (r.stderr || r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join('; ');
}
