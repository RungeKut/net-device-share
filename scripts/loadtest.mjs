// Нагрузочный стенд: сколько узлов выдерживает машина и что происходит с сетью.
// Поднимает настоящие узлы приложения (--backend mock) на одной машине и
// измеряет их. Windows 10+, Node >= 20.6, без зависимостей.
//
//   node scripts/loadtest.mjs info
//   node scripts/loadtest.mjs ramp  [--steps 10,25,50,...] [--batch 10] [--settle-seconds 20] [--max-cpu 92]
//   node scripts/loadtest.mjs storm [--nodes 50] [--victims 3]
//   node scripts/loadtest.mjs soak  [--nodes 20] [--minutes 10]
//   node scripts/loadtest.mjs all
//
// Результат: <out>/info.json, ramp.jsonl, storm.jsonl, soak.jsonl, report.md,
// node-logs/. Узлы называются LT-0001 …, порты base-port + 4*i. Порт
// обнаружения не стандартный, чтобы стенд не мешал настоящим узлам.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PORT_LIMIT, sleep, round, pct, freeMb, mapLimit, measureWindow, portsFree,
  killPids, killStrayNodes, countStrayNodes, collectInfo,
} from './lib/loadtest-sys.mjs';
import { buildReport } from './lib/loadtest-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'src', 'main.js');
const STANDARD_DISCOVERY_PORT = 47811;
const POLL_LIMIT = 32;
const CONVERGENCE_TIMEOUT_S = 180;
const SAMPLE_NODES = 40;
const ALL_TYPES = ['usb', 'com', 'lpt', 'net'];

const HELP = `Нагрузочный стенд Net Device Share.

  node scripts/loadtest.mjs <команда> [опции]

Команды:
  info    сведения о машине (пишет info.json)
  ramp    ступенчатый рост числа узлов: --steps 10,25,50,100,200,400,800,1600
          --batch 10  --settle-seconds 20  --max-cpu 92
  storm   одновременный старт --nodes N (по умолчанию 50), затем остановка
          --victims K (3) узлов, время обнаружения и возврата после рестарта
  soak    держать --nodes N (20) в течение --minutes M (10), сэмпл раз в 30 с
  all     info, ramp, storm, soak с умолчаниями по итогам ramp

Общие опции:
  --out result            куда писать (по умолчанию папка result в корне репозитория)
  --base-port 30000       порты узла: base + 4*i (не выше ${PORT_LIMIT})
  --discovery-port 47931  порт обнаружения (не 47811, чтобы не мешать настоящим узлам)
  --types all|usb         enabledTypes узлов; можно списком: usb,com
  --network <CIDR>        обнаружение только в этой сети (иначе автовыбор)
  --min-free-mb 2048      порог свободной памяти, ниже которого рост останавливается
  --jitter <доля>         timerJitter в конфиге узла
  --max-nodes 3000        потолок числа узлов
`;

// ------------------------------------------------------------------ параметры

const SPECS = {
  steps: ['str', '10,25,50,100,200,400,800,1600'], batch: ['int', 10], 'settle-seconds': ['int', 20],
  'max-cpu': ['num', 92], nodes: ['int', null], victims: ['int', 3], minutes: ['num', null],
  out: ['str', path.join(ROOT, 'result')], 'base-port': ['int', 30000], 'discovery-port': ['int', 47931],
  types: ['str', 'all'], network: ['str', null], 'min-free-mb': ['int', 2048], jitter: ['num', null],
  'max-nodes': ['int', 3000],
};
const COMMANDS = ['info', 'ramp', 'storm', 'soak', 'all'];

function fail(msg) {
  process.stderr.write(`${msg}\n\n${HELP}`);
  process.exit(2);
}

function parseOptions(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(HELP); process.exit(0); }
  if (!COMMANDS.includes(cmd)) fail(`неизвестная команда: ${cmd}`);
  const raw = {};
  for (let i = 1; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) fail(`лишний аргумент: ${a}`);
    let val;
    const eq = a.indexOf('=');
    if (eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const key = a.slice(2);
    if (!SPECS[key]) fail(`неизвестная опция: ${a}`);
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined || val.startsWith('--')) fail(`у опции ${a} нет значения`);
    }
    raw[key] = val;
  }
  const o = {};
  for (const [key, [kind, def]] of Object.entries(SPECS)) {
    const camel = key.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    let v = raw[key] ?? def;
    if (v != null && kind !== 'str') {
      v = Number(v);
      if (!Number.isFinite(v) || (kind === 'int' && !Number.isInteger(v))) fail(`опция --${key}: ожидалось число, получено ${raw[key]}`);
    }
    o[camel] = v;
  }
  o.out = path.resolve(o.out);
  o.stepList = o.steps.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
  if (!o.stepList.length || o.stepList.some((n) => !Number.isInteger(n))) fail(`--steps: ожидался список целых чисел, получено ${o.steps}`);
  o.types = o.types === 'all' ? ALL_TYPES : o.types.split(',').map((s) => s.trim()).filter(Boolean);
  if (!o.types.length || o.types.some((t) => !ALL_TYPES.includes(t))) fail(`--types: all или список из ${ALL_TYPES.join(',')}`);
  if (o.discoveryPort === STANDARD_DISCOVERY_PORT) fail(`--discovery-port ${STANDARD_DISCOVERY_PORT} — порт настоящих узлов, стенд им мешал бы`);
  if (o.basePort < 1024 || o.basePort + 3 > PORT_LIMIT) fail(`--base-port должен быть в пределах 1024..${PORT_LIMIT - 3}`);
  if (o.batch < 1) fail('--batch должен быть не меньше 1');
  if (o.victims < 1) fail('--victims должен быть не меньше 1');
  return { cmd, o };
}

