// Версия сборки из git: база — тег vX.Y, патч — число коммитов после тега.
//
//   тег v2.2 на коммите A, после него 7 коммитов  ->  2.2.7
//
// Тег базы — ровно две цифры (v2.3). Трёхзначные теги (v2.2.7) — это
// опубликованные релизы publish-release, на расчёт они не влияют. Чтобы
// поднять минор, достаточно поставить новый тег: git tag v2.3
//
// Вне git или без тега остаётся версия из package.json: установленное
// приложение читает её оттуда, а не из репозитория.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const cmpTags = (a, b) => {
  const [a1, a2] = a.slice(1).split('.').map(Number);
  const [b1, b2] = b.slice(1).split('.').map(Number);
  return a1 - b1 || a2 - b2;
};

/** Версия по git или null, если посчитать не из чего. */
export function gitVersion(root) {
  const list = git(root, 'tag', '--merged', 'HEAD', '--list', 'v*');
  if (!list) return null;
  const bases = list.split(/\r?\n/).filter((t) => /^v\d+\.\d+$/.test(t)).sort(cmpTags);
  const base = bases.at(-1);
  if (!base) return null;
  const count = git(root, 'rev-list', '--count', `${base}..HEAD`);
  return count === null ? null : `${base.slice(1)}.${count}`;
}

/**
 * Записать вычисленную версию в package.json: от него читают версию и
 * приложение, и сборочные скрипты, и самообновление.
 * Возвращает действующую версию.
 */
export function stampVersion(root) {
  const file = path.join(root, 'package.json');
  const raw = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(raw);
  const v = gitVersion(root);
  if (!v || v === pkg.version) return pkg.version;
  pkg.version = v;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2).replace(/\n/g, eol) + eol);
  process.stdout.write(`версия из git: ${v}\n`);
  return v;
}
