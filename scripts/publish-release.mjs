#!/usr/bin/env node
// Публикация релиза на GitHub: собирает установщик и выкладывает его одним файлом.
//
//   node scripts/publish-release.mjs                      проверки, сборка, запрос подтверждения, публикация
//   node scripts/publish-release.mjs --yes                без вопросов (все проверки остаются)
//   node scripts/publish-release.mjs --dry-run            всё, кроме публикации: покажет, что было бы сделано
//   node scripts/publish-release.mjs --notes файл.md      свои заметки к релизу (иначе — из заголовков коммитов)
//   node scripts/publish-release.mjs --draft              черновик (виден только вам, публикуется кнопкой на GitHub)
//   node scripts/publish-release.mjs --prerelease         пометить как предварительный
//   node scripts/publish-release.mjs --skip-tests         не гонять тесты
//   node scripts/publish-release.mjs --skip-build         взять уже собранный установщик из dist/installer
//   node scripts/publish-release.mjs --remote github      куда публиковать (по умолчанию github)
//
// К релизу прикладывается ТОЛЬКО установщик net-device-share-setup-<версия>.exe. Его
// SHA-256 — в тексте релиза, чтобы можно было сверить скачанное. Версия берётся из
// package.json; тег — v<версия>. Опубликованную версию повторно выложить нельзя: поднимите версию.
//
// Нужен GitHub CLI (gh) с выполненным `gh auth login`: publish-release.bat в корне проекта
// (рядом с build&install.bat) поставит его сам и запустит вход.
//
// Что делается во внешний мир — только после явного подтверждения (или --yes):
//   1. git push <remote> <текущая ветка>   (коммиты релиза должны быть на GitHub, иначе тегу не на что встать)
//   2. gh release create v<версия> <установщик>

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stampVersion } from './lib/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, def) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? def : args[i + 1];
};

const GH = process.env.GH_PATH || 'gh';
const REMOTE = opt('remote', 'github');
const YES = flag('yes');
const DRY = flag('dry-run');

const say = (m = '') => process.stdout.write(`${m}\n`);
const step = (m) => say(`\n▶ ${m}`);
function die(m) {
  process.stderr.write(`\n✖ ${m}\n`);
  process.exit(1);
}

