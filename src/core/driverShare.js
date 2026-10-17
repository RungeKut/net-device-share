// Копирование драйвера устройства с компьютера владельца.
//
// Зачем: проброшенное по USB/IP устройство появляется у занявшего как
// настоящее, и ему нужен тот же драйвер, что и у владельца. Если драйвера
// нет, устройство видно в «Диспетчере устройств» с жёлтым значком и ничего
// не делает. Кнопка «Копировать драйвер» берёт пакет у владельца и ставит
// его у занявшего.
//
// Как это устроено (только Windows, и у владельца, и у занявшего):
//   владелец — находит сторонние пакеты драйверов, подходящие устройству
//              (по тому, что уже привязано к устройству, и по VID:PID в INF
//              из C:\Windows\INF), выгружает их `pnputil /export-driver` и
//              отдаёт занявшему файлы;
//   занявший — сохраняет файлы во временную папку, проверяет подпись
//              каталога (.cat) и после подтверждения пользователя ставит
//              `pnputil /add-driver <inf> /install`.
//
// Ограничения, которые нельзя обойти и которые надо объяснять словами:
//   — встроенные драйверы Windows не лежат в хранилище как oem*.inf;
//   — драйвер, поставленный установщиком (службы, библиотеки, программа),
//     этим путём переносится не целиком;
//   — неподписанный драйвер 64-битная Windows, скорее всего, не примет.
// Драйвер — это код в ядре, который приходит по сети, поэтому ставится он
// только по явному подтверждению пользователя с показом подписи.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, psQuote } from '../devices/backend.js';
import { isElevated } from './installer.js';
import { parseDeviceId } from '../devices/types.js';
import { logger } from '../log.js';

const log = logger('driver');

/** Сколько всего байт драйверов готовы принять от узла. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGES = 5;
/** Подготовленные, но не установленные пакеты живут столько. */
const SESSION_TTL_MS = 15 * 60 * 1000;

const OEM_INF = /^oem\d+\.inf$/i;

