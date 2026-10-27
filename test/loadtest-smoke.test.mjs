// Дымовой тест нагрузочного стенда: три узла, одна ступень, весь конвейер
// (info, старт партии, сходимость, замер CIM, задержки, отчёт, уборка).
//   node --test test/loadtest-smoke.test.mjs

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countStrayNodes } from '../scripts/lib/loadtest-sys.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAND = path.join(ROOT, 'scripts', 'loadtest.mjs');
const MAIN = path.join(ROOT, 'src', 'main.js');
const skip = process.platform !== 'win32' ? 'стенд рассчитан на Windows (счётчики CIM)' : false;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-loadtest-smoke-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

const basePort = 41000 + Math.floor(Math.random() * 40) * 100;
const discoveryPort = 47940 + Math.floor(Math.random() * 40);

function stand(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STAND, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const rows = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

test('стенд: неверные опции отвергаются до запуска узлов', { skip }, async () => {
  const a = await stand(['bogus']);
  assert.equal(a.code, 2);
  const b = await stand(['ramp', '--discovery-port', '47811', '--out', path.join(work, 'bad')]);
  assert.equal(b.code, 2);
  assert.match(b.out, /47811/);
  const c = await stand(['ramp', '--steps', 'abc', '--out', path.join(work, 'bad')]);
  assert.equal(c.code, 2);
});

test('стенд: ramp на 3 узлах даёт замеры, отчёт и не оставляет процессов', { skip, timeout: 180000 }, async () => {
  const out = path.join(work, 'result');
  const r = await stand([
    'ramp', '--steps', '3', '--batch', '3', '--settle-seconds', '3', '--min-free-mb', '256',
    '--base-port', String(basePort), '--discovery-port', String(discoveryPort), '--out', out,
  ]);
  assert.equal(r.code, 0, r.out);

  const info = JSON.parse(fs.readFileSync(path.join(out, 'info.json'), 'utf8'));
  assert.ok(info.cpu.logicalProcessors >= 1);
  assert.ok(info.memory.totalMb > 0);

  const lines = rows(path.join(out, 'ramp.jsonl'));
  const step = lines.find((l) => l.ev === 'step');
  assert.ok(step, r.out);
  assert.equal(step.nodes, 3);
  assert.equal(step.convergence.timedOut, false, 'три узла должны увидеть друг друга');
  assert.equal(step.startup.notReady, 0);
  assert.equal(step.proc.count, 3, 'процессы узлов найдены по запомненным PID');
  assert.ok(step.proc.rssAvgMb > 10);
  assert.ok(step.cpu.busyPct >= 0 && step.cpu.busyPct <= 100);
  assert.equal(typeof step.net.udpRecvPerSec, 'number', 'счётчики сети из CIM прочитаны');
  assert.ok(step.net.samples >= 2);
  assert.ok(step.latency.state.p95 > 0);
  assert.ok(step.latency.metrics.series > 0, 'метрики первого узла отвечают');
  assert.equal(lines.find((l) => l.ev === 'done').code, 'steps');

  const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.match(report, /Ступенчатый рост/);
  assert.match(report, /Приём UDP на общем порту обнаружения/);
  assert.ok(fs.readdirSync(path.join(out, 'node-logs', 'ramp')).length === 3, 'журналы трёх узлов сохранены');

  assert.equal(countStrayNodes(MAIN), 0, 'после стенда не остаётся узлов LT-');
});