function run(cmd, cmdArgs, { allowFail = false, input, inherit = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', input, stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
  if (r.error) {
    if (allowFail) return { status: -1, stdout: '', stderr: r.error.message };
    die(`не удалось запустить ${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) die(`${cmd} ${cmdArgs.join(' ')}\n${(r.stderr || r.stdout || '').trim()}`);
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

const git = (...a) => run('git', a).stdout;

async function confirm(question) {
  if (YES) return true;
  if (!process.stdin.isTTY) die('нужно подтверждение, а ввода нет: запустите с --yes или из консоли');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes' || answer === 'д' || answer === 'да';
}

// ============================================================================ проверки

stampVersion(ROOT);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die(`странная версия в package.json: ${version}`);
const tag = `v${version}`;
const exeName = `net-device-share-setup-${version}.exe`;
const exe = path.join(ROOT, 'dist', 'installer', exeName);

step(`Релиз ${tag}`);

// Рабочее дерево: релиз собирается из коммита, а не из «того, что лежит на диске».
// package.json правит сама сборка (версия из git) — это не «незакоммиченное».
const dirty = git('status', '--porcelain').split(/\r?\n/).filter((l) => l && !/ package\.json$/.test(l)).join('\n');
if (dirty && !flag('allow-dirty')) {
  die(`в рабочем каталоге есть незакоммиченное:\n${dirty}\nЗакоммитьте (релиз собирается из коммита) или добавьте --allow-dirty.`);
}
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const sha = git('rev-parse', 'HEAD');
say(`ветка ${branch}, коммит ${sha.slice(0, 10)}`);

const remoteUrl = run('git', ['remote', 'get-url', REMOTE], { allowFail: true });
if (remoteUrl.status !== 0) die(`нет удалённого репозитория «${REMOTE}» (git remote -v)`);
const repoMatch = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remoteUrl.stdout);
if (!repoMatch) die(`«${REMOTE}» — не GitHub: ${remoteUrl.stdout}`);
const repo = repoMatch[1];
say(`репозиторий ${repo}`);

// GitHub CLI и вход в аккаунт.
const ghv = run(GH, ['--version'], { allowFail: true });
if (ghv.status !== 0) die('не найден GitHub CLI (gh). Установите: winget install GitHub.cli — либо запустите publish-release.bat, он поставит сам.');
const auth = run(GH, ['auth', 'status'], { allowFail: true });
if (auth.status !== 0) die('GitHub CLI не вошёл в аккаунт. Выполните: gh auth login');
say(ghv.stdout.split('\n')[0]);

// Такого релиза и тега ещё нет.
const existing = run(GH, ['release', 'view', tag, '--repo', repo], { allowFail: true });
if (existing.status === 0) die(`релиз ${tag} уже опубликован. Поднимите версию в package.json (и закоммитьте).`);
const remoteTag = run('git', ['ls-remote', '--tags', REMOTE, tag], { allowFail: true });
if (remoteTag.stdout) die(`тег ${tag} уже есть на GitHub, хотя релиза нет. Удалите тег или поднимите версию.`);

// ============================================================================ тесты

if (!flag('skip-tests')) {
  step('Тесты');
  const r = spawnSync(process.execPath, ['--test', 'test/*.test.mjs', 'test/update/*.test.mjs'], { cwd: ROOT, encoding: 'utf8' });
  const tail = (r.stdout || '').split('\n').filter((l) => /^ℹ (tests|pass|fail)/.test(l)).join('  ');
  say(tail || '(итог не разобран)');
  if (r.status !== 0) die(`тесты не прошли — релиз не выкладываем:\n${(r.stdout || '').split('\n').filter((l) => l.startsWith('✖')).slice(0, 10).join('\n')}`);
}

// ============================================================================ установщик

if (!flag('skip-build') || !fs.existsSync(exe)) {
  step('Сборка установщика (нужен Inno Setup 6 и ключ подписи релизов)');
  const r = spawnSync(process.execPath, [path.join('scripts', 'build-installer.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) die('сборка установщика не удалась (причина выше)');
}
if (!fs.existsSync(exe)) die(`после сборки нет файла ${exe}`);
const exeStat = fs.statSync(exe);
const exeSha = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
say(`\n${exeName}: ${(exeStat.size / 1048576).toFixed(1)} МБ`);
say(`SHA-256 ${exeSha}`);

// Установщик должен быть собран из этого коммита: проверяем по времени, чтобы не выложить вчерашний.
const commitTime = Number(git('log', '-1', '--format=%ct')) * 1000;
if (exeStat.mtimeMs < commitTime - 60000 && !flag('allow-stale')) {
  die('установщик старше последнего коммита — соберите заново (уберите --skip-build) или добавьте --allow-stale.');
}

// ============================================================================ заметки

function autoNotes() {
  // Предыдущий релизный тег, достижимый из текущего коммита; иначе — последние коммиты.
  const prev = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD'], { allowFail: true });
  const range = prev.status === 0 ? [`${prev.stdout}..HEAD`] : ['-n', '30'];
  const subjects = git('log', ...range, '--no-merges', '--format=%s').split('\n').filter(Boolean);
  const since = prev.status === 0 ? `с ${prev.stdout}` : 'последние изменения';
  return `## Что нового (${since})\n\n${subjects.map((s) => `- ${s}`).join('\n')}\n`;
}

const notesFile = opt('notes', null);
let body = notesFile ? fs.readFileSync(path.resolve(notesFile), 'utf8').trim() : autoNotes().trim();
body += `

---

**Установка.** Скачайте \`${exeName}\` и запустите (Windows спросит права администратора).
Тихая установка: \`${exeName} /VERYSILENT /SUPPRESSMSGBOXES /TASKS="autostart,firewall,desktopicon"\`.
Подробности — в [README](https://github.com/${repo}#readme) и [docs/UPDATE.md](https://github.com/${repo}/blob/${tag}/docs/UPDATE.md).

**SHA-256** \`${exeName}\`:
\`\`\`
${exeSha}
\`\`\`
`;
const notesPath = path.join(ROOT, 'dist', `release-notes-${tag}.md`);
fs.mkdirSync(path.dirname(notesPath), { recursive: true });
fs.writeFileSync(notesPath, body);

// ============================================================================ публикация

step('Итог');
say(`  репозиторий : ${repo}`);
say(`  тег / релиз : ${tag}${flag('draft') ? ' (черновик)' : ''}${flag('prerelease') ? ' (предварительный)' : ''}`);
say(`  коммит      : ${sha.slice(0, 10)} (ветка ${branch})`);
say(`  файл        : ${exeName} (единственный, ${(exeStat.size / 1048576).toFixed(1)} МБ)`);
say(`  заметки     : ${path.relative(ROOT, notesPath)}`);
say('\n' + body.split('\n').slice(0, 14).join('\n') + (body.split('\n').length > 14 ? '\n  …' : ''));

if (DRY) {
  say('\n(--dry-run) публикация не выполнялась.');
  process.exit(0);
}

const ahead = run('git', ['rev-list', '--count', `${REMOTE}/${branch}..HEAD`], { allowFail: true });
const aheadText = ahead.status === 0 ? `${ahead.stdout} коммит(ов) уйдут на GitHub` : `ветка ${branch} появится на GitHub`;
if (!(await confirm(`\nОтправить ветку ${branch} (${aheadText}) в ${REMOTE} и опубликовать релиз ${tag}?`))) {
  say('Отменено. Ничего не отправлено.');
  process.exit(0);
}

step(`git push ${REMOTE} ${branch}`);
run('git', ['push', REMOTE, branch], { inherit: true });

step(`gh release create ${tag}`);
const create = ['release', 'create', tag, exe, '--repo', repo, '--target', sha, '--title', `Net Device Share ${version}`, '--notes-file', notesPath];
if (flag('draft')) create.push('--draft');
if (flag('prerelease')) create.push('--prerelease');
else create.push('--latest');
const out = run(GH, create);
say(`\n✔ Опубликовано: ${out.stdout.split('\n').pop()}`);
