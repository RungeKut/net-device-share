// Сравнение версий вида X.Y.Z[-метка]. Своя реализация: пакет semver
// не нужен, а нужны ровно три вещи — разобрать, сравнить, отвергнуть мусор.

const RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,32}))?$/;

/** @returns {{major:number, minor:number, patch:number, pre:string|null}|null} */
export function parseVersion(v) {
  const m = RE.exec(String(v ?? ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

export function isVersion(v) {
  return parseVersion(v) !== null;
}

/**
 * -1, 0 или 1. Версия с меткой (2.1.0-rc1) старше такой же без метки,
 * как принято в semver. Метки сравниваются по частям: числа как числа.
 * Мусор вместо версии — исключение: молча «равно» здесь опасно, потому что
 * решение «обновляться или нет» не должно зависеть от опечатки.
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`не версия: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const px = x.pre.split('.');
  const py = y.pre.split('.');
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    if (px[i] === undefined) return -1;
    if (py[i] === undefined) return 1;
    const nx = /^\d+$/.test(px[i]);
    const ny = /^\d+$/.test(py[i]);
    if (nx && ny) {
      if (+px[i] !== +py[i]) return +px[i] < +py[i] ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (px[i] !== py[i]) {
      return px[i] < py[i] ? -1 : 1;
    }
  }
  return 0;
}

export function newerThan(a, b) {
  return compareVersions(a, b) > 0;
}
