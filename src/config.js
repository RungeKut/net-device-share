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
  // Учёт трафика: приложение принимает соединение USB/IP на своём порту,
  // считает байты и пересылает на usbipd. Выключение возвращает прямое
  // соединение на usbipPort — без цифр, но и без посредника в тракте данных.
  meterTraffic: true,
  trafficPort: 47813,        // TCP: порт счётчика трафика
  multicastAddress: '239.255.77.66',
  announceIntervalMs: 3000,
  peerTimeoutMs: 12000,      // 4 пропущенных анонса → узел офлайн
  peerForgetMs: 120000,
  claimLeaseMs: 30000,       // аренда занятости; продлевается heartbeat-ом
  heartbeatIntervalMs: 10000,
  preSharedKey: '',          // пусто → аутентификация выключена
  backend: 'auto',           // auto | windows | linux | mock
  autoShareNew: false,       // автоматически шарить вновь подключённые устройства
  enabledTypes: ['usb', 'com', 'lpt', 'net'], // какие типы устройств показывать
  sharedDeviceIds: [],       // какие локальные устройства опубликованы
  devicePurposes: {},        // deviceId → «что это и для чего»
  groups: [],                // [{ id, name, description, members: [deviceId] }]
  // Пароль удалённого доступа к интерфейсу. Хранится только как хеш.
  // Пусто → с других компьютеров доступен лишь просмотр.
  webPassword: null,         // { salt, hash }
  sessionSecret: null,       // ключ подписи сессионных cookie
  uiHost: '127.0.0.1',       // адрес, который печатается в подсказке при запуске
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
    if (!this.data.sessionSecret) {
      this.data.sessionSecret = crypto.randomBytes(32).toString('hex');
      dirty = true;
    }
    if (!Array.isArray(this.data.sharedDeviceIds)) {
      this.data.sharedDeviceIds = [];
      dirty = true;
    }
    if (!Array.isArray(this.data.groups)) {
      this.data.groups = [];
      dirty = true;
    }

    // Перенос с первой версии, где типов не было и ключом служил busid.
    if (Array.isArray(this.data.sharedBusIds)) {
      for (const busid of this.data.sharedBusIds) {
        const id = `usb:${busid}`;
        if (!this.data.sharedDeviceIds.includes(id)) this.data.sharedDeviceIds.push(id);
      }
      delete this.data.sharedBusIds;
      dirty = true;
    }
    if (this.data.deviceNotes && typeof this.data.deviceNotes === 'object') {
      this.data.devicePurposes = this.data.devicePurposes || {};
      for (const [busid, text] of Object.entries(this.data.deviceNotes)) {
        this.data.devicePurposes[`usb:${busid}`] ??= text;
      }
      delete this.data.deviceNotes;
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
  setShared(deviceId, shared) {
    const set = new Set(this.data.sharedDeviceIds);
    if (shared) set.add(deviceId);
    else set.delete(deviceId);
    this.data.sharedDeviceIds = [...set];
    this.save();
  }

  isShared(deviceId) {
    return this.data.sharedDeviceIds.includes(deviceId);
  }

  purposeOf(deviceId) {
    return (this.data.devicePurposes || {})[deviceId] || null;
  }

  setPurpose(deviceId, text) {
    const purposes = { ...(this.data.devicePurposes || {}) };
    const clean = String(text || '').trim().slice(0, 500);
    if (clean) purposes[deviceId] = clean;
    else delete purposes[deviceId];
    this.set({ devicePurposes: purposes });
  }

  // --------------------------------------------------- пароль веб-доступа

  /**
   * Пароль хранится только как scrypt-хеш со случайной солью.
   * Открытый пароль не нужен ни для чего: проверка сравнивает хеши.
   */
  setWebPassword(password) {
    if (!password) {
      this.set({ webPassword: null });
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
    this.set({ webPassword: { salt, hash } });
  }

  checkWebPassword(password) {
    const stored = this.data.webPassword;
    if (!stored || !stored.salt || !stored.hash) return false;
    if (!password) return false;
    const actual = crypto.scryptSync(String(password), stored.salt, 32);
    const expected = Buffer.from(stored.hash, 'hex');
    if (actual.length !== expected.length) return false;
    // Сравнение за постоянное время: иначе подбор пароля ускоряется
    // измерением времени ответа.
    return crypto.timingSafeEqual(actual, expected);
  }

  hasWebPassword() {
    return Boolean(this.data.webPassword && this.data.webPassword.hash);
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
  'traffic-port': 'trafficPort',
  key: 'preSharedKey',
  backend: 'backend',
  'log-level': 'logLevel',
  'ui-host': 'uiHost',
};

/**
 * Ключи, которые действуют ТОЛЬКО на текущий запуск и в файл не пишутся.
 *
 * `--backend` — отладочный переключатель, а не предпочтение. Когда он
 * сохранялся наравне с остальным, один запуск с `--backend mock` закреплял
 * имитацию навсегда, и совет «уберите --backend mock» становился
 * бессмысленным: убирать было нечего.
 */
const RUNTIME_ONLY = new Set(['backend']);

export function applyCliOverrides(config, args) {
  const patch = {};
  const runtime = {};

  for (const [cli, field] of Object.entries(CLI_MAP)) {
    if (args[cli] === undefined || args[cli] === true) continue;
    const numeric = field.endsWith('Port');
    const value = numeric ? Number(args[cli]) : args[cli];
    if (RUNTIME_ONLY.has(field)) runtime[field] = value;
    else patch[field] = value;
  }

  if (Object.keys(patch).length) {
    // Остальные переопределения сохраняем: пользователь ожидает, что
    // запуск с --name один раз закрепит имя узла.
    config.set(patch);
  }
  // Действуют, но не сохраняются: следующий запуск без флага вернётся
  // к тому, что записано в файле.
  Object.assign(config.data, runtime);
  config.runtimeOverrides = runtime;
  return config;
}
