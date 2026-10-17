// Раздача своей версии соседям.
//
// Узел отдаёт архив любой версии, которая у него лежит в releases/ целой и
// с верной подписью: и свою текущую, и скачанную, но ещё не запущенную.
// Благодаря этому раздача идёт цепочкой — получивший версию сам становится
// источником — и не упирается в один узел.
//
// Ограничения защищают источник: слотов мало, на один адрес — один, остальным
// штатный ответ «занято, повторите позже». Бросать запрос в очередь на
// стороне источника не нужно: повтор со случайной паузой даёт то же самое без
// хранения состояния.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lib } from './lib.js';

const RESERVATION_TTL_MS = 2 * 60 * 1000;

export class Seeder {
  /**
   * @param {object} o
   * @param {string} o.base       база установки
   * @param {Array}  o.keys       доверенные ключи
   * @param {number} [o.slots]    одновременных скачиваний
   */
  constructor({ base, keys, slots = 2, isBad = null }) {
    /** (версия) → true: соседи сообщили, что версия испорчена, — её не раздаём. */
    this.isBad = isBad;
    this.base = base;
    this.keys = keys;
    this.slots = slots;
    /** token → { callerId, ip, version, sha256, expires, active } */
    this.reservations = new Map();
    this.cache = null;    // { version, manifestBytes, sig, manifest, payload }
    this.scannedAt = 0;
  }

  /** Сбросить кэш: после скачивания новой версии. */
  invalidate() {
    this.cache = null;
    this.scannedAt = 0;
  }

  /** Лучшая из лежащих у нас целых версий. null — делиться нечем. */
  holding() {
    if (!lib) return null;
    const now = Date.now();
    if (this.cache && now - this.scannedAt < 30000) return this.cache;
    this.scannedAt = now;

    let best = null;
    let names = [];
    try {
      names = fs.readdirSync(path.join(this.base, 'releases'));
    } catch {
      this.cache = null;
      return null;
    }
    for (const n of names) {
      if (!lib.semver.isVersion(n)) continue;
      if (this.isBad?.(n)) continue;
      if (best && lib.semver.compareVersions(n, best) <= 0) continue;
      best = n;
    }
    // Проверка подписи и суммы — один раз на версию, а не на каждый запрос.
    while (best) {
      if (this.cache?.version === best) return this.cache;
      try {
        const stored = lib.layout.readStoredRelease(this.base, best);
        const manifest = lib.release.verifyManifest(stored.manifestBytes, stored.sig, this.keys);
        if (lib.release.sha256(stored.payload) !== manifest.payload.sha256) throw new Error('сумма архива не сходится');
        this.cache = { version: best, ...stored, manifest };
        return this.cache;
      } catch {
        // Эта версия повреждена — делиться ею нельзя; пробуем следующую по убыванию.
        const rest = names.filter((x) => lib.semver.isVersion(x) && lib.semver.compareVersions(x, best) < 0)
          .sort(lib.semver.compareVersions);
        best = rest.at(-1) || null;
      }
    }
    this.cache = null;
    return null;
  }

  /** Тело ответа на GET /peer/release. */
  describe() {
    const h = this.holding();
    if (!h) return null;
    return {
      version: h.version,
      keyId: h.manifest.keyId,
      sha256: h.manifest.payload.sha256,
      size: h.manifest.payload.size,
      manifest: h.manifestBytes.toString('base64'),
      sig: h.sig.toString('base64'),
      slotsFree: Math.max(0, this.slots - this._used()),
    };
  }

  _gc() {
    const now = Date.now();
    for (const [t, r] of this.reservations) {
      if (!r.active && r.expires < now) this.reservations.delete(t);
    }
  }

  _used() {
    this._gc();
    return this.reservations.size;
  }

  get activeCount() {
    return [...this.reservations.values()].filter((r) => r.active).length;
  }

  /**
   * Занять слот под скачивание.
   * @returns {{granted: true, token: string, ttlSec: number}
   *   | {busy: true, retryAfterSec: number}
   *   | {error: 'no_release'|'other_build'}}
   */
  reserve({ callerId, ip, version, sha256 }) {
    const h = this.holding();
    if (!h) return { error: 'no_release' };
    if (h.version !== version || h.manifest.payload.sha256 !== sha256) return { error: 'other_build' };

    this._gc();
    // Повторный запрос от того же узла возвращает его же слот: так повтор
    // после обрыва не занимает второй.
    for (const [token, r] of this.reservations) {
      if (r.callerId === callerId && r.version === version && !r.active) {
        r.expires = Date.now() + RESERVATION_TTL_MS;
        return { granted: true, token, ttlSec: RESERVATION_TTL_MS / 1000 };
      }
    }
    const sameIp = [...this.reservations.values()].some((r) => r.ip === ip);
    if (this.reservations.size >= this.slots || sameIp) {
      // Случайная добавка разносит повторы: иначе очередь из десятка узлов
      // пришла бы за слотом одновременно в одну и ту же секунду.
      return { busy: true, retryAfterSec: 5 + Math.floor(Math.random() * 10) };
    }
    const token = crypto.randomBytes(16).toString('hex');
    this.reservations.set(token, { callerId, ip, version, sha256, expires: Date.now() + RESERVATION_TTL_MS, active: false });
    return { granted: true, token, ttlSec: RESERVATION_TTL_MS / 1000 };
  }

  /**
   * Начало передачи. Токен привязан к узлу и адресу: перехваченный токен
   * с другого адреса бесполезен.
   * @returns {{payload: Buffer, sha256: string, done: () => void}|{error: string}}
   */
  begin({ token, callerId, ip }) {
    this._gc();
    const r = this.reservations.get(token);
    if (!r || r.callerId !== callerId || r.ip !== ip) return { error: 'forbidden' };
    const h = this.holding();
    if (!h || h.version !== r.version) return { error: 'gone' };
    r.active = true;
    const done = () => this.reservations.delete(token);
    return { payload: h.payload, sha256: h.manifest.payload.sha256, done };
  }
}