// ------------------------------------------------------------------ состояние стенда

const ctx = {
  o: null, phase: 'run', tmp: null, nodes: [], nextSlot: 0, nextOrdinal: 1,
  portSkips: 0, portConflicts: 0, portsExhausted: false,
  warn: new Map(), offlineMarks: 0, spawnedAny: false, rssAvgMb: null,
};

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (s) => process.stdout.write(`${stamp()} ${s}\n`);

function rows(file) {
  const full = path.join(ctx.o.out, file);
  fs.writeFileSync(full, '');
  return (obj) => fs.appendFileSync(full, `${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);
}

const LOG_RE = /^\S+\s+(WARN|ERROR)\s+(.*)$/;
const LOG_HEAD_LINES = 50;
const LOG_FILE_CAP = 200 * 1024;

function normalize(msg) {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d+(\.\d+){1,3}(:\d+)?/g, '<ip>')
    .replace(/LT-\d+/g, 'LT-n')
    .replace(/\d+/g, '#')
    .slice(0, 160);
}

function onLine(n, line) {
  n.lines++;
  if (n.readyMs == null && line.includes('Интерфейс:')) n.readyMs = Date.now() - n.startedAt;
  const clash = /EADDRINUSE.*?:(\d{2,5})\b/.exec(line);
  if (clash && Number(clash[1]) >= n.port && Number(clash[1]) <= n.port + 3) n.addrInUse = true;
  const m = LOG_RE.exec(line);
  let keep = n.lines <= LOG_HEAD_LINES;
  if (m) {
    keep = true;
    const key = `${m[1]} ${normalize(m[2])}`;
    ctx.warn.set(key, (ctx.warn.get(key) || 0) + 1);
    if (m[1] === 'WARN' && m[2].includes('помечен офлайн')) ctx.offlineMarks++;
    n.tail = m[1] === 'ERROR' ? 8 : 0;
  } else if (n.tail > 0 && !/^\d\d:\d\d:/.test(line)) {
    keep = true;
    n.tail--;
  }
  if (!keep) return;
  if (n.logBytes > LOG_FILE_CAP) { n.logDropped++; return; }
  n.logBytes += line.length + 1;
  n.out.push(line);
}

function onChunk(n, chunk) {
  n.partial += chunk;
  let i;
  while ((i = n.partial.indexOf('\n')) >= 0) {
    onLine(n, n.partial.slice(0, i).replace(/\r$/, ''));
    n.partial = n.partial.slice(i + 1);
  }
  if (n.partial.length > 16384) n.partial = n.partial.slice(-2048);
}

function flushLogs() {
  const dir = path.join(ctx.o.out, 'node-logs', ctx.phase);
  for (const n of ctx.nodes) {
    if (!n.out.length) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${n.name}.log`), `${n.out.join('\n')}\n`);
    } catch { /* журнал — вспомогательное, измерения важнее */ }
    n.out = [];
  }
}

// ------------------------------------------------------------------ узлы

async function allocSlot() {
  for (;;) {
    const port = ctx.o.basePort + 4 * ctx.nextSlot;
    if (port + 3 > PORT_LIMIT) { ctx.portsExhausted = true; return null; }
    ctx.nextSlot++;
    if (await portsFree(port)) return { port };
    ctx.portSkips++;
  }
}

function writeConfig(n) {
  const file = path.join(n.home, 'config.json');
  // При рестарте файл не трогаем: в нём nodeId, по которому остальные узнают этот.
  if (fs.existsSync(file)) return;
  fs.mkdirSync(n.home, { recursive: true });
  const cfg = {
    name: n.name, apiPort: n.port, trafficPort: n.port + 1, netLinkPort: n.port + 2, usbipPort: n.port + 3,
    discoveryPort: ctx.o.discoveryPort, autoInstall: false, enabledTypes: ctx.o.types,
  };
  if (ctx.o.jitter != null) cfg.timerJitter = ctx.o.jitter;
  fs.writeFileSync(file, JSON.stringify(cfg));
}

