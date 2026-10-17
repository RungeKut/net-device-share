// Минимальный tar (ustar) для переноса файлов версии.
//
// Почему tar, а не zip: формат стандартный (его читают tar.exe в Windows 10
// и tar в Linux — удобно проверять руками), пишется и читается полусотней
// строк без зависимостей, а сборка получается воспроизводимой — одни и те же
// файлы дают одни и те же байты и одну контрольную сумму.
//
// Читатель принимает только обычные файлы. Всё остальное (ссылки, устройства,
// расширенные заголовки) — отказ: архив приходит по сети, и «распаковать, как
// получится» тут нельзя. Пути проверяются так, как проверяет их файловая
// система Windows, а не Linux: регистр не различается, часть имён
// зарезервирована, обратная косая — разделитель.

import zlib from 'node:zlib';

const BLOCK = 512;

/** Имена, которые Windows трактует как устройства — в любом каталоге и с любым расширением. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export const LIMITS = Object.freeze({
  maxFiles: 5000,
  maxTotalBytes: 200 * 1024 * 1024,
  maxPathLength: 240,
});

/**
 * Проверка относительного пути из архива.
 * @returns {string|null} причина отказа или null, если путь годится
 */
export function pathProblem(p) {
  const s = String(p ?? '');
  if (!s) return 'пустой путь';
  if (s.length > LIMITS.maxPathLength) return 'слишком длинный путь';
  if (s.includes('\0')) return 'нулевой байт в пути';
  if (s.includes('\\')) return 'обратная косая в пути';
  if (s.startsWith('/')) return 'абсолютный путь';
  if (/^[a-zA-Z]:/.test(s)) return 'путь с буквой диска';
  for (const part of s.split('/')) {
    if (part === '' || part === '.' || part === '..') return 'недопустимый элемент пути';
    if (/[<>:"|?*\x00-\x1f]/.test(part)) return 'недопустимый символ в имени';
    if (/[. ]$/.test(part)) return 'имя заканчивается точкой или пробелом';
    if (RESERVED.test(part)) return 'зарезервированное имя Windows';
  }
  return null;
}

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header(name, size, mtime, mode) {
  const h = Buffer.alloc(BLOCK);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar: длинный путь делится на prefix (до 155) и name (до 100) по «/».
    const cut = name.lastIndexOf('/', 155);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (cut < 1 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) {
      throw new Error(`путь не помещается в tar: ${name}`);
    }
  }
  h.write(base, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');             // uid
  h.write(octal(0, 8), 116, 8, 'ascii');             // gid
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');              // место под контрольную сумму
  h.write('0', 156, 1, 'ascii');                     // обычный файл
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7).slice(0, 6) + '\0 ', 148, 8, 'ascii');
  return h;
}

/**
 * @param {Array<{path: string, data: Buffer, mode?: number}>} entries
 * @param {{mtime?: number}} [opts] метка времени для всех файлов (воспроизводимость)
 */
export function packTar(entries, { mtime = 0 } = {}) {
  const parts = [];
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const e of sorted) {
    const why = pathProblem(e.path);
    if (why) throw new Error(`${e.path}: ${why}`);
    parts.push(header(e.path, e.data.length, mtime, e.mode ?? 0o644));
    parts.push(e.data);
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function readStr(h, off, len) {
  const end = h.indexOf(0, off);
  return h.toString('utf8', off, end >= 0 && end < off + len ? end : off + len);
}

/**
 * Разбор tar с проверкой каждого файла. Любое нарушение — исключение:
 * наполовину принятый архив хуже отвергнутого.
 *
 * @returns {Array<{path: string, data: Buffer}>}
 */
export function unpackTar(buf, limits = LIMITS) {
  const out = [];
  const seen = new Set();
  let total = 0;
  let off = 0;

  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;

    // Контрольная сумма заголовка: поле считается, как если бы оно было из пробелов.
    const stored = parseInt(readStr(h, 148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 0x20 : h[i];
    if (!Number.isFinite(stored) || stored !== sum) throw new Error('tar: неверная контрольная сумма заголовка');

    const type = String.fromCharCode(h[156] || 0x30);
    const size = parseInt(readStr(h, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('tar: неверный размер');

    const name = readStr(h, 0, 100);
    const prefix = readStr(h, 345, 155);
    const full = prefix ? `${prefix}/${name}` : name;
    const body = off + BLOCK;

    if (type === '5') {                         // каталог: файлы создаются вместе с путями
      off = body;
      continue;
    }
    if (type !== '0') throw new Error(`tar: недопустимый тип записи «${type}» у ${full}`);

    const why = pathProblem(full);
    if (why) throw new Error(`tar: ${full}: ${why}`);
    const key = full.toLowerCase();
    if (seen.has(key)) throw new Error(`tar: повторяющийся путь ${full}`);
    seen.add(key);

    if (out.length >= limits.maxFiles) throw new Error('tar: слишком много файлов');
    total += size;
    if (total > limits.maxTotalBytes) throw new Error('tar: слишком большой объём');
    if (body + size > buf.length) throw new Error('tar: архив обрезан');

    out.push({ path: full, data: Buffer.from(buf.subarray(body, body + size)) });
    off = body + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

export function gzip(buf) {
  // Воспроизводимость: gzip пишет в заголовок время, но в Node оно нулевое.
  return zlib.gzipSync(buf, { level: 9 });
}

export function gunzip(buf, maxBytes = LIMITS.maxTotalBytes + 16 * 1024 * 1024) {
  // maxOutputLength защищает от «бомбы»: маленький архив, раздувающийся в гигабайты.
  return zlib.gunzipSync(buf, { maxOutputLength: maxBytes });
}
