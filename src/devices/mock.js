// Учебно-отладочный бэкенд: имитирует USB/IP без драйверов.
//
// Нужен для двух вещей: разработки логики сети и занятости на машине
// без установленных драйверов, и приёмки — два экземпляра приложения
// с `--backend mock` полностью проигрывают сценарий «занял / освободил»
// по настоящей сети.
//
// Состав набора устройств задаётся переменной NDS_MOCK_DEVICES
// (JSON-массив) — иначе берётся набор по умолчанию.

import os from 'node:os';
import { UsbBackend } from './backend.js';
import { logger } from '../log.js';

const log = logger('usb:mock');

const DEFAULT_DEVICES = [
  { busid: '1-1', vendorId: '0403', productId: '6001', description: 'FTDI USB Serial Converter', serial: 'FT1ABCD2' },
  { busid: '1-4', vendorId: '046d', productId: 'c52b', description: 'Logitech Unifying Receiver', serial: null },
  { busid: '2-2', vendorId: '0781', productId: '5591', description: 'SanDisk Ultra USB 3.0', serial: '4C530001' },
  { busid: '2-3', vendorId: '1a86', productId: '7523', description: 'CH340 Serial Adapter', serial: null },
];

export class MockBackend extends UsbBackend {
  constructor(opts = {}) {
    super(opts);
    this.name = 'mock';
    this.startedAt = Date.now();

    let base = DEFAULT_DEVICES;
    if (process.env.NDS_MOCK_DEVICES) {
      try {
        base = JSON.parse(process.env.NDS_MOCK_DEVICES);
      } catch (e) {
        log.warn('NDS_MOCK_DEVICES не разобрана, берём набор по умолчанию:', e.message);
      }
    }

    // Суффикс имени хоста делает устройства разных узлов различимыми,
    // когда несколько экземпляров работают в одной сети.
    const tag = os.hostname().slice(0, 6);
    this.devices = base.map((d) => ({
      ...d,
      description: `${d.description} [${tag}]`,
      instanceId: `MOCK\\VID_${d.vendorId}&PID_${d.productId}\\${d.serial || d.busid}`,
      bound: false,
      attachedByIp: null,
      connectedSince: this.startedAt,
      raw: { mock: true },
    }));
    this.attached = [];
    this.nextPort = 0;
  }

  async probe() {
    return {
      available: true,
      server: true,
      client: true,
      tools: { mock: 'встроенный' },
      // Имитация — это осознанно выбранный режим, а не неисправность.
      // Поэтому примечание, а не замечание: интерфейс не должен кричать
      // «окружение настроено не полностью» о том, что запрошено намеренно.
      //
      // Откуда взялся режим — знает не бэкенд, а приложение: из флага
      // запуска или из файла настроек. Поэтому здесь только суть, а как
      // выйти, дописывает app.js: совет «уберите флаг» бесполезен тому,
      // у кого режим записан в конфигурации.
      issues: [],
      notes: ['Режим имитации USB/IP: все показанные устройства вымышлены, ничего никуда не пробрасывается.'],
    };
  }

  async listLocal() {
    return this.devices.map((d) => ({ ...d }));
  }

  async bind(busid) {
    const d = this.devices.find((x) => x.busid === busid);
    if (!d) throw new Error(`устройство ${busid} не найдено`);
    d.bound = true;
    log.debug('bind', busid);
    return { ok: true };
  }

  async unbind(busid) {
    const d = this.devices.find((x) => x.busid === busid);
    if (d) d.bound = false;
    log.debug('unbind', busid);
    return { ok: true };
  }

  async attach({ host, busid }) {
    const vhciPort = this.nextPort++;
    this.attached.push({ vhciPort, host, busid, status: '<Port in Use> (mock)' });
    log.debug('attach', `${host}/${busid}`, '→ порт', vhciPort);
    return { ok: true, vhciPort, output: 'mock attach' };
  }

  async detach(vhciPort) {
    this.attached = this.attached.filter((a) => a.vhciPort !== Number(vhciPort));
    log.debug('detach порт', vhciPort);
    return { ok: true };
  }

  async listAttached() {
    return this.attached.map((a) => ({ ...a }));
  }
}