/** Ошибка с кодом и развёрнутым текстом для пользователя. */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export class DriverShare {
  constructor() {
    /** @type {Map<string, {dir: string, packages: object[], createdAt: number}>} */
    this.sessions = new Map();
    this.elevated = false;
  }

  async init() {
    if (process.platform !== 'win32') return;
    this.elevated = await isElevated().catch(() => false);
  }

  // ------------------------------------------------ что сказать в интерфейсе

  /**
   * Причина, по которой кнопку «Копировать драйвер» показывать не нужно, —
   * развёрнуто, человеческим языком. null — кнопка уместна.
   *
   * Здесь только то, что известно заранее и без обращения к владельцу.
   * Остальное (например, «у этого устройства нет стороннего драйвера»)
   * выясняется при нажатии и показывается в окне.
   *
   * @param {object} o
   * @param {object} o.rec   запись занятия
   * @param {object} o.part  устройство занятия
   * @param {string} o.selfId
   * @param {string|null} o.ownerPlatform  платформа владельца, если известна
   */
  blockReason({ rec, part, selfId, ownerPlatform }) {
    if (parseDeviceId(part.deviceId).type !== 'usb') {
      return 'Копировать драйвер можно только для USB-устройств. COM- и LPT-порты '
        + 'здесь только бронируются, а сетевой интерфейс становится адаптером, '
        + 'для которого отдельный драйвер не нужен.';
    }
    if (rec.orphan || !rec.nodeId) {
      return 'Это подключение сделано вне приложения (вручную через usbip), и '
        + 'приложение не знает, у какого компьютера просить драйвер.';
    }
    if (rec.nodeId === selfId) {
      return 'Устройство физически подключено к этому же компьютеру, '
        + 'поэтому драйвер у вас уже есть — копировать его не откуда.';
    }
    if (process.platform !== 'win32') {
      return 'Копирование драйверов работает только на Windows, а на этом компьютере '
        + 'другая система. В Linux драйвер USB-устройства — это модуль ядра '
        + 'и он, как правило, уже входит в систему, а переносить модули между '
        + 'машинами нельзя: они привязаны к версии ядра.';
    }
    if (ownerPlatform && ownerPlatform !== 'win32') {
      return 'Владелец устройства работает не на Windows, а у такой системы нет '
        + 'пакета драйвера в формате Windows (INF и каталог подписи), который '
        + 'можно было бы передать и установить здесь.';
    }
    if (!this.elevated) {
      return 'Установка драйвера требует прав администратора, а приложение запущено без них. '
        + 'Закройте его и запустите через start.bat, подтвердив запрос Windows '
        + '(не добавляйте параметр -noadmin) — после этого кнопка появится.';
    }
    return null;
  }

  // ------------------------------------------------ сторона владельца

  /**
   * Собрать драйвер для устройства и отдать файлами.
   *
   * @param {object} dev устройство владельца (с vendorId и productId)
   * @returns {{packages: Array<{inf: string, name: string, provider: string|null,
   *   version: string|null, how: string, files: Array<{path: string, size: number, b64: string}>}>}}
   */
  async exportFor(dev) {
    if (process.platform !== 'win32') {
      throw fail('driver_unsupported', 'Владелец работает не на Windows: пакетов драйверов в формате Windows у него нет.');
    }
    if (parseDeviceId(dev.deviceId).type !== 'usb') {
      throw fail('driver_unsupported', 'Драйвер можно скопировать только для USB-устройства.');
    }
    if (!dev.vendorId || !dev.productId) {
      throw fail('driver_unavailable',
        'У владельца не определён код устройства (VID:PID), поэтому драйвер подобрать не удалось.');
    }
    if (!(await isElevated().catch(() => false))) {
      throw fail('driver_unavailable',
        'У владельца приложение запущено без прав администратора, а выгрузка драйвера из системы '
        + 'без них невозможна. Владельцу нужно перезапустить приложение через start.bat '
        + 'с подтверждением запроса Windows.');
    }

    const candidates = await this._findInfs(dev.vendorId, dev.productId);
    if (!candidates.length) {
      throw fail('driver_unavailable',
        `Для устройства ${dev.vendorId}:${dev.productId} у владельца нет стороннего драйвера, который можно перенести. `
        + 'Скорее всего, оно работает на встроенном драйвере Windows (такие драйверы лежат в системе '
        + 'иначе и в виде отдельного пакета не выгружаются — но и ставить их не нужно, '
        + 'Windows подберёт их сама), либо драйвер поставлен установщиком производителя '
        + 'и не зарегистрирован как пакет по этому коду устройства. В этом случае '
        + 'возьмите установщик у производителя устройства.');
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-drvout-'));
    try {
      const packages = [];
      let total = 0;
      for (const c of candidates.slice(0, MAX_PACKAGES)) {
        const out = path.join(work, c.inf.replace(/\W/g, '_'));
        fs.mkdirSync(out, { recursive: true });
        const r = await run('pnputil.exe', ['/export-driver', c.inf, out], { timeoutMs: 120000 });
        if (!r.ok) {
          log.warn(`не удалось выгрузить ${c.inf}: ${(r.stdout || r.stderr).trim()}`);
          continue;
        }
        const files = [];
        for (const f of walk(out)) {
          const size = fs.statSync(f).size;
          total += size;
          if (total > MAX_TOTAL_BYTES) {
            throw fail('driver_unavailable',
              `Пакет драйвера у владельца больше ${Math.round(MAX_TOTAL_BYTES / 1048576)} МБ — по сети его не передать. `
              + 'Возьмите установщик драйвера у производителя устройства.');
          }
          files.push({
            path: path.relative(out, f).split(path.sep).join('/'),
            size,
            b64: fs.readFileSync(f).toString('base64'),
          });
        }
        if (files.length) {
          packages.push({
            inf: c.inf,
            name: c.name || null,
            provider: c.provider || null,
            version: c.version || null,
            how: c.how,
            files,
          });
        }
      }
      if (!packages.length) {
        throw fail('driver_unavailable',
          'Подходящие пакеты драйвера найдены, но Windows у владельца не смогла их выгрузить '
          + '(pnputil /export-driver завершился с ошибкой). Подробности — в журнале владельца.');
      }
      log.info(`драйвер для ${dev.vendorId}:${dev.productId}: ${packages.map((p) => p.inf).join(', ')}, ${Math.round(total / 1024)} КБ`);
      return { packages };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * Сторонние пакеты, подходящие устройству. Два источника, потому что у
   * каждого своя слепая зона:
   *   — драйвер, уже привязанный к устройству (точно, но пока устройство
   *     отдано в раздачу, к нему может быть привязана заглушка usbipd);
   *   — просмотр INF в хранилище по VID:PID (не зависит от состояния
   *     устройства, но не видит драйверы, подбираемые только по классу).
   */
  async _findInfs(vendorId, productId) {
    const vid = String(vendorId).toUpperCase();
    const pid = String(productId).toUpperCase();
    const found = new Map();

    const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
      + `$p = Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceID -like ${psQuote(`USB\\VID_${vid}&PID_${pid}*`)} } `
      + '| Select-Object InfName, DriverProviderName, DriverVersion, DeviceName; '
      + 'if ($p) { ConvertTo-Json -InputObject @($p) -Compress } else { "[]" }';
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30000 });
    if (r.ok) {
      try {
        for (const d of JSON.parse(r.stdout.trim() || '[]')) {
          const inf = String(d.InfName || '').toLowerCase();
          if (!OEM_INF.test(inf) || isStub(d.DriverProviderName)) continue;
          found.set(inf, {
            inf,
            name: d.DeviceName || null,
            provider: d.DriverProviderName || null,
            version: d.DriverVersion || null,
            how: 'привязан к устройству',
          });
        }
      } catch (e) {
        log.debug(`не разобрал список драйверов: ${e.message}`);
      }
    }

    const infDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'INF');
    const needle = `vid_${vid}&pid_${pid}`.toLowerCase();
    let names = [];
    try { names = fs.readdirSync(infDir).filter((n) => OEM_INF.test(n)); } catch { /* нет доступа */ }
    for (const n of names) {
      const inf = n.toLowerCase();
      if (found.has(inf)) continue;
      let text;
      try { text = decodeInf(fs.readFileSync(path.join(infDir, n))); } catch { continue; }
      if (!text.toLowerCase().includes(needle)) continue;
      const meta = parseInf(text);
      if (isStub(meta.provider)) continue;
      found.set(inf, { inf, name: meta.class, provider: meta.provider, version: meta.version, how: 'найден в хранилище по коду устройства' });
    }
    return [...found.values()];
  }

  // ------------------------------------------------ сторона занявшего

  /**
   * Принять пакеты от владельца, разобрать и проверить подпись.
   * Ничего не устанавливает: результат показывается пользователю.
   */
  async prepare(received) {
    this._gc();
    if (process.platform !== 'win32') {
      throw fail('driver_unsupported', 'Установка драйверов работает только на Windows.');
    }
    const list = Array.isArray(received?.packages) ? received.packages : [];
    if (!list.length) throw fail('driver_unavailable', 'Владелец не прислал ни одного пакета драйвера.');

    const token = crypto.randomBytes(12).toString('hex');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-drv-'));
    const packages = [];
    let total = 0;

    try {
      for (const [i, p] of list.slice(0, MAX_PACKAGES).entries()) {
        const dir = path.join(root, String(i));
        fs.mkdirSync(dir, { recursive: true });
        let infFile = null;
        const cats = [];

        for (const f of p.files || []) {
          const rel = safeRelative(f.path);
          if (!rel) throw fail('driver_rejected', `Владелец прислал файл с недопустимым путём «${String(f.path).slice(0, 80)}» — пакет отклонён.`);
          const data = Buffer.from(String(f.b64 || ''), 'base64');
          total += data.length;
          if (total > MAX_TOTAL_BYTES) throw fail('driver_rejected', 'Пакет драйвера слишком велик — отклонён.');
          const target = path.join(dir, rel);
          if (!target.startsWith(dir + path.sep)) throw fail('driver_rejected', 'Файл выходит за пределы папки пакета — пакет отклонён.');
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, data);
          const low = rel.toLowerCase();
          if (low.endsWith('.inf') && !low.includes('/')) infFile = infFile || target;
          if (low.endsWith('.cat')) cats.push(target);
        }
        if (!infFile) throw fail('driver_rejected', `В пакете «${p.inf}» нет INF-файла — ставить нечего.`);

        const meta = parseInf(decodeInf(fs.readFileSync(infFile)));
        const sig = await this._signature(cats);
        packages.push({
          inf: path.relative(root, infFile),
          infName: path.basename(infFile),
          name: meta.class || p.name || p.inf,
          provider: meta.provider || p.provider || null,
          version: meta.version || p.version || null,
          fileCount: (p.files || []).length,
          size: (p.files || []).reduce((s, f) => s + (f.size || 0), 0),
          signature: sig.state,           // valid | invalid | none
          signer: sig.signer,
          signatureNote: sig.note,
        });
      }
    } catch (e) {
      fs.rmSync(root, { recursive: true, force: true });
      throw e;
    }

    this.sessions.set(token, { dir: root, packages, createdAt: Date.now() });
    return { token, packages };
  }

  /** Установить подготовленные пакеты. Вызывается только после подтверждения. */
  async install(token) {
    this._gc();
    if (!this.elevated && !(await isElevated().catch(() => false))) {
      throw fail('driver_unavailable',
        'Установка драйвера требует прав администратора, а приложение запущено без них. '
        + 'Перезапустите его через start.bat с подтверждением запроса Windows.');
    }
    const s = this.sessions.get(token);
    if (!s) throw fail('not_found', 'Пакет драйвера не найден или устарел (хранится 15 минут) — скопируйте его заново.');

    const results = [];
    for (const p of s.packages) {
      const inf = path.join(s.dir, p.inf);
      const r = await run('pnputil.exe', ['/add-driver', inf, '/install'], { timeoutMs: 180000 });
      const out = (r.stdout || r.stderr || '').trim();
      results.push({ infName: p.infName, ok: r.ok, output: out });
      log.info(`pnputil /add-driver ${p.infName}: ${r.ok ? 'установлен' : 'не удалось'} — ${out.split(/\r?\n/).slice(-2).join(' | ')}`);
    }
    this.cancel(token);
    return { results, ok: results.every((r) => r.ok) };
  }

  cancel(token) {
    const s = this.sessions.get(token);
    if (!s) return;
    fs.rmSync(s.dir, { recursive: true, force: true });
    this.sessions.delete(token);
  }

  stop() {
    for (const token of [...this.sessions.keys()]) this.cancel(token);
  }

  _gc() {
    const now = Date.now();
    for (const [token, s] of this.sessions) {
      if (now - s.createdAt > SESSION_TTL_MS) this.cancel(token);
    }
  }

  /** Подпись каталогов пакета: valid — все в порядке, invalid — есть сбой, none — каталога нет. */
  async _signature(cats) {
    if (!cats.length) {
      return { state: 'none', signer: null, note: 'В пакете нет каталога подписи (.cat): драйвер не подписан.' };
    }
    const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
      + `$r = @(${cats.map((c) => psQuote(c)).join(',')}) | ForEach-Object { `
      + '$s = Get-AuthenticodeSignature -LiteralPath $_; '
      + '[pscustomobject]@{ status = $s.Status.ToString(); signer = $s.SignerCertificate.Subject } }; '
      + 'ConvertTo-Json -InputObject @($r) -Compress';
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 60000 });
    let items = [];
    if (r.ok) {
      try { items = JSON.parse(r.stdout.trim()); } catch { /* ниже */ }
    }
    if (!items.length) {
      return { state: 'invalid', signer: null, note: 'Не удалось проверить подпись каталога.' };
    }
    const bad = items.find((i) => i.status !== 'Valid');
    const signer = shortSigner(items[0].signer);
    if (bad) {
      return { state: 'invalid', signer, note: `Подпись каталога не прошла проверку (${bad.status}).` };
    }
    return { state: 'valid', signer, note: null };
  }
}

