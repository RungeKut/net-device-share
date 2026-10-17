// Где что лежит.
//
// Раньше «корень» вычислялся от расположения кода. С самообновлением код
// переезжает в app/<версия>/, и от него нельзя отсчитывать то, что от версии
// не зависит: установщики драйверов, TAP, задание автозапуска. Поэтому два
// понятия:
//
//   codeDir — каталог кода запущенной версии (src, scripts, package.json);
//   baseDir — база установки: node.exe, launcher, installers, app, releases.
//
// В обычном запуске из исходников и в старом переносимом комплекте они
// совпадают. В раскладке с лаунчером baseDir — на два уровня выше codeDir.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function baseDir() {
  if (process.env.NDS_BASE) return path.resolve(process.env.NDS_BASE);
  const parent = path.dirname(codeDir);
  if (path.basename(parent) === 'app') return path.dirname(parent);
  return codeDir;
}

/** Установщики драйверов и Node.js. Версиями не владеют — лежат в базе. */
export function installersDir() {
  if (process.env.NDS_INSTALLERS_DIR) return path.resolve(process.env.NDS_INSTALLERS_DIR);
  const inBase = path.join(baseDir(), 'installers');
  return fs.existsSync(inBase) ? inBase : path.join(codeDir, 'installers');
}

/** Библиотека лаунчера: общая для лаунчера и приложения, меняется только установщиком. */
export function launcherLibDir() {
  const inBase = path.join(baseDir(), 'launcher', 'lib');
  return fs.existsSync(inBase) ? inBase : path.join(codeDir, 'launcher', 'lib');
}

/** Запущено ли под лаунчером (он умеет перезапускать, откатывать и переключать версии). */
export function isSupervised() {
  return process.env.NDS_SUPERVISED === '1';
}

/** Версия из package.json — единственный источник; рассинхрон с константой невозможен. */
export function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(codeDir, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}
