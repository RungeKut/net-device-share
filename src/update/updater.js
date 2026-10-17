// Самообновление по сети.
//
// Как это складывается (подробности и причины решений — docs/UPDATE.md):
//   1. Узел замечает у соседа версию новее своей и просит у него подписанный
//      манифест. Подпись, канал, совместимость и «не плохая ли версия» —
//      проверяются до единого байта скачивания.
//   2. Скачивание — с одного из узлов, уже имеющих эту версию, в порядке,
//      разном для каждого узла; источник держит мало слотов и отвечает
//      «занято, повторите» — так нагрузка расходится по цепочке: скачавший сам
//      становится источником.
//   3. Архив проверяется целиком (размер, сумма, состав, суммы файлов) и
//      раскладывается рядом с текущей версией. Ничего не запускается.
//   4. Перезапуск — когда безопасно (policy.js) и подошла очередь. Узел пишет
//      в состояние «пробная версия» и выходит с кодом 75; лаунчер запускает
//      новую версию и откатывает её, если она не подтвердит работоспособность.
//
// Всё доверие — на подписи релиза. Адрес соседа, общий ключ круга, то, что
// сосед «наш», ничего не доказывает.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { lib } from './lib.js';
import { Seeder } from './seeder.js';
import { safeToRestart, waveSchedule, orderSources } from './policy.js';
import { baseDir, isSupervised } from '../core/paths.js';
import { configDir } from '../config.js';
import { rpc, AUTH_HEADER, NODE_HEADER } from '../net/rpc.js';
import { sign } from '../net/protocol.js';
import { logger } from '../log.js';

const log = logger('update');

// Темп можно ускорить переменными окружения — для проверок на одной машине.
const TICK_MS = Number(process.env.NDS_UPDATE_TICK_MS) || 30000;
const FIRST_TICK_MS = Math.min(10000, TICK_MS);
const HEALTHY_AFTER_MS = Number(process.env.NDS_UPDATE_HEALTHY_MS) || 45000;
/** Столько узел из другой сети не считается источником, пока есть шанс найти его в своей подсети. */
const CROSS_NETWORK_DELAY_MS = 10 * 60 * 1000;
const REJECT_PAUSE_MS = 60 * 60 * 1000;
const MAX_DOWNLOAD_MS = 5 * 60 * 1000;

/** Число из настройки; 0 — допустимое значение, поэтому «|| по умолчанию» здесь не годится. */
const num = (v, def) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? def : Number(v));

