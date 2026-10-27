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
  // Метрики Prometheus (GET /metrics на порту интерфейса). По умолчанию выключены.
  // Токен хранится хешем; пустой токен — доступ только из рабочей сети.
  metricsEnabled: false,
  metricsToken: null,
  // Принимать только подпись v2 (метод, путь, отправитель, время). По
  // умолчанию выключено: узлы прежних версий шлют только подпись тела.
  strictSignatures: false,
  // Через сколько мс простоя удалять TAP-адаптеры проброса сетевых карт (0 — не
  // удалять, держать для повторного занятия). Новый адаптер — секунды, а в
  // первый раз и минута, поэтому сразу после освобождения не удаляем.
  tapIdleMs: 120000,
  // Имена сетевых карт, которые не используются для поиска узлов (автовыбор сетей).
  // Такую карту можно пробросить: приложение в её сети не работает.
  discoveryExclude: [],
  // Самообновление по сети: 'auto' | 'ask' | 'off'. null — по умолчанию:
  // у установленного приложения auto, у переносимого комплекта ask.
  updateMode: null,
  updateSlots: 2,            // сколько соседей одновременно качают с этого узла
  updateCanaryMinutes: 10,   // сколько первый обновившийся узел работает до остальных
  updateGraceSec: 60,        // сколько показывать «перезапуск через N с», прежде чем обновиться самому (0 — сразу)
  updateWaveStepSec: 30,     // пауза между перезапусками очереди узлов
  trafficPort: 47813,        // TCP: порт счётчика трафика
  // TCP: канал кадров отданной сетевой карты. Один порт на все занятия —
  // держатель различается по пропуску, выданному при занятии.
  netLinkPort: 47814,
  // TAP-адаптеры, созданные приложением: [{ guid, role, last, switchId?,
  // category? }]. Роли: server — мост отданной карты, client — чужая карта
  // у нас, vnic — виртуальный адаптер коммутатора, uplink — выход
  // коммутатора в сеть карты. Чужие (например, OpenVPN) не трогаются —
  // отличить их можно только так.
  tapAdapters: [],
  // Отданная сейчас карта: { nic, tap, shared, bridge }. Если приложение
  // упало, не вернув её, при следующем запуске мост разбирается по этой
  // записи, а адаптеру моста возвращаются прежние настройки IP.
  netLent: null,
  // Коммутаторы (core/netManager.js): [{ id, name, nics: [{ guid, name }],
  // uplink, hostAccess, bridgeBefore }]. Виртуальные адаптеры лежат в
  // tapAdapters с ролью vnic и полем switchId.
  netSwitches: [],
  // Настройки забронированных карт, которые держатель поменял под себя:
  // deviceId → { guid, name, ip } — прежние, их вернут при освобождении.
  netRestore: {},
  multicastAddress: '239.255.77.66',
  // Темп анонсов. Быстрый действует, пока состояние меняется; в покое
  // интервал удваивается до медленного, и широковещательный трафик падает
  // на порядок. Выключение возвращает прежнее поведение — ровный темп.
  announceIntervalMs: 3000,
  announceIdleIntervalMs: 30000,
  announceBackoff: true,
  // both | multicast | broadcast. По умолчанию оба канала: где-то режут
  // multicast, где-то broadcast. Когда точно известно, что работает,
  // лишний канал — это ровно вдвое больше пакетов на пустом месте.
  announceTransport: 'both',
  peerTimeoutMs: 12000,      // 4 пропущенных анонса → узел офлайн
  peerForgetMs: 120000,
  // Узлы из других сетей: «10.1.0.5» или «10.1.0.5:47812». UDP туда не
  // доходит, поэтому знакомство идёт обменом каталогом по HTTP. Требует
  // общего ключа — см. cluster/directory.js.
  seeds: [],
  gossipIntervalMs: 20000,   // как часто обмениваться каталогом
  // Как часто спрашивать узлы из других сетей об их состоянии. Анонсов по
  // UDP от них не слышно, поэтому иначе их список устройств и занятость
  // обновлялись бы только вместе с каталогом. Опрос идёт к владельцу
  // напрямую и стоит один хеш — полный список едет, только если он изменился.
  remotePollIntervalMs: 15000,
  claimLeaseMs: 30000,       // аренда занятости; продлевается heartbeat-ом
  heartbeatIntervalMs: 10000,
  // Круги доверия. Каждая запись — [{ id, label, key }]: своё название и свой
  // общий ключ. Узел состоит сразу во всех перечисленных.
  networks: [],
  // Открытый круг — узлы без ключа. Две половины участия независимы:
  // видеть их и быть видимым для них. См. net/realms.js.
  seeOpen: true,
  showToOpen: true,
  backend: 'auto',           // auto | windows | linux | mock
  autoShareNew: false,       // автоматически шарить вновь подключённые устройства
  // Доставить недостающее при запуске: USB/IP без своих драйверов не
  // работает вовсе, и ждать, пока человек найдёт кнопку, незачем.
  // Требует прав администратора; без них будет запрос UAC.
  autoInstall: true,
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
    this.runtimeOverrides = {};
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      // Блокнот и PowerShell дописывают BOM, а JSON.parse на нём падает.
      const parsed = JSON.parse(raw.replace(/^﻿/, ''));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SyntaxError('в корне файла не объект настроек');
      }
      Object.assign(this.data, parsed);
      log.debug('конфигурация загружена из', this.file);
    } catch (e) {
      if (e.code !== 'ENOENT') this._keepUnreadable(e);
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

    // Перенос со второй версии, где круг доверия был ровно один.
    //
    // Поведение обеих прежних настроек сохраняется в точности. Ключ был задан
    // — значит, узлы без ключа и раньше были не видны и не видели нас, и обе
    // половины открытого круга выключаются. Ключа не было — узел жил именно в
    // открытом круге, и обе остаются включёнными (как в значениях по
    // умолчанию). Молча поменять это при обновлении нельзя: в первом случае
    // узел стал бы виден посторонним, во втором — исчез бы из сети целиком.
    if (typeof this.data.preSharedKey === 'string') {
      const key = this.data.preSharedKey.trim();
      if (key) {
        if (!Array.isArray(this.data.networks)) this.data.networks = [];
        if (!this.data.networks.some((n) => n?.key === key)) {
          this.data.networks.unshift({ id: crypto.randomUUID(), label: 'Основная сеть', key });
        }
        this.data.seeOpen = false;
        this.data.showToOpen = false;
      }
      delete this.data.preSharedKey;
      dirty = true;
    }
    if (!Array.isArray(this.data.networks)) {
      this.data.networks = [];
      dirty = true;
    }

    if (dirty) this.save();
  }

  /**
   * Дальше load() заведёт умолчания и новый nodeId, а save() перезапишет
   * файл — вместе с ним пропали бы сети с ключами и пароль. Поэтому
   * нечитаемый файл сначала уходит в копию рядом.
   */
  _keepUnreadable(cause) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const copy = `${this.file}.bad-${stamp}`;
    try {
      fs.copyFileSync(this.file, copy);
      log.error(`config.json нечитаем (${cause.message}); копия сохранена: ${copy}. Работаем с настройками по умолчанию — восстановите нужное из копии`);
    } catch (e) {
      log.error(`config.json нечитаем (${cause.message}), и копию сохранить не удалось: ${e.message}. Исходный файл будет перезаписан`);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });

      // Ключи, действующие только на текущий запуск, в файл не попадают.
      //
      // Не записать их при разборе аргументов мало: они лежат в data, и любое
      // последующее сохранение настроек унесло бы их в файл — то есть один
      // запуск с «--backend mock» всё равно закреплял бы имитацию навсегда,
      // стоило потом нажать «Сохранить». Отсекаем в одном месте, здесь.
      const data = { ...this.data };
      for (const k of Object.keys(this.runtimeOverrides || {})) delete data[k];

      // Пишем через временный файл: при сбое старая конфигурация уцелеет.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      try {
        fs.renameSync(tmp, this.file);
      } catch (e) {
        if (process.platform === 'win32' && e.code === 'EPERM') {
          fs.copyFileSync(tmp, this.file);
          fs.unlinkSync(tmp);
        } else {
          throw e;
        }
      }
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
    // Новый пароль обрывает прежние сессии: их подпись держится на sessionSecret.
    this.set({ webPassword: { salt, hash }, sessionSecret: crypto.randomBytes(32).toString('hex') });
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

  // ------------------------------------------------------------ токен метрик

  /**
   * Токен доступа к /metrics. Хранится как хеш: открытым нигде не лежит и из
   * настроек не читается — узнать его можно только в момент создания.
   * Токен случайный и длинный, поэтому хватает SHA-256 с солью (scrypt нужен для
   * паролей, которые придумывает человек).
   */
  setMetricsToken(token) {
    if (!token) {
      this.set({ metricsToken: null });
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(salt + String(token)).digest('hex');
    this.set({ metricsToken: { salt, hash } });
  }

  hasMetricsToken() {
    return Boolean(this.runtimeMetricsToken || (this.data.metricsToken && this.data.metricsToken.hash));
  }

  checkMetricsToken(presented) {
    if (!presented) return false;
    const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
    // Токен из --metrics-token действует только на этот запуск и в файл не пишется.
    if (this.runtimeMetricsToken) {
      const a = crypto.createHash('sha256').update(String(presented)).digest();
      const b = crypto.createHash('sha256').update(String(this.runtimeMetricsToken)).digest();
      if (same(a, b)) return true;
    }
    const stored = this.data.metricsToken;
    if (!stored || !stored.salt || !stored.hash) return false;
    const actual = crypto.createHash('sha256').update(stored.salt + String(presented)).digest();
    return same(actual, Buffer.from(stored.hash, 'hex'));
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
// «--key» тоже действует только на запуск: это отладочный и испытательный
// ключ, а постоянные круги доверия задаются в настройках списком.
const RUNTIME_ONLY = new Set(['backend', 'preSharedKey']);

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