function spawnNode(n) {
  writeConfig(n);
  const args = [MAIN, '--backend', 'mock', '--no-open', '--name', n.name];
  if (ctx.o.network) args.push('--network', ctx.o.network);
  if (n.ordinal === 1) args.push('--metrics');
  const child = spawn(process.execPath, args, {
    env: { ...process.env, NDS_HOME: n.home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  ctx.spawnedAny = true;
  Object.assign(n, {
    child, pid: child.pid, exited: false, exitCode: null, expectedExit: false, readyMs: null,
    startedAt: Date.now(), partial: '', lines: 0, tail: 0, addrInUse: false,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => onChunk(n, d));
  child.stderr.on('data', (d) => onChunk(n, d));
  child.on('error', (e) => { if (n.child === child) { n.exited = true; n.exitCode = e.message; } });
  child.on('exit', (code, sig) => { if (n.child === child) { n.exited = true; n.exitCode = code ?? sig; n.exitedAt = Date.now(); } });
  return n;
}

async function newNode() {
  const slot = await allocSlot();
  if (!slot) return null;
  const ordinal = ctx.nextOrdinal++;
  const name = `LT-${String(ordinal).padStart(4, '0')}`;
  const n = {
    ordinal, name, port: slot.port, home: path.join(ctx.tmp, name), out: [], logBytes: 0, logDropped: 0,
  };
  ctx.nodes.push(n);
  return spawnNode(n);
}

const aliveNodes = () => ctx.nodes.filter((n) => !n.exited && n.readyMs != null);
const deadCount = () => ctx.nodes.filter((n) => n.exited && !n.expectedExit).length;
const pidSet = () => new Set(ctx.nodes.filter((n) => !n.exited).map((n) => n.pid));

async function api(n, p, { method = 'GET', body, timeout = 8000 } = {}) {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${n.port}${p}`, {
    method,
    headers: { 'x-nds-ui': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - t0, bytes: Buffer.byteLength(text), text };
}

async function stateOf(n, timeout = 10000) {
  try {
    const r = await api(n, '/api/v1/state', { timeout });
    return r.status === 200 ? JSON.parse(r.text) : null;
  } catch { return null; }
}

// Готовность — по строке запуска в выводе узла; HTTP-проба только как запасной
// путь, если строка почему-то не пришла.
async function waitReady(batch, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    const pending = batch.filter((n) => n.readyMs == null && !n.exited);
    if (!pending.length || Date.now() - t0 > timeoutMs) break;
    const probe = pending.filter((n) => Date.now() - n.startedAt > 10000);
    await mapLimit(probe, POLL_LIMIT, async (n) => {
      const s = await stateOf(n, 3000);
      if (s && n.readyMs == null) n.readyMs = Date.now() - n.startedAt;
    });
    await sleep(300);
  }
  return batch.filter((n) => n.readyMs == null && !n.exited).length;
}

/** Поднимает партию; узлы, не взявшие порт (гонка с чужим процессом), перезапускает на новых портах. */
async function startBatch(count) {
  const batch = [];
  for (let k = 0; k < count && ctx.nextOrdinal <= ctx.o.maxNodes; k++) {
    const n = await newNode();
    if (!n) break;
    batch.push(n);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitReady(batch);
    const clash = batch.filter((n) => n.addrInUse);
    if (!clash.length) break;
    for (const n of clash) {
      ctx.portConflicts++;
      // Узел при занятом порте счётчика или канала не падает, а работает урезанным: такой в замеры не годится.
      if (!n.exited) { n.expectedExit = true; killPids([n.pid]); await sleep(300); }
      const slot = await allocSlot();
      if (!slot) break;
      n.port = slot.port;
      fs.rmSync(n.home, { recursive: true, force: true });
      spawnNode(n);
    }
  }
  const notReady = batch.filter((n) => n.readyMs == null && !n.exited).length;
  return { batch, requested: count, notReady };
}

function memGate(batchSize) {
  const per = ctx.rssAvgMb || 80;
  const free = freeMb();
  const need = ctx.o.minFreeMb + Math.ceil(batchSize * per);
  if (free >= need) return null;
  return `свободно ${free} МБ, а для партии из ${batchSize} узлов (≈${per} МБ каждый) с запасом ${ctx.o.minFreeMb} МБ нужно ${need} МБ`;
}

/** Растит парк до target узлов партиями; null — дошли, иначе { code, reason }. */
async function growTo(target) {
  while (ctx.nextOrdinal - 1 < target && ctx.nextOrdinal <= ctx.o.maxNodes) {
    const size = Math.min(ctx.o.batch, target - (ctx.nextOrdinal - 1));
    const gate = memGate(size);
    if (gate) return { code: 'memory', reason: `память: ${gate}` };
    const r = await startBatch(size);
    if (ctx.portsExhausted && r.batch.length < size) {
      return { code: 'ports', reason: `закончились порты: base-port ${ctx.o.basePort} + 4*i упёрся в ${PORT_LIMIT} (пропущено занятых мест: ${ctx.portSkips}, конфликтов EADDRINUSE: ${ctx.portConflicts})` };
    }
    if (r.batch.length && r.notReady > r.batch.length / 2) {
      return { code: 'startup', reason: `узлы не поднимаются: в партии из ${r.batch.length} не готовы ${r.notReady} за 120 с` };
    }
    if (deadCount() > ctx.nodes.length * 0.05) {
      return { code: 'crash', reason: `упало узлов: ${deadCount()} из ${ctx.nodes.length} (больше 5%)` };
    }
    await sleep(300);
  }
  if (ctx.nextOrdinal - 1 < target && ctx.nextOrdinal > ctx.o.maxNodes) {
    return { code: 'max-nodes', reason: `достигнут потолок --max-nodes ${ctx.o.maxNodes}` };
  }
  return null;
}

// ------------------------------------------------------------------ измерения

function pickSample(list, k) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

const onlinePeers = (s) => (s?.peers || []).filter((p) => p.online !== false);

/** Ждёт, пока выборка узлов видит всех живых; секунды отсчитываются от вызова. */
async function waitConvergence(timeoutS = CONVERGENCE_TIMEOUT_S, pollMs = 3000) {
  const t0 = Date.now();
  const sample = pickSample(aliveNodes(), SAMPLE_NODES);
  let full = 0;
  let minSeen = null;
  while ((Date.now() - t0) / 1000 < timeoutS) {
    const expect = aliveNodes().length - 1;
    const live = sample.filter((n) => !n.exited);
    const seen = await mapLimit(live, POLL_LIMIT, async (n) => {
      const s = await stateOf(n);
      return s ? onlinePeers(s).length : -1;
    });
    full = seen.filter((c) => c >= expect).length;
    minSeen = Math.min(...seen.filter((c) => c >= 0), Infinity);
    if (minSeen === Infinity) minSeen = null;
    if (live.length && full === live.length) {
      return { secs: round((Date.now() - t0) / 1000), sample: live.length, minSeen, timedOut: false };
    }
    await sleep(pollMs);
  }
  return { secs: null, sample: sample.length, full, minSeen, timedOut: true };
}

async function measureLatency() {
  const alive = aliveNodes();
  if (!alive.length) return null;
  const probe = alive[Math.min(1, alive.length - 1)];
  const st = [];
  let stBytes = 0;
  let stFail = 0;
  for (let i = 0; i < 20; i++) {
    try { const r = await api(probe, '/api/v1/state'); st.push(r.ms); stBytes = r.bytes; } catch { stFail++; }
  }
  const mt = [];
  let mtBytes = 0;
  let mtFail = 0;
  let series = null;
  const metricsNode = alive.find((n) => n.ordinal === 1);
  for (let i = 0; metricsNode && i < 5; i++) {
    try {
      const r = await api(metricsNode, '/metrics', { timeout: 20000 });
      if (r.status === 200) {
        mt.push(r.ms); mtBytes = r.bytes;
        series = r.text.split('\n').filter((l) => l && !l.startsWith('#')).length;
      } else mtFail++;
    } catch { mtFail++; }
  }
  return {
    state: { p50: round(pct(st, 0.5)), p95: round(pct(st, 0.95)), kb: round(stBytes / 1024), fail: stFail },
    metrics: { p50: round(pct(mt, 0.5)), p95: round(pct(mt, 0.95)), kb: round(mtBytes / 1024), series, fail: mtFail },
  };
}

/** Время, за которое устройство, опубликованное одним узлом, появляется в каталоге другого. */
async function measurePropagation() {
  const alive = aliveNodes();
  if (alive.length < 3) return null;
  const a = alive[1];
  const b = alive[alive.length - 1];
  const aId = (await stateOf(a))?.self?.nodeId;
  if (!aId) return null;
  const target = 'usb:1-1';
  let ms = null;
  try {
    const t0 = performance.now();
    await api(a, '/api/v1/share', { method: 'POST', body: { deviceId: target, shared: true } });
    while (performance.now() - t0 < 60000) {
      const s = await stateOf(b, 5000);
      if ((s?.catalog || []).some((e) => e.target === target && e.ownerId === aId)) { ms = performance.now() - t0; break; }
      await sleep(100);
    }
  } catch { /* таймаут пойдёт в отчёт как «не дошло» */ }
  await api(a, '/api/v1/share', { method: 'POST', body: { deviceId: target, shared: false } }).catch(() => {});
  return round(ms, 0);
}

function logTop(sinceSnapshot, k = 6) {
  const out = [];
  for (const [key, c] of ctx.warn) {
    const d = c - (sinceSnapshot?.get(key) || 0);
    if (d > 0) out.push({ msg: key, count: d });
  }
  return out.sort((x, y) => y.count - x.count).slice(0, k);
}

const snapWarn = () => new Map(ctx.warn);

async function sampleWindow(seconds = 10) {
  const w = await measureWindow(pidSet, seconds);
  if (w?.proc?.rssAvgMb) ctx.rssAvgMb = w.proc.rssAvgMb;
  return w || { cpu: null, proc: null, net: null };
}

// ------------------------------------------------------------------ ramp

async function cmdRamp() {
  const emit = rows('ramp.jsonl');
  const o = ctx.o;
  const steps = o.stepList.filter((s) => s <= o.maxNodes);
  const cut = steps.length < o.stepList.length;
  emit({ ev: 'start', steps, batch: o.batch, settleSeconds: o.settleSeconds, maxCpu: o.maxCpu, minFreeMb: o.minFreeMb, types: o.types, network: o.network, jitter: o.jitter, basePort: o.basePort, discoveryPort: o.discoveryPort, cores: os.cpus().length, totalMb: Math.round(os.totalmem() / 1048576), freeMb: freeMb() });

  const base = await sampleWindow(10);
  emit({ ev: 'baseline', cpu: base.cpu, net: base.net, freeMb: freeMb() });
  say(`[ramp] без узлов: CPU ${base.cpu?.busyPct ?? '?'}%, UDP ${base.net?.udpRecvPerSec ?? '?'}/с, свободно ${freeMb()} МБ`);

  let stop = null;
  let lastGood = 0;
  let cpuStreak = 0;
  let prevWarn = snapWarn();

  const step = async (target, partial) => {
    const tStep = Date.now();
    const added = ctx.nodes.filter((n) => n.stepMark === undefined);
    for (const n of added) n.stepMark = target;
    const readies = added.map((n) => n.readyMs).filter((x) => x != null);
    const conv = await waitConvergence();
    if (conv.timedOut) say(`[ramp] ${aliveNodes().length} узлов: сходимости нет за ${CONVERGENCE_TIMEOUT_S} с`);
    await sleep(o.settleSeconds * 1000);
    const w = await sampleWindow(10);
    const lat = await measureLatency();
    const prop = await measurePropagation();
    const row = {
      ev: 'step', target, partial, nodes: aliveNodes().length, spawned: ctx.nodes.length, exited: deadCount(),
      startup: { added: added.length, p50Ms: pct(readies, 0.5), p95Ms: pct(readies, 0.95), notReady: added.filter((n) => n.readyMs == null).length },
      convergence: conv, cpu: w.cpu, proc: w.proc, net: w.net, freeMb: freeMb(),
      latency: lat, propagationMs: prop, topLogs: logTop(prevWarn), portSkips: ctx.portSkips, portConflicts: ctx.portConflicts,
      stepSecs: Math.round((Date.now() - tStep) / 1000),
    };
    prevWarn = snapWarn();
    emit(row);
    say(`[ramp] ${row.nodes} узлов | старт p50 ${round((row.startup.p50Ms ?? 0) / 1000)} с | сходимость ${conv.secs ?? 'нет'} с | CPU ${w.cpu?.busyPct ?? '?'}% | ОЗУ ${round((w.proc?.rssTotalMb ?? 0) / 1024, 2)} ГБ, свободно ${round(freeMb() / 1024, 2)} | UDP ${w.net?.udpRecvPerSec ?? '?'}/с, ошибок ${w.net?.udpRecvErrors ?? '?'} | state p95 ${lat?.state.p95 ?? '?'} мс`);
    return row;
  };

  for (const target of steps) {
    const grow = await growTo(target);
    if (grow && ctx.nodes.length > 0 && aliveNodes().length > lastGood) {
      const row = await step(target, true);
      if (!row.convergence.timedOut) lastGood = row.nodes;
    }
    if (grow) { stop = grow; break; }
    const row = await step(target, false);
    if (row.convergence.timedOut) {
      stop = { code: 'convergence', reason: `сеть не сошлась за ${CONVERGENCE_TIMEOUT_S} с на ${row.nodes} узлах (выборка ${row.convergence.sample} узлов видела не всех)` };
      break;
    }
    lastGood = row.nodes;
    if (deadCount() > ctx.nodes.length * 0.05) {
      stop = { code: 'crash', reason: `упало узлов: ${deadCount()} из ${ctx.nodes.length} (больше 5%)` };
      break;
    }
    cpuStreak = (row.cpu?.busyPct ?? 0) > o.maxCpu ? cpuStreak + 1 : 0;
    if (cpuStreak >= 3) {
      stop = { code: 'cpu', reason: `процессор машины выше ${o.maxCpu}% на трёх ступенях подряд (последняя: ${row.cpu.busyPct}% на ${row.nodes} узлах)` };
      break;
    }
  }
  if (!stop) {
    stop = cut
      ? { code: 'max-nodes', reason: `пройдены все ступени до потолка --max-nodes ${o.maxNodes}` }
      : { code: 'steps', reason: 'пройдены все заданные ступени' };
  }
  flushLogs();
  emit({ ev: 'done', code: stop.code, reason: stop.reason, lastGood, spawned: ctx.nodes.length, exited: deadCount(), portSkips: ctx.portSkips, portConflicts: ctx.portConflicts, topLogs: logTop(null, 15) });
  say(`[ramp] итог: ${stop.reason}; максимум со сходимостью: ${lastGood} узлов`);
  return { lastGood, ...stop };
}

// ------------------------------------------------------------------ storm

async function cmdStorm(nodesN, victimsK) {
  const emit = rows('storm.jsonl');
  const o = ctx.o;
  const N = Math.min(nodesN, o.maxNodes);
  const K = Math.min(victimsK, Math.max(1, N - 3));
  emit({ ev: 'start', nodes: N, victims: K, types: o.types, network: o.network, jitter: o.jitter, minFreeMb: o.minFreeMb });
  const gate = memGate(N);
  if (gate) {
    emit({ ev: 'done', code: 'memory', reason: `память: ${gate}` });
    say(`[storm] не запущено: ${gate}`);
    return;
  }
  const warn0 = snapWarn();
  const t0 = Date.now();
  // Окно начинается вместе со стартом и идёт параллельно ожиданию, чтобы не откладывать замер времени обзора.
  const startupWin = sampleWindow(15);
  const spawned = [];
  for (let i = 0; i < N; i++) {
    const n = await newNode();
    if (!n) break;
    spawned.push(n);
  }
  const spawnSecs = (Date.now() - t0) / 1000;
  await waitReady(spawned, 180000);
  const readies = spawned.map((n) => n.readyMs);
  emit({
    ev: 'startup', nodes: spawned.length, spawnSecs: round(spawnSecs), p50Ms: pct(readies, 0.5), p95Ms: pct(readies, 0.95),
    notReady: spawned.filter((n) => n.readyMs == null).length, exited: deadCount(),
  });
  say(`[storm] ${spawned.length} узлов запущено за ${round(spawnSecs)} с, готовы p50 ${round((pct(readies, 0.5) ?? 0) / 1000)} с, p95 ${round((pct(readies, 0.95) ?? 0) / 1000)} с`);

  const conv = await waitConvergence(CONVERGENCE_TIMEOUT_S, 2000);
  const fullSecs = conv.timedOut ? null : round((Date.now() - t0) / 1000);
  emit({ ev: 'fullview', fullSecsFromStart: fullSecs, ...conv });
  const startupWindow = await startupWin;
  emit({ ev: 'startup-window', window: startupWindow });
  say(`[storm] полный взаимный обзор: ${fullSecs == null ? `не наступил за ${CONVERGENCE_TIMEOUT_S} с` : `${fullSecs} с от старта`}`);
  if (conv.timedOut) {
    emit({ ev: 'done', code: 'convergence', reason: `обзор не стал полным за ${CONVERGENCE_TIMEOUT_S} с`, topLogs: logTop(warn0, 15) });
    flushLogs();
    return;
  }

  await sleep(20000);
  const alive = aliveNodes().filter((n) => n.ordinal !== 1);
  const victims = pickSample(alive, K);
  const observers = pickSample(alive.filter((n) => !victims.includes(n)), 8);
  for (const v of victims) v.nodeId = (await stateOf(v))?.self?.nodeId ?? null;

  const offlineBefore = ctx.offlineMarks;
  const tk = Date.now();
  killPids(victims.map((v) => { v.expectedExit = true; return v.pid; }));
  const detect = [];
  const detectedAt = new Map();
  while (Date.now() - tk < CONVERGENCE_TIMEOUT_S * 1000 && detectedAt.size < observers.length * victims.length) {
    await sleep(1000);
    await mapLimit(observers, POLL_LIMIT, async (ob) => {
      const s = await stateOf(ob, 5000);
      if (!s) return;
      for (const v of victims) {
        const key = `${ob.name}|${v.name}`;
        if (detectedAt.has(key)) continue;
        const p = (s.peers || []).find((x) => x.nodeId === v.nodeId);
        if (!p || p.online === false) { detectedAt.set(key, (Date.now() - tk) / 1000); detect.push((Date.now() - tk) / 1000); }
      }
    });
  }
  const pairs = observers.length * victims.length;
  emit({
    ev: 'detection', victims: victims.map((v) => v.name), observers: observers.length, pairs, detected: detect.length,
    p50Secs: round(pct(detect, 0.5)), p95Secs: round(pct(detect, 0.95)), maxSecs: round(Math.max(0, ...detect)),
    peerTimeoutMs: 12000, offlineMarks: ctx.offlineMarks - offlineBefore,
  });
  say(`[storm] убито ${victims.length}: обнаружено ${detect.length} из ${pairs} пар, p50 ${round(pct(detect, 0.5))} с, max ${round(Math.max(0, ...detect))} с`);

  await sleep(500);
  const tr = Date.now();
  for (const v of victims) spawnNode(v);
  const backAt = new Map();
  const ownFull = new Map();
  const nodeIdKept = new Map();
  const expectOwn = ctx.nodes.filter((n) => !n.exited).length - 1;
  while (Date.now() - tr < CONVERGENCE_TIMEOUT_S * 1000 && (backAt.size < pairs || ownFull.size < victims.length)) {
    await sleep(1000);
    await mapLimit(observers, POLL_LIMIT, async (ob) => {
      const s = await stateOf(ob, 5000);
      if (!s) return;
      for (const v of victims) {
        const key = `${ob.name}|${v.name}`;
        if (backAt.has(key)) continue;
        const p = (s.peers || []).find((x) => x.nodeId === v.nodeId);
        if (p && p.online !== false) backAt.set(key, (Date.now() - tr) / 1000);
      }
    });
    await mapLimit(victims.filter((v) => !ownFull.has(v.name)), POLL_LIMIT, async (v) => {
      const s = await stateOf(v, 5000);
      if (!s) return;
      nodeIdKept.set(v.name, s.self?.nodeId === v.nodeId);
      if (onlinePeers(s).length >= expectOwn) ownFull.set(v.name, (Date.now() - tr) / 1000);
    });
  }
  const back = [...backAt.values()];
  const own = [...ownFull.values()];
  emit({
    ev: 'rejoin', pairs, returned: back.length, p50Secs: round(pct(back, 0.5)), p95Secs: round(pct(back, 0.95)), maxSecs: round(Math.max(0, ...back)),
    victimsFullViewP50Secs: round(pct(own, 0.5)), victimsFullViewMaxSecs: round(Math.max(0, ...own)), victimsFullView: own.length,
    nodeIdKept: victims.length > 0 && victims.every((v) => nodeIdKept.get(v.name) === true),
    victimReadyP50Ms: pct(victims.map((v) => v.readyMs), 0.5),
  });
  say(`[storm] возврат после рестарта: ${back.length} из ${pairs} пар, p50 ${round(pct(back, 0.5))} с, max ${round(Math.max(0, ...back))} с; nodeId сохранён: ${victims.every((v) => nodeIdKept.get(v.name))}`);

  const w = await sampleWindow(10);
  flushLogs();
  emit({ ev: 'done', code: 'steps', reason: 'сценарий выполнен', after: { cpu: w.cpu, proc: w.proc, net: w.net }, nodes: aliveNodes().length, exited: deadCount(), offlineMarksTotal: ctx.offlineMarks, topLogs: logTop(warn0, 15) });
}

// ------------------------------------------------------------------ soak

async function cmdSoak(nodesN, minutes) {
  const emit = rows('soak.jsonl');
  const o = ctx.o;
  const N = Math.min(nodesN, o.maxNodes);
  emit({ ev: 'start', nodes: N, minutes, types: o.types, network: o.network, jitter: o.jitter, minFreeMb: o.minFreeMb });
  const grow = await growTo(N);
  if (grow) {
    emit({ ev: 'done', code: grow.code, reason: grow.reason });
    say(`[soak] не запущено: ${grow.reason}`);
    return;
  }
  const conv = await waitConvergence();
  emit({ ev: 'converged', ...conv, nodes: aliveNodes().length });
  say(`[soak] ${aliveNodes().length} узлов, сходимость ${conv.secs ?? 'нет'} с; держим ${minutes} мин`);

  const warn0 = snapWarn();
  const offline0 = ctx.offlineMarks;
  const tEnd = Date.now() + minutes * 60000;
  let prevOffline = ctx.offlineMarks;
  let i = 0;
  let stopped = null;
  while (Date.now() < tEnd) {
    const tTick = Date.now();
    i++;
    const w = await sampleWindow(10);
    const alive = aliveNodes();
    const seen = await mapLimit(pickSample(alive, 10), POLL_LIMIT, async (n) => {
      const s = await stateOf(n, 5000);
      return s ? onlinePeers(s).length : -1;
    });
    const ok = seen.filter((c) => c >= 0);
    const prop = i % 10 === 0 ? await measurePropagation() : undefined;
    const row = {
      ev: 'sample', i, minutes: round((tTick - (tEnd - minutes * 60000)) / 60000, 1), nodes: alive.length, exited: deadCount(),
      cpu: w.cpu, proc: w.proc, net: w.net, freeMb: freeMb(),
      falseOffline: ctx.offlineMarks - prevOffline, falseOfflineTotal: ctx.offlineMarks - offline0,
      seenMin: ok.length ? Math.min(...ok) : null, seenExpected: alive.length - 1, propagationMs: prop,
    };
    prevOffline = ctx.offlineMarks;
    emit(row);
    say(`[soak] ${row.minutes} мин | ${row.nodes} узлов (упало ${row.exited}) | CPU ${w.cpu?.busyPct ?? '?'}% | ОЗУ ${round((w.proc?.rssTotalMb ?? 0) / 1024, 2)} ГБ | дескр. ${w.proc?.handlesTotal ?? '?'} | ложных офлайн ${row.falseOffline} (всего ${row.falseOfflineTotal}) | видят ≥ ${row.seenMin}/${row.seenExpected}`);
    if (freeMb() < o.minFreeMb) { stopped = { code: 'memory', reason: `свободно ${freeMb()} МБ, ниже порога ${o.minFreeMb} МБ` }; break; }
    if (!alive.length) { stopped = { code: 'crash', reason: 'все узлы упали' }; break; }
    const wait = tTick + 30000 - Date.now();
    if (wait > 0) await sleep(Math.min(wait, Math.max(0, tEnd - Date.now())));
  }
  flushLogs();
  const reason = stopped ?? { code: 'steps', reason: `выдержано ${minutes} мин` };
  emit({ ev: 'done', ...reason, nodes: aliveNodes().length, exited: deadCount(), falseOfflineTotal: ctx.offlineMarks - offline0, topLogs: logTop(warn0, 15) });
}

// ------------------------------------------------------------------ завершение

let tmpRemoved = true;

function releaseFleet() {
  flushLogs();
  const live = ctx.nodes.filter((n) => n.child && n.child.exitCode === null && n.child.signalCode === null);
  for (const n of live) n.expectedExit = true;
  killPids(live.map((n) => n.pid));
  if (ctx.spawnedAny) killStrayNodes(MAIN);
  ctx.spawnedAny = false;
  ctx.nodes = [];
  if (ctx.tmp && !tmpRemoved) {
    try { fs.rmSync(ctx.tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); tmpRemoved = true; } catch { /* временная папка, ОС уберёт */ }
  }
}

function newFleet(phase) {
  ctx.phase = phase;
  ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-loadtest-'));
  tmpRemoved = false;
  Object.assign(ctx, { nodes: [], nextSlot: 0, nextOrdinal: 1, portSkips: 0, portConflicts: 0, portsExhausted: false, offlineMarks: 0 });
  ctx.warn = new Map();
}

async function runPhase(phase, fn) {
  newFleet(phase);
  const flusher = setInterval(flushLogs, 10000);
  try {
    return await fn();
  } finally {
    clearInterval(flusher);
    releaseFleet();
  }
}

function crashRow(file, e) {
  try { fs.appendFileSync(path.join(ctx.o.out, file), `${JSON.stringify({ t: new Date().toISOString(), ev: 'crash', error: String(e?.stack || e) })}\n`); } catch { /* */ }
}

// Прерванный жёстко (убит процесс стенда) прогон не успевает убрать свои данные.
function removeStaleData() {
  const tmp = os.tmpdir();
  for (const name of fs.readdirSync(tmp)) {
    if (!/^nds-loadtest-[A-Za-z0-9]{6}$/.test(name)) continue;
    const full = path.join(tmp, name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > 2 * 3600 * 1000) fs.rmSync(full, { recursive: true, force: true });
    } catch { /* занято другим прогоном */ }
  }
}

async function writeInfo() {
  const info = await collectInfo(ctx.o.basePort);
  fs.writeFileSync(path.join(ctx.o.out, 'info.json'), `${JSON.stringify(info, null, 2)}\n`);
  say(`[info] ${info.cpu.logicalProcessors} лог. процессоров, ${round(info.memory.totalMb / 1024, 1)} ГБ ОЗУ (свободно ${round(info.memory.freeMb / 1024, 1)}), ${info.windows.caption ?? 'Windows'} ${info.windows.version ?? ''}, Node ${info.node}, Defender: ${info.defender ? (info.defender.realtimeProtection ? 'включён' : 'выключен') : 'неизвестно'}, свободных мест под узлы: ${info.ports.freeSlots}, процессов node: ${info.nodeProcessesNow}`);
  return info;
}

async function main() {
  if (process.platform !== 'win32') fail('стенд рассчитан на Windows: счётчики сети берутся из CIM');
  const { cmd, o } = parseOptions(process.argv.slice(2));
  ctx.o = o;
  fs.mkdirSync(o.out, { recursive: true });

  const onSignal = (sig) => {
    process.stderr.write(`\nполучен ${sig}: останавливаю узлы\n`);
    releaseFleet();
    process.exit(130);
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => onSignal(s));
  process.on('exit', () => { if (ctx.nodes.length || !tmpRemoved) releaseFleet(); });
  process.on('uncaughtException', (e) => { process.stderr.write(`${e?.stack || e}\n`); releaseFleet(); process.exit(1); });
  process.on('unhandledRejection', (e) => { process.stderr.write(`${e?.stack || e}\n`); releaseFleet(); process.exit(1); });

  const stray = countStrayNodes(MAIN);
  if (cmd !== 'info' && stray) {
    say(`найдено ${stray} узлов LT- от прежнего запуска стенда, останавливаю`);
    killStrayNodes(MAIN);
  }
  if (cmd !== 'info') removeStaleData();

  await writeInfo();
  let ramp = null;
  if (cmd === 'ramp' || cmd === 'all') {
    ramp = await runPhase('ramp', cmdRamp).catch((e) => { crashRow('ramp.jsonl', e); say(`[ramp] сбой стенда: ${e.message}`); return null; });
  }
  if (cmd === 'storm' || cmd === 'all') {
    const N = o.nodes ?? (cmd === 'all' ? Math.min(400, Math.max(10, ramp?.lastGood ?? 50)) : 50);
    const K = cmd === 'all' && o.nodes == null ? Math.max(o.victims, Math.round(N * 0.02)) : o.victims;
    await runPhase('storm', () => cmdStorm(N, K)).catch((e) => { crashRow('storm.jsonl', e); say(`[storm] сбой стенда: ${e.message}`); });
  }
  if (cmd === 'soak' || cmd === 'all') {
    const N = o.nodes ?? (cmd === 'all' ? Math.min(300, Math.max(10, ramp?.lastGood ?? 20)) : 20);
    const M = o.minutes ?? (cmd === 'all' ? 30 : 10);
    await runPhase('soak', () => cmdSoak(N, M)).catch((e) => { crashRow('soak.jsonl', e); say(`[soak] сбой стенда: ${e.message}`); });
  }
  if (cmd !== 'info') {
    fs.writeFileSync(path.join(o.out, 'report.md'), buildReport(o.out));
    say(`отчёт: ${path.join(o.out, 'report.md')}`);
  }
}

main().then(() => process.exit(0), (e) => { process.stderr.write(`${e?.stack || e}\n`); releaseFleet(); process.exit(1); });
