// Библиотека обновления лежит в launcher/lib: она общая с лаунчером и
// меняется только установщиком (это корень доверия — проверка подписи не
// должна зависеть от кода, который сама же проверяет). Поэтому импортируется
// не по относительному пути, а от базы установки: из каталога версии
// app/<версия>/src/update до launcher/lib — другое число «..», чем из исходников.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launcherLibDir } from '../core/paths.js';

async function load() {
  const dir = launcherLibDir();
  const imp = (name) => import(pathToFileURL(path.join(dir, name)).href);
  try {
    const [release, layout, keys, semver] = await Promise.all([
      imp('release.js'), imp('layout.js'), imp('keys.js'), imp('semver.js'),
    ]);
    return { release, layout, keys, semver };
  } catch {
    return null;
  }
}

/** null — библиотеки нет рядом (обрезанная сборка): обновление недоступно, остальное работает. */
export const lib = await load();