export class Updater extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.base = baseDir();
    this.home = process.env.NDS_HOME || configDir();
    this.keys = lib ? lib.keys.trustedKeys() : [];
    this.seeder = lib ? new Seeder({ base: this.base, keys: this.keys, slots: num(app.config.get('updateSlots'), 2) || 1 }) : null;

    this.phase = 'idle';
    this.message = '';
    this.waiting = [];
    this.candidate = null;       // { version, sha256, from }
    this.staged = null;          // { version, sha256, at }
    this.approved = null;        // версия, которую пользователь разрешил ставить (режим «спрашивать»)
    this.eligibleAt = null;
    this.retryAt = null;
    this.lastError = null;
    this.checkedAt = null;
    this.busy = false;
    this.faults = 0;
    this.trial = false;
    this.rejected = new Map();   // "версия|sha8" → { reason, until }
    this.sourceBackoff = new Map();
    this.firstSeen = new Map();  // версия → когда увидели у соседей
    this.timers = [];
    this.running = app.version;
  }

  // ------------------------------------------------------------ жизненный цикл

  /** Почему обновление здесь невозможно. null — возможно. */
  unsupportedReason() {
    if (!lib) return 'рядом с приложением нет каталога launcher — это обрезанная сборка';
    if (!isSupervised()) {
      return 'приложение запущено напрямую, без лаунчера (например, из исходников). Обновление работает в собранном комплекте и в установленной версии: они запускаются через start.bat';
    }
    if (!this.keys.length) return 'в сборке нет доверенных ключей подписи — проверить подлинность обновления нечем';
    try {
      fs.accessSync(this.base, fs.constants.W_OK);
    } catch {
      return 'нет права записи в каталог установки: запустите приложение с правами администратора';
    }
    return null;
  }

  start() {
    if (!lib) return;
    const reason = this.unsupportedReason();
    const st = this._state();

    if (process.env.NDS_UPDATE_TEST_KEY) log.warn('включён ТЕСТОВЫЙ ключ обновлений — в рабочей сборке так быть не должно');

    // Пробный запуск: лаунчер ждёт от нас сообщения «здоров».
    this.trial = Boolean(st.pending) && st.pending === this.running;
    if (this.trial) {
      this.phase = 'trial';
      this.message = `пробный запуск версии ${this.running}: подтверждение через ${Math.round(HEALTHY_AFTER_MS / 1000)} с`;
      log.info(this.message);
    }
    if (isSupervised() && process.send) {
      this.timers.push(setTimeout(() => this._reportHealthy(), HEALTHY_AFTER_MS));
    }

    if (reason) {
      this.phase = 'unsupported';
      this.message = reason;
      log.info(`самообновление выключено: ${reason}`);
      return;
    }
    this.timers.push(setTimeout(() => this.tick(), FIRST_TICK_MS));
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
  }

  /** Сообщить лаунчеру, что пробная версия работает. */
  _reportHealthy() {
    if (!process.send) return;
    if (this.faults > 0) {
      log.warn(`в первые секунды были необработанные исключения (${this.faults}) — работоспособность не подтверждаю, лаунчер откатит версию`);
      return;
    }
    try {
      process.send({ type: 'healthy' });
      if (this.trial) {
        this.trial = false;
        this.phase = 'idle';
        this.message = '';
        log.info(`версия ${this.running} подтверждена лаунчером`);
        this.emit('changed');
      }
    } catch (e) {
      log.debug(`не удалось сообщить лаунчеру: ${e.message}`);
    }
  }

  /** Необработанное исключение в первые секунды — признак плохой версии. */
  noteFault() {
    this.faults++;
  }

  _state() {
    return lib ? lib.layout.readState(this.home) : {};
  }

  _set(phase, message = '') {
    if (this.phase !== phase || this.message !== message) {
      this.phase = phase;
      this.message = message;
      this.emit('changed');
    }
  }

  // ----------------------------------------------------------------- выбор

  /**
   * Режим по умолчанию зависит от того, как приложение поставлено: у
   * установленного (есть installed.json от установщика) — «auto», у
   * переносимого комплекта — «ask», потому что его каталог лежит где угодно и
   * менять его без спроса не стоит. Явная настройка перекрывает всё.
   */
  _mode() {
    const m = this.app.config.get('updateMode');
    if (['auto', 'ask', 'off'].includes(m)) return m;
    return fs.existsSync(path.join(this.base, 'installed.json')) ? 'auto' : 'ask';
  }

  _isBad(st, version, sha) {
    const bad = st.bad || {};
    return Boolean(bad[lib.layout.badKey(version, '')] || (sha && bad[lib.layout.badKey(version, sha)]));
  }

  _isRejected(version, sha) {
    const r = this.rejected.get(lib.layout.badKey(version, sha));
    if (r && r.until > Date.now()) return r;
    return null;
  }

  /** Самая новая версия, которую показывают соседи и которой у нас ещё нет. */
  _pickCandidate(st) {
    const floor = [this.running, st.highestInstalled].filter(Boolean)
      .sort(lib.semver.compareVersions).at(-1);
    let best = null;
    for (const p of this.app.peers.list()) {
      if (!p.online || !p.version || !lib.semver.isVersion(p.version)) continue;
      if (lib.semver.compareVersions(p.version, floor) <= 0) continue;
      if (this._isBad(st, p.version, null)) continue;
      if (!best || lib.semver.compareVersions(p.version, best) > 0) best = p.version;
    }
    return best;
  }

  _sourcesFor(version) {
    const selfId = this.app.config.get('nodeId');
    const all = this.app.peers.list().filter((p) => p.online && p.version === version);
    const local = all.filter((p) => p.origin === 'local');
    const now = Date.now();
    if (!this.firstSeen.has(version)) this.firstSeen.set(version, now);
    // Узлы из других сетей — только когда в своей подсети источника не нашлось
    // достаточно долго: через маршрутизатор качать дороже и менее надёжно.
    const useRemote = !local.length && now - this.firstSeen.get(version) >= CROSS_NETWORK_DELAY_MS;
    const pool = local.length ? local : (useRemote ? all : []);
    const free = (p) => (this.sourceBackoff.get(p.nodeId) || 0) < now;
    const primary = orderSources(selfId, version, pool.filter(free));

    // Узел, который версию уже скачал, но ещё не перезапустился, в списке
    // версий выглядит старым — а раздавать уже может. Спрашиваем и таких: ответ
    // «нет» стоит один короткий запрос, а без них цепочка раздачи превратилась
    // бы в «все с одного узла».
    const seen = new Set(primary.map((p) => p.nodeId));
    const others = orderSources(selfId, version, this.app.peers.list()
      .filter((p) => p.online && p.origin === 'local' && !seen.has(p.nodeId) && free(p)));
    return [...primary, ...others];
  }

  // ------------------------------------------------------------------ цикл

  async tick({ force = false } = {}) {
    if (!lib || this.busy || this.phase === 'unsupported' || this.phase === 'restarting') return;
    if (this._mode() === 'off') {
      this._set('off', 'самообновление выключено в настройках');
      return;
    }
    if (this.trial) return;

    const st = this._state();
    this.checkedAt = Date.now();
    if (force) this.retryAt = null;
    if (this.retryAt && Date.now() < this.retryAt) return;

    try {
      // Уже скачано — остаётся дождаться момента.
      if (this.staged && this._stagedStillValid(st)) {
        this._evaluateRestart(st);
        return;
      }
      this.staged = null;

      const version = this._pickCandidate(st);
      if (!version) {
        this.candidate = null;
        this.eligibleAt = null;
        if (this.phase !== 'error') this._set('idle', '');
        return;
      }

      this.busy = true;
      this.candidate = { version, sha256: null, from: null };
      const got = await this._acquire(version, st);
      if (got) this._evaluateRestart(this._state());
    } catch (e) {
      this.lastError = e.message;
      log.warn(`обновление: ${e.message}`);
      this._set('error', e.message);
    } finally {
      this.busy = false;
    }
  }

  _stagedStillValid(st) {
    return this.staged && lib.semver.compareVersions(this.staged.version, this.running) > 0
      && !this._isBad(st, this.staged.version, this.staged.sha256);
  }

  /**
   * Получить версию: манифест → слот → архив → проверка → раскладка.
   * @returns {boolean} версия подготовлена
   */
  async _acquire(version, st) {
    const sources = this._sourcesFor(version);
    if (!sources.length) {
      this._set('idle', `версия ${version} есть у соседей, но источников пока нет`);
      return false;
    }

    let anyBusy = false;
    let retryAfter = 0;
    for (const src of sources) {
      const key = this.app.realms.keyFor(src.realm);
      const call = (path, opts = {}) => rpc({
        host: src.address, port: src.apiPort, path, key, nodeId: this.app.config.get('nodeId'),
        timeoutMs: 15000, ...opts,
      });

      let manifest;
      let manifestBytes;
      let sig;
      try {
        this._set('checking', `проверяю версию ${version} у «${src.name}»`);
        const d = await call('/api/v1/peer/release');
        manifestBytes = Buffer.from(String(d.manifest || ''), 'base64');
        sig = Buffer.from(String(d.sig || ''), 'base64');
        manifest = lib.release.verifyManifest(manifestBytes, sig, this.keys);
      } catch (e) {
        if (e.status === 404 || e.code === 'no_release') {
          // Раздавать этому узлу нечего — не ошибка, просто не источник.
          this.sourceBackoff.set(src.nodeId, Date.now() + 60000);
        } else {
          this._markSourceFailed(src, `манифест: ${e.message}`);
          if (e.name === 'ReleaseError') this._reject(version, null, e.message);
        }
        continue;
      }
      if (manifest.version !== version && lib.semver.compareVersions(manifest.version, version) < 0) {
        // У этого узла лежит только более старая версия (его текущая).
        this.sourceBackoff.set(src.nodeId, Date.now() + 60000);
        continue;
      }

      // Подписанный манифест — теперь можно принимать решения по его содержимому.
      const verdict = this._judge(manifest, st);
      if (verdict) {
        this._reject(manifest.version, manifest.payload.sha256, verdict);
        this._set('error', `версия ${manifest.version} не принята: ${verdict}`);
        continue;
      }
      this.candidate = { version: manifest.version, sha256: manifest.payload.sha256, from: src.name };

      let token = null;
      try {
        const r = await call('/api/v1/peer/release/reserve', {
          method: 'POST', body: { version: manifest.version, sha256: manifest.payload.sha256 },
        });
        token = r.token;
      } catch (e) {
        if (e.status === 503 || e.code === 'busy') {
          anyBusy = true;
          retryAfter = Math.max(retryAfter, Number(e.body?.retryAfterSec) || 10);
          continue;
        }
        this._markSourceFailed(src, `слот: ${e.message}`);
        continue;
      }

      try {
        this._set('downloading', `скачиваю версию ${manifest.version} у «${src.name}» (${Math.round(manifest.payload.size / 1024)} КБ)`);
        const payload = await this._download(src, key, token, manifest.payload.size);
        // Проверка и раскладка — из того же буфера, что скачали.
        const bundle = { manifestBytes, sig, payload };
        lib.layout.installRelease(this.base, bundle, this.keys);
        this.seeder?.invalidate();
        this.staged = { version: manifest.version, sha256: manifest.payload.sha256, at: Date.now() };
        log.info(`версия ${manifest.version} получена от «${src.name}» и подготовлена`);
        return true;
      } catch (e) {
        // Источник отдал мусор или оборвал передачу: не доверяем ему на время.
        this._markSourceFailed(src, `архив: ${e.message}`, 60 * 60 * 1000);
      }
    }

    if (anyBusy) {
      this.retryAt = Date.now() + retryAfter * 1000;
      this._set('queued', `источники заняты — жду очереди (повтор через ${retryAfter} с)`);
    } else if (this.phase !== 'error') {
      this._set('error', `не удалось получить версию ${version}: ${this.lastError || 'нет доступных источников'}`);
    }
    return false;
  }

  /** Решения по подписанному манифесту. null — версия подходит. */
  _judge(manifest, st) {
    if (lib.semver.compareVersions(manifest.version, this.running) <= 0) return 'не новее запущенной';
    if (st.highestInstalled && lib.semver.compareVersions(manifest.version, st.highestInstalled) <= 0) {
      return 'не новее установленной ранее (откат версии по сети запрещён)';
    }
    if (this._isBad(st, manifest.version, manifest.payload.sha256)) return 'ранее не прошла пробный запуск на этом узле';
    const rej = this._isRejected(manifest.version, manifest.payload.sha256);
    if (rej) return rej.reason;
    const compat = lib.release.compatProblem(manifest);
    if (compat) return compat;
    if (manifest.revokes?.includes?.(this.running)) {
      log.warn(`версия ${this.running} отозвана релизом ${manifest.version}`);
    }
    return null;
  }

  _reject(version, sha, reason) {
    this.rejected.set(lib.layout.badKey(version, sha), { reason, until: Date.now() + REJECT_PAUSE_MS });
    this.lastError = reason;
  }

  _markSourceFailed(src, reason, ms = 5 * 60 * 1000) {
    this.sourceBackoff.set(src.nodeId, Date.now() + ms);
    this.lastError = `«${src.name}»: ${reason}`;
    log.warn(`источник «${src.name}»: ${reason}`);
  }

  /** Скачивание архива с жёсткими пределами: размер из подписанного манифеста, время, простой. */
  _download(src, key, token, expectedSize) {
    return new Promise((resolve, reject) => {
      const selfId = this.app.config.get('nodeId');
      const req = http.request({
        host: src.address,
        port: src.apiPort,
        path: `/api/v1/peer/release/payload?token=${encodeURIComponent(token)}`,
        method: 'GET',
        headers: { [AUTH_HEADER]: sign('', key), [NODE_HEADER]: selfId },
        timeout: 30000,
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (got > expectedSize) {
            req.destroy(new Error('архив больше размера из манифеста'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          clearTimeout(limit);
          if (got !== expectedSize) reject(new Error(`получено ${got} байт из ${expectedSize}`));
          else resolve(Buffer.concat(chunks));
        });
        res.on('error', reject);
      });
      const limit = setTimeout(() => req.destroy(new Error('скачивание заняло слишком долго')), MAX_DOWNLOAD_MS);
      req.on('timeout', () => req.destroy(new Error('источник перестал отвечать')));
      req.on('error', (e) => { clearTimeout(limit); reject(e); });
      req.end();
    });
  }

  // ----------------------------------------------------------- перезапуск

  _evaluateRestart(st) {
    const v = this.staged?.version;
    if (!v) return;
    const mode = this._mode();

    if (mode === 'ask' && this.approved !== v) {
      this._set('awaiting-approval', `версия ${v} подготовлена — ждёт вашего разрешения`);
      return;
    }

    const policy = safeToRestart(this.app, { transfersActive: this.seeder?.activeCount || 0 });
    this.waiting = [...policy.reasons];

    const selfId = this.app.config.get('nodeId');
    const peers = this.app.peers.list().filter((p) => p.online && p.version);
    const sources = peers.filter((p) => p.version === v);
    const waitingPeers = peers.filter((p) => lib.semver.isVersion(p.version) && lib.semver.compareVersions(p.version, v) < 0);
    const wave = waveSchedule({
      selfId, version: v, sources, waiting: waitingPeers,
      canaryMs: num(this.app.config.get('updateCanaryMinutes'), 10) * 60000,
      stepMs: num(this.app.config.get('updateWaveStepSec'), 30) * 1000,
    });
    this.eligibleAt = wave.eligibleAt;

    if (wave.eligibleAt === null) {
      // Никто ещё не работает на новой версии: либо мы единственные, кто её
      // получил от установщика/файла, либо источник перезапущен только что.
      // Ждать «канарейку» бессмысленно, когда сами и есть первый.
      if (sources.length) {
        this.waiting.push('ждём, пока соседи проверят версию в работе');
        this._set('waiting', `версия ${v} подготовлена; ${this.waiting.join('; ')}`);
        return;
      }
    } else if (Date.now() < wave.eligibleAt) {
      const sec = Math.ceil((wave.eligibleAt - Date.now()) / 1000);
      this.waiting.push(`очередь: ${wave.rank + 1}-й, перезапуск примерно через ${sec} с`);
    }

    if (!policy.ok || (wave.eligibleAt !== null && Date.now() < wave.eligibleAt)) {
      this._set('waiting', `версия ${v} подготовлена; ${this.waiting.join('; ')}`);
      return;
    }
    this.restartInto(v);
  }

  /** Перезапуск в подготовленную версию. Условия безопасности проверяет вызывающий. */
  restartInto(version) {
    if (!this.staged || this.staged.version !== version) throw new Error('эта версия не подготовлена');
    lib.layout.updateState(this.home, (s) => {
      s.pending = version;
      s.attempts = 0;
      s.configSnapshot = false;
      return s;
    });
    this._set('restarting', `перезапуск в версию ${version}`);
    log.info(`перезапуск в версию ${version}`);
    // Отложено, чтобы ответ интерфейсу успел уйти.
    setTimeout(() => process.emit('nds:restart'), 500).unref?.();
  }

  // ---------------------------------------------------------------- действия

  approve(version) {
    if (!this.staged || (version && this.staged.version !== version)) throw new Error('нет подготовленной версии для этого разрешения');
    this.approved = this.staged.version;
    this.tick();
    return this.snapshot();
  }

  /** «Перезапустить сейчас»: пользователь решил сам, очередь и занятость не проверяем. */
  restartNow() {
    if (!this.staged) throw new Error('нет подготовленной версии');
    this.restartInto(this.staged.version);
    return this.snapshot();
  }

  /** «Повторить»: снять отказы и пойти за версией заново. */
  retry() {
    this.rejected.clear();
    this.sourceBackoff.clear();
    this.lastError = null;
    if (this.phase === 'error') this._set('idle', '');
    if (lib) {
      lib.layout.updateState(this.home, (s) => { s.bad = {}; return s; });
    }
    this.tick({ force: true });
    return this.snapshot();
  }

  checkNow() {
    this.tick({ force: true });
    return this.snapshot();
  }

  // ---------------------------------------------------------------- снимок

  snapshot() {
    const reason = lib ? this.unsupportedReason() : 'нет библиотеки обновления';
    const st = this._state();
    const held = this.seeder?.holding?.();
    return {
      supported: !reason,
      unsupportedReason: reason,
      mode: this._mode(),
      phase: this.phase,
      message: this.message,
      running: this.running,
      trial: this.trial,
      candidate: this.candidate,
      staged: this.staged ? { version: this.staged.version } : null,
      waiting: this.waiting,
      eligibleAt: this.eligibleAt,
      retryAt: this.retryAt,
      lastError: this.lastError,
      checkedAt: this.checkedAt,
      canRestartNow: Boolean(this.staged) && this.phase !== 'restarting',
      awaitingApproval: this.phase === 'awaiting-approval',
      sharing: held ? { version: held.version, active: this.seeder.activeCount } : null,
      previous: st.previous || null,
      failed: [...new Map(Object.entries(st.bad || {})
        .map(([k, v]) => [k.split('|')[0], { version: k.split('|')[0], reason: v.reason, at: v.at }])).values()],
    };
  }
}

