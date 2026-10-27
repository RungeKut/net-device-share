// Системная часть нагрузочного стенда (scripts/loadtest.mjs): PowerShell и CIM,
// процессор машины, проверка портов, остановка процессов. Только Windows.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';

export const PORT_LIMIT = 65000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
export const freeMb = () => Math.round(os.freemem() / 1048576);

export function pct(arr, q) {
  const s = arr.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
}

/** Параллелизм ограничен: иначе сам стенд забивает сокеты и сам становится узким местом. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ------------------------------------------------------------------ PowerShell

// -EncodedCommand: скрипт не проходит через разбор кавычек командной строки,
// а её длина на Windows ограничена.
function psArgs(script) {
  const pre = "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;";
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(pre + script, 'utf16le').toString('base64')];
}

export function runPs(script, { timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawn('powershell.exe', psArgs(script), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      resolve({ ok: false, stdout: '', error: e.message });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* уже завершился */ } }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, stdout, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout }); });
  });
}

export async function psJson(script, opts) {
  const r = await runPs(script, opts);
  const text = r.stdout.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// ------------------------------------------------------------------ процессор

export function cpuTimes() {
  return os.cpus().reduce((a, c) => {
    const t = c.times;
    a.user += t.user + t.nice; a.sys += t.sys; a.idle += t.idle; a.irq += t.irq;
    return a;
  }, { user: 0, sys: 0, idle: 0, irq: 0 });
}

// Время прерываний Windows входит в kernel, поэтому в знаменатель irq не кладём.
export function cpuDelta(a, b) {
  const total = (b.user - a.user) + (b.sys - a.sys) + (b.idle - a.idle);
  if (total <= 0) return null;
  const p = (x) => round((100 * x) / total, 1);
  return {
    busyPct: round(100 * (1 - (b.idle - a.idle) / total), 1),
    userPct: p(b.user - a.user),
    kernelPct: p(b.sys - a.sys),
    irqPct: p(b.irq - a.irq),
  };
}

// ------------------------------------------------------------------ окно измерения

// Один PowerShell на окно: снимок процессов, серия сэмплов CIM, снимок процессов.
// Процессор машины сверяется в момент прихода строк снимков, чтобы окна
// os.cpus() и Get-Process совпадали, а не расходились на время запуска PowerShell.
// Один запрос Formatted-класса занимает ~0,3 с, поэтому цикл идёт без пауз,
// пока не пройдёт заданное время (но не меньше трёх сэмплов).
function windowScript(seconds) {
  return `
function Snap($k){
  $p=@(Get-Process -Name node | Select-Object Id,CPU,WorkingSet64,HandleCount,@{n='Th';e={$_.Threads.Count}})
  [ordered]@{k=$k;t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();procs=$p} | ConvertTo-Json -Depth 3 -Compress
}
Snap 'p0'
$sw=[Diagnostics.Stopwatch]::StartNew()
$i=0
while($i -lt 3 -or $sw.Elapsed.TotalSeconds -lt ${seconds}){
  $i++
  $s=[ordered]@{k='n';t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
  $s.udp=@(Get-CimInstance Win32_PerfFormattedData_Tcpip_UDPv4 | Select-Object DatagramsReceivedPersec,DatagramsSentPersec,DatagramsReceivedErrors,DatagramsNoPortPersec)
  $s.tcp=@(Get-CimInstance Win32_PerfFormattedData_Tcpip_TCPv4 | Select-Object ConnectionsEstablished,ConnectionFailures,SegmentsRetransmittedPersec)
  $s.nic=@(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Select-Object Name,PacketsPersec,BytesTotalPersec,PacketsReceivedDiscarded,OutputQueueLength)
  $s.sys=@(Get-CimInstance Win32_PerfFormattedData_PerfOS_System | Select-Object ProcessorQueueLength)
  $s.os=@(Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize)
  $s | ConvertTo-Json -Depth 4 -Compress
}
Snap 'p1'
`;
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : Number(x) || 0);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * Сэмплы CIM → сводка. Persec-поля в Formatted-классах — готовые скорости, по
 * ним берём среднее (первый сэмпл отбрасывается: его скорость считается от
 * неизвестного прошлого); накопительные счётчики — разность последнего и первого.
 */
export function summarizeNet(samples) {
  if (!samples.length) return null;
  const rate = samples.length > 1 ? samples.slice(1) : samples;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const f = (s, cls, field) => num(s[cls]?.[0]?.[field]);
  const delta = (cls, field) => Math.max(0, f(last, cls, field) - f(first, cls, field));
  const meanOf = (cls, field) => round(avg(rate.map((s) => f(s, cls, field))), 1);

  const nicNames = new Set();
  for (const s of samples) for (const n of s.nic || []) nicNames.add(n.Name);
  const nics = [...nicNames].map((name) => {
    const at = (s) => (s.nic || []).find((n) => n.Name === name) || {};
    return {
      name,
      packetsPerSec: round(avg(rate.map((s) => num(at(s).PacketsPersec))), 0),
      bytesPerSec: round(avg(rate.map((s) => num(at(s).BytesTotalPersec))), 0),
      discardedDelta: Math.max(0, num(at(last).PacketsReceivedDiscarded) - num(at(first).PacketsReceivedDiscarded)),
      queueMax: Math.max(0, ...samples.map((s) => num(at(s).OutputQueueLength))),
    };
  }).sort((a, b) => b.bytesPerSec - a.bytesPerSec);

  const queues = rate.map((s) => f(s, 'sys', 'ProcessorQueueLength'));
  const freeKb = samples.map((s) => f(s, 'os', 'FreePhysicalMemory')).filter((x) => x > 0);
  return {
    samples: samples.length,
    udpRecvPerSec: meanOf('udp', 'DatagramsReceivedPersec'),
    udpSentPerSec: meanOf('udp', 'DatagramsSentPersec'),
    udpRecvErrors: delta('udp', 'DatagramsReceivedErrors'),
    udpNoPortPerSec: meanOf('udp', 'DatagramsNoPortPersec'),
    tcpEstablished: round(avg(rate.map((s) => f(s, 'tcp', 'ConnectionsEstablished'))), 0),
    tcpFailures: delta('tcp', 'ConnectionFailures'),
    tcpRetransPerSec: meanOf('tcp', 'SegmentsRetransmittedPersec'),
    nicPacketsPerSec: round(nics.reduce((a, n) => a + n.packetsPerSec, 0), 0),
    nicBytesPerSec: round(nics.reduce((a, n) => a + n.bytesPerSec, 0), 0),
    nicDiscarded: nics.reduce((a, n) => a + n.discardedDelta, 0),
    nicQueueMax: Math.max(0, ...nics.map((n) => n.queueMax)),
    procQueueAvg: round(avg(queues), 1),
    procQueueMax: Math.max(0, ...queues),
    cimFreeMb: freeKb.length ? Math.round(freeKb[freeKb.length - 1] / 1024) : null,
    nics: nics.slice(0, 4),
  };
}

/**
 * Окно измерения: процессор машины, процессы стенда (по запомненным PID),
 * сеть. PID фильтруются здесь, а не в PowerShell: список из сотен PID не
 * влезает в командную строку.
 */
export function measureWindow(pidSet, seconds = 10) {
  return new Promise((resolve) => {
    const samples = [];
    const snaps = {};
    let cpu0 = null;
    let cpu1 = null;
    let buf = '';
    let child;
    try {
      child = spawn('powershell.exe', psArgs(windowScript(seconds)), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* уже завершился */ } }, (seconds + 300) * 1000);
    const onLine = (line) => {
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.k === 'p0') { snaps.p0 = o; cpu0 = cpuTimes(); }
      else if (o.k === 'p1') { snaps.p1 = o; cpu1 = cpuTimes(); }
      else if (o.k === 'n') samples.push(o);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    });
    const done = () => {
      clearTimeout(timer);
      if (buf.trim()) onLine(buf.trim());
      if (!snaps.p0 || !snaps.p1 || !cpu0 || !cpu1) { resolve({ cpu: null, proc: null, net: summarizeNet(samples) }); return; }
      resolve(digest(snaps, cpu0, cpu1, samples, typeof pidSet === 'function' ? pidSet() : pidSet));
    };
    child.on('error', done);
    child.on('close', done);
  });
}

