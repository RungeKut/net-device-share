// Прогон тестов с таблицей покрытия для CI. Набор файлов берётся из npm test
// (package.json — единый источник: glob в аргументах --test Node 20 не
// раскрывает, поэтому список остаётся явным, и дублировать его здесь нельзя).
// Порога нет: цель — видеть покрытие, а не гнать число.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const files = pkg.scripts.test.match(/test\/[^\s"]+\.test\.mjs/g) || [];
if (!files.length) {
  console.error('в npm test не найдено файлов тестов — проверьте scripts.test в package.json');
  process.exit(2);
}
const r = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', ...files], {
  cwd: ROOT, stdio: 'inherit',
});
process.exit(r.status ?? 1);