// ---------------------------------------------------------------- утилиты

function isStub(provider) {
  return /usbip|vboxusb|oracle/i.test(String(provider || ''));
}

/** Все файлы папки, рекурсивно. */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * Относительный путь из чужого пакета. Приходит по сети, поэтому ничего,
 * что выводит за пределы папки: абсолютные пути, диски, «..».
 */
function safeRelative(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.includes('\0')) return null;
  const parts = s.split('/');
  if (parts.some((x) => x === '..' || x === '.' || x === '')) return null;
  return parts.join(path.sep);
}

/** INF бывают в UTF-16 и в ANSI. */
function decodeInf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('latin1');
}

/** Provider, DriverVer, Class из секций [Version] и [Strings]. */
export function parseInf(text) {
  const sections = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { cur = m[1].toLowerCase(); if (!sections.has(cur)) sections.set(cur, new Map()); continue; }
    if (!cur) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    sections.get(cur).set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  const strings = sections.get('strings') || new Map();
  const unquote = (s) => String(s || '').replace(/^"(.*)"$/, '$1');
  const resolve = (v) => unquote(String(v || '').replace(/%([^%]+)%/g, (_, k) => unquote(strings.get(k.toLowerCase()) ?? `%${k}%`)));
  const ver = sections.get('version') || new Map();
  const verRaw = ver.get('driverver') || '';
  const [date, number] = verRaw.split(',').map((x) => x.trim());
  return {
    provider: resolve(ver.get('provider')) || null,
    class: resolve(ver.get('class')) || null,
    version: number ? `${number}${date ? ` (${date})` : ''}` : (date || null),
  };
}

function shortSigner(subject) {
  if (!subject) return null;
  const cn = String(subject).match(/CN=("[^"]+"|[^,]+)/);
  return (cn ? cn[1] : String(subject)).replace(/^"|"$/g, '');
}