function digest(snaps, cpu0, cpu1, samples, pidSet) {
  const mine = (s) => asArray(s.procs).filter((p) => pidSet.has(p.Id));
  const a = new Map(mine(snaps.p0).map((p) => [p.Id, p]));
  const b = mine(snaps.p1);
  const dt = Math.max(0.5, (snaps.p1.t - snaps.p0.t) / 1000);
  let cpuSec = 0;
  // Процесс, которого не было в первом снимке, запущен внутри окна: его время целиком принадлежит окну.
  for (const p of b) { const q = a.get(p.Id); cpuSec += Math.max(0, num(p.CPU) - (q ? num(q.CPU) : 0)); }
  const logical = os.cpus().length;
  const ws = b.map((p) => num(p.WorkingSet64) / 1048576);
  const handles = b.reduce((x, p) => x + num(p.HandleCount), 0);
  const threads = b.reduce((x, p) => x + num(p.Th), 0);
  const n = Math.max(1, b.length);
  return {
    cpu: cpuDelta(cpu0, cpu1),
    proc: {
      count: b.length,
      cpuPctOfMachine: round((100 * cpuSec) / (dt * logical), 1),
      perNodeCpuPctOfCore: round((100 * cpuSec) / dt / n, 2),
      rssTotalMb: round(ws.reduce((x, y) => x + y, 0), 0),
      rssAvgMb: round(ws.reduce((x, y) => x + y, 0) / n, 1),
      handlesTotal: handles,
      handlesAvg: round(handles / n, 0),
      threadsTotal: threads,
      threadsAvg: round(threads / n, 1),
    },
    net: summarizeNet(samples),
  };
}

