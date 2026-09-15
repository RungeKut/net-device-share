// Конфигурация и постоянная идентичность узла.
// Хранится в профиле пользователя, чтобы nodeId переживал перезапуск:
// по нему остальные узлы сети узнают этот компьютер.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { logger } from './log.js';

const log = logger('config');

export const DEFAULTS = {
  nodeId: null,              // генерируется при первом запуске
  name: null,                // по умолчанию — имя компьютера
  network: 'auto',           // CIDR рабочей сети, например "192.168.1.0/24"
  discoveryPort: 47811,      // UDP: обнаружение узлов
  apiPort: 47812,            // HTTP: UI + RPC между узлами
  usbipPort: 3240,           // TCP: данные USB/IP (стандартный порт)
  multicastAddress: '239.255.77.66',
  announceIntervalMs: 3000,
  peerTimeoutMs: 12000,      // 4 пропущенных анонса → узел офлайн
  peerForgetMs: 120000,
  claimLeaseMs: 30000,       // аренда занятости; продлевается heartbeat-ом
  heartbeatIntervalMs: 10000,
  preSharedKey: '',          // пусто → аутентификация выключена
  backend: 'auto',           // auto | windows | linux | mock
  autoShareNew: false,       // автоматически шарить вновь подключённые устройства
  sharedBusIds: [],          // какие локальные устройства опубликованы
  deviceNotes: {},           // busid → заметка пользователя
  uiHost: '127.0.0.1',       // UI слушает только локально
  logLevel: 'info',
};

export function configDir() {
  if (process.env.NDS_HOME) return process.env.NDS_HOME;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'net-device-share');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'net-device-share');
}

export class Config {
  constructor(file) {
    this.file = file || path.join(configDir(), 'config.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      Object.assign(this.data, JSON.parse(raw));
      log.debug('конфигурация загружена из', this.file);
    } catch (e) {
      if (e.code !== 'ENOENT') log.warn('не удалось прочитать конфигурацию:', e.message);
    }

    // Самозаполняющиеся поля.
    let dirty = false;
    if (!this.data.nodeId) {
      this.data.nodeId = crypto.randomUUID();
      dirty = true;
    }
    if (!this.data.name) {
      this.data.name = os.hostname();
      dirty = true;
    }
    if (!Array.isArray(this.data.sharedBusIds)) {
      this.data.sharedBusIds = [];
      dirty = true;
    }
    if (dirty) this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Пишем через временный файл: при сбое старая конфигурация уцелеет.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      log.error('не удалось сохранить конфигурацию:', e.message);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
    return this.data;
  }

  /** Отмечает устройство как опубликованное (или снимает публикацию). */
  setShared(busid, shared) {
    const set = new Set(this.data.sharedBusIds);
    if (shared) set.add(busid);
    else set.delete(busid);
    this.data.sharedBusIds = [...set];
    this.save();
  }

  isShared(busid) {
    return this.data.sharedBusIds.includes(busid);
  }
}

/** Разбор аргументов командной строки вида --key value / --flag. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** Ключи CLI → поля конфигурации (только те, что имеет смысл переопределять). */
export const CLI_MAP = {
  name: 'name',
  network: 'network',
  'api-port': 'apiPort',
  'discovery-port': 'discoveryPort',
  'usbip-port': 'usbipPort',
  key: 'preSharedKey',
  backend: 'backend',
  'log-level': 'logLevel',
  'ui-host': 'uiHost',
};

export function applyCliOverrides(config, args) {
  const patch = {};
  for (const [cli, field] of Object.entries(CLI_MAP)) {
    if (args[cli] === undefined || args[cli] === true) continue;
    const numeric = field.endsWith('Port');
    patch[field] = numeric ? Number(args[cli]) : args[cli];
  }
  if (Object.keys(patch).length) {
    // Переопределения из CLI сохраняем: пользователь ожидает, что
    // запуск с --name один раз закрепит имя узла.
    config.set(patch);
  }
  return config;
}