// ------------------------------------------------------------------ порты

function canListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** Занятым считаем любой отказ bind, включая EACCES на зарезервированных Hyper-V диапазонах. */
export async function portsFree(first, count = 4) {
  const r = await Promise.all(Array.from({ length: count }, (_, i) => canListen(first + i)));
  return r.every(Boolean);
}

// ------------------------------------------------------------------ остановка процессов

function taskkillChunks(pids) {
  const list = [...pids];
  for (let i = 0; i < list.length; i += 80) {
    const args = ['/T', '/F'];
    for (const p of list.slice(i, i + 80)) args.push('/PID', String(p));
    spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
  }
}

export function killPids(pids) {
  if (pids.length) taskkillChunks(pids);
}

/**
 * Страховка на случай, когда стенд потерял PID (упал и запущен заново):
 * только процессы node с «--name LT-NNNN» и main.js этого репозитория.
 * Чужие node.exe не совпадают ни по имени, ни по пути.
 */
export function killStrayNodes(mainJs) {
  const esc = mainJs.replace(/'/g, "''");
  const script = `
$p='${esc}'.Replace('\\','/')
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $c=$_.CommandLine; $c -and ($c -match '--name LT-\\d{4,}') -and ($c.Replace('\\','/').IndexOf($p,[StringComparison]::OrdinalIgnoreCase) -ge 0)
} | ForEach-Object { $_.ProcessId }
`;
  const r = spawnSync('powershell.exe', psArgs(script), { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const pids = (r.stdout || '').split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => n > 0);
  killPids(pids);
  return pids.length;
}

export function countStrayNodes(mainJs) {
  const esc = mainJs.replace(/'/g, "''");
  const script = `
$p='${esc}'.Replace('\\','/')
@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $c=$_.CommandLine; $c -and ($c -match '--name LT-\\d{4,}') -and ($c.Replace('\\','/').IndexOf($p,[StringComparison]::OrdinalIgnoreCase) -ge 0)
}).Count
`;
  const r = spawnSync('powershell.exe', psArgs(script), { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return Number((r.stdout || '').trim()) || 0;
}

// ------------------------------------------------------------------ сведения о машине

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  return r.stdout || '';
}

// Выводы netsh и netstat локализованы, поэтому разбираем только числа, а не слова.
function dynamicPortRange() {
  const nums = [];
  for (const line of run('netsh', ['int', 'ipv4', 'show', 'dynamicport', 'tcp']).split(/\r?\n/)) {
    const m = /:\s*(\d+)\s*$/.exec(line);
    if (m) nums.push(Number(m[1]));
  }
  if (nums.length < 2) return null;
  return { start: nums[0], count: nums[1], end: nums[0] + nums[1] - 1 };
}

function excludedRanges() {
  const out = [];
  for (const line of run('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp']).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*\*?\s*$/.exec(line);
    if (m) out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

function usedTcpPorts() {
  const used = new Set();
  for (const line of run('netstat', ['-ano', '-p', 'tcp']).split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S*:(\d+)\s/.exec(line);
    if (m) used.add(Number(m[1]));
  }
  return used;
}

export function portPlan(basePort) {
  const excluded = excludedRanges();
  const used = usedTcpPorts();
  const blocked = (p) => used.has(p) || excluded.some(([a, b]) => p >= a && p <= b);
  let freeSlots = 0;
  for (let p = basePort; p + 3 <= PORT_LIMIT; p += 4) {
    if (!blocked(p) && !blocked(p + 1) && !blocked(p + 2) && !blocked(p + 3)) freeSlots++;
  }
  return { excluded, usedCount: used.size, freeSlots, slotsTotal: Math.floor((PORT_LIMIT - basePort + 1) / 4) };
}

export async function collectInfo(basePort) {
  const script = `
$o=[ordered]@{}
$o.os=@(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSLanguage,TotalVisibleMemorySize,FreePhysicalMemory)
$o.cpu=@(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors)
$d=Get-MpComputerStatus
if($d){$o.defender=[ordered]@{antivirus=$d.AntivirusEnabled;realtime=$d.RealTimeProtectionEnabled;tamper=$d.IsTamperProtected}}
$o.nodeProcs=@(Get-Process -Name node).Count
$o | ConvertTo-Json -Depth 4 -Compress
`;
  const j = (await psJson(script)) || {};
  const osr = asArray(j.os)[0] || {};
  const cpus = asArray(j.cpu);
  const plan = portPlan(basePort);
  return {
    collectedAt: new Date().toISOString(),
    hostname: os.hostname(),
    node: process.version,
    windows: { caption: osr.Caption || null, version: osr.Version || null, build: osr.BuildNumber || null, osLanguage: osr.OSLanguage ?? null },
    cpu: {
      model: cpus[0]?.Name?.trim() || os.cpus()[0]?.model || null,
      sockets: cpus.length || null,
      physicalCores: cpus.reduce((a, c) => a + num(c.NumberOfCores), 0) || null,
      logicalProcessors: os.cpus().length,
    },
    memory: { totalMb: Math.round(os.totalmem() / 1048576), freeMb: freeMb() },
    defender: j.defender
      ? { realtimeProtection: j.defender.realtime ?? null, antivirus: j.defender.antivirus ?? null, tamperProtection: j.defender.tamper ?? null }
      : null,
    dynamicPortRange: dynamicPortRange(),
    ports: { basePort, ...plan },
    nodeProcessesNow: num(j.nodeProcs),
  };
}
