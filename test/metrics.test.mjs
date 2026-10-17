// Метрики Prometheus: формат, значения, доступ.
//   node --test test/metrics.test.mjs

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderMetrics, escapeLabel } from '../src/core/metrics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------ разбор формата

/** Строгий разбор текста Prometheus: ловит повторы серий, метки без экранирования, пропущенный TYPE. */
export function parseExposition(text) {
  const families = new Map();
  const samples = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let m;
    if ((m = /^# HELP (\S+) (.*)$/.exec(line))) {
      assert.ok(!families.has(m[1]) || !families.get(m[1]).help, `HELP дважды: ${m[1]}`);
      families.set(m[1], { ...(families.get(m[1]) || {}), help: m[2] });
      continue;
    }
    if ((m = /^# TYPE (\S+) (gauge|counter)$/.exec(line))) {
      assert.ok(!families.get(m[1])?.type, `TYPE дважды: ${m[1]}`);
      families.set(m[1], { ...(families.get(m[1]) || {}), type: m[2] });
      continue;
    }
    m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{((?:[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*",?)*)\})? (-?[0-9.e+-]+|NaN|\+Inf|-Inf)$/.exec(line);
    assert.ok(m, `строка не в формате Prometheus: ${line}`);
    const [, name, rawLabels = '', value] = m;
    assert.ok(families.get(name)?.type, `у ${name} нет TYPE до первой серии`);
    const labels = {};
    for (const lm of rawLabels.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[lm[1]] = lm[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    const key = `${name}{${rawLabels}}`;
    assert.ok(!seen.has(key), `серия повторяется: ${key}`);
    seen.add(key);
    samples.push({ name, labels, value: Number(value) });
  }
  return { families, samples };
}

const find = (samples, name, labels = {}) => samples.filter((s) => s.name === name
  && Object.entries(labels).every(([k, v]) => s.labels[k] === v));
const one = (samples, name, labels) => {
  const r = find(samples, name, labels);
  assert.equal(r.length, 1, `${name} ${JSON.stringify(labels)}: серий ${r.length}`);
  return r[0].value;
};

// ------------------------------------------------------------------ фикстура

const NOW = Date.now();
const dev = (id, over = {}) => ({
  deviceId: `usb:${id}`, type: 'usb', title: id, description: `Устройство ${id}`, shared: true, bindState: 'bound',
  meta: { vendorId: '1c75', productId: '02cb' }, claim: null, traffic: null, ...over,
});

function fakeApp() {
  const busyClaim = (holderId, holderName, extra = {}) => ({
    holderId, holderName, since: NOW - 120000, mode: 'remote', holderSilentMs: 3000, leaseMs: 30000, ...extra,
  });
  const traffic = (inRate, outRate, inTotal, outTotal) => ({
    bytesInPerMinute: inRate, bytesOutPerMinute: outRate, totalIn: inTotal, totalOut: outTotal,
    connections: 2, lastActivity: NOW - 5000,
  });
  return {
    version: '2.2.0',
    startedAt: NOW - 3600000,
    backend: { name: 'windows' },
    backendInfo: { server: true, client: true },
    network: { cidr: '192.168.88.0/24', address: '192.168.88.11' },
    traffic: {},
    autostartState: { enabled: true },
    config: { get: (k) => ({ nodeId: 'me', name: 'Мой "узел"\nтест', apiPort: 47812 }[k]) },
    share: {
      listAll: () => [
        dev('1-1', { claim: busyClaim('piano', 'PIANO-PC'), traffic: traffic(1000, 500, 90000, 40000) }),
        dev('1-2', { shared: false }),
        { ...dev('1-3'), type: 'net', deviceId: 'net:Ethernet', title: 'Ethernet' },
      ],
      listGroups: () => [{ id: 'g1', name: 'Стенд', members: ['usb:1-1'], shared: true, claim: null }],
    },
    peers: {
      list: () => [{
        nodeId: 'piano', name: 'PIANO-PC', online: true, address: '192.168.88.15', apiPort: 47812, platform: 'win32',
        version: '2.2.0', startedAt: NOW - 600000, lastSeen: NOW - 4000, network: '192.168.88.0/24', origin: 'local', realm: null,
        devices: [
          dev('3-2', { claim: busyClaim('me', 'Мой "узел"\nтест', { mode: 'remote' }), traffic: traffic(2000, 3000, 70000, 80000) }),
          dev('3-3'),
        ],
        groups: [], requests: [],
      }, {
        nodeId: 'dead', name: 'ОФФЛАЙН', online: false, address: '192.168.88.99', apiPort: 47812, platform: 'linux',
        version: '2.1.0', startedAt: null, lastSeen: NOW - 600000, network: null, origin: 'seed', realm: 'r1',
        devices: [], groups: [], stateError: 'таймаут', requests: [],
      }],
    },
    attach: {
      list: () => [{
        id: 'piano|usb:3-2', nodeId: 'piano', nodeName: 'PIANO-PC', target: 'usb:3-2', title: 'Scarlett Solo',
        state: 'attached', since: NOW - 60000, attachedAt: NOW - 50000, lastHeartbeat: NOW - 3000,
      }],
      pendingRequests: () => [{ id: 'q1' }],
    },
    updater: { snapshot: () => ({ running: '2.2.0', mode: 'auto', phase: 'idle', supported: true, staged: null, failed: [{}], reported: [], trial: false }) },
  };
}

// -------------------------------------------------------------------- тесты

test('формат: HELP и TYPE один раз, серии не повторяются, метки экранируются', () => {
  const text = renderMetrics(fakeApp());
  const { families, samples } = parseExposition(text);
  assert.ok(samples.length > 60, `серий: ${samples.length}`);
  for (const [name, f] of families) assert.ok(f.help && f.type, `у ${name} нет HELP или TYPE`);
  // имя узла с кавычкой и переводом строки не ломает разбор и читается обратно
  const info = find(samples, 'nds_build_info')[0];
  assert.equal(info.labels.node, 'Мой "узел"\nтест');
  assert.equal(escapeLabel('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
});

test('этот узел: сведения, возможности, процесс, время сбора', () => {
  const { samples } = parseExposition(renderMetrics(fakeApp()));
  assert.equal(find(samples, 'nds_build_info')[0].labels.version, '2.2.0');
  assert.equal(one(samples, 'nds_backend_capability', { capability: 'server' }), 1);
  assert.equal(one(samples, 'nds_traffic_meter_enabled', {}), 1);
  assert.ok(one(samples, 'process_resident_memory_bytes', {}) > 1e6);
  assert.ok(one(samples, 'process_cpu_seconds_total', {}) >= 0);
  assert.ok(one(samples, 'nds_scrape_duration_seconds', {}) >= 0);
});

test('статистика по узлам: каждый узел сети, включая этот и неотвечающий', () => {
  const { samples } = parseExposition(renderMetrics(fakeApp()));
  assert.equal(one(samples, 'nds_nodes', { state: 'online' }), 2);
  assert.equal(one(samples, 'nds_nodes', { state: 'offline' }), 1);

  // этот узел: 3 локальных устройства (2 отмечены «опубликовать»), одно занято, один держатель
  assert.equal(one(samples, 'nds_node_up', { node_id: 'me' }), 1);
  assert.equal(one(samples, 'nds_node_last_seen_age_seconds', { node_id: 'me' }), 0);
  assert.equal(one(samples, 'nds_node_devices', { node_id: 'me', scope: 'all' }), 3);
  assert.equal(one(samples, 'nds_node_devices_busy', { node_id: 'me' }), 1);
  assert.equal(one(samples, 'nds_node_devices_by_type', { node_id: 'me', type: 'usb' }), 2);
  assert.equal(one(samples, 'nds_node_devices_by_type', { node_id: 'me', type: 'net' }), 1);
  assert.equal(one(samples, 'nds_node_holders', { node_id: 'me' }), 1);
  assert.equal(one(samples, 'nds_node_groups', { node_id: 'me' }), 1);
  assert.equal(one(samples, 'nds_node_local_devices_shared', { node_id: 'me' }), 2);

  // сосед
  assert.equal(one(samples, 'nds_node_up', { node_id: 'piano' }), 1);
  assert.equal(one(samples, 'nds_node_devices', { node_id: 'piano', scope: 'published' }), 2);
  assert.equal(one(samples, 'nds_node_devices_busy', { node_id: 'piano' }), 1);
  assert.equal(one(samples, 'nds_node_devices_free', { node_id: 'piano' }), 1);
  assert.ok(Math.abs(one(samples, 'nds_node_last_seen_age_seconds', { node_id: 'piano' }) - 4) < 3);
  assert.ok(Math.abs(one(samples, 'nds_node_uptime_seconds', { node_id: 'piano' }) - 600) < 5);
  assert.equal(find(samples, 'nds_node_info', { node_id: 'piano' })[0].labels.version, '2.2.0');

  // неотвечающий: не отвечает, аптайм 0, ошибка состояния
  assert.equal(one(samples, 'nds_node_up', { node_id: 'dead' }), 0);
  assert.equal(one(samples, 'nds_node_uptime_seconds', { node_id: 'dead' }), 0);
  assert.equal(one(samples, 'nds_node_state_error', { node_id: 'dead' }), 1);
  assert.ok(one(samples, 'nds_node_last_seen_age_seconds', { node_id: 'dead' }) > 500);
});

test('трафик узла как владельца — сумма по его устройствам, в обе стороны', () => {
  const { samples } = parseExposition(renderMetrics(fakeApp()));
  assert.equal(one(samples, 'nds_node_traffic_bytes_per_minute', { node_id: 'me', direction: 'in' }), 1000);
  assert.equal(one(samples, 'nds_node_traffic_bytes_per_minute', { node_id: 'me', direction: 'out' }), 500);
  assert.equal(one(samples, 'nds_node_traffic_session_bytes', { node_id: 'piano', direction: 'in' }), 70000);
  assert.equal(one(samples, 'nds_node_traffic_session_bytes', { node_id: 'piano', direction: 'out' }), 80000);
});

test('устройства: владелец, кто занял, сколько занято, трафик и ошибки', () => {
  const { samples } = parseExposition(renderMetrics(fakeApp()));
  const d = { owner_id: 'me', device_id: 'usb:1-1' };
  assert.equal(one(samples, 'nds_device_busy', d), 1);
  assert.equal(one(samples, 'nds_device_busy', { owner_id: 'me', device_id: 'usb:1-2' }), 0);
  const claim = find(samples, 'nds_device_claim_info', d)[0];
  assert.equal(claim.labels.holder, 'PIANO-PC');
  assert.equal(claim.labels.mode, 'remote');
  assert.ok(Math.abs(one(samples, 'nds_device_claim_age_seconds', d) - 120) < 3);
  assert.equal(one(samples, 'nds_device_holder_silent_seconds', d), 3);
  assert.equal(one(samples, 'nds_device_traffic_bytes_per_minute', { ...d, direction: 'in' }), 1000);
  assert.equal(one(samples, 'nds_device_connections', d), 2);
  assert.equal(find(samples, 'nds_device_info', { device_id: 'usb:1-2' })[0].labels.shared, 'false');
  assert.equal(find(samples, 'nds_device_info', { device_id: 'usb:1-1' })[0].labels.vendor_id, '1c75');
  // устройство соседа, которое занял мы
  assert.equal(find(samples, 'nds_device_claim_info', { owner_id: 'piano', device_id: 'usb:3-2' })[0].labels.holder_id, 'me');
});

test('занявшие (клиенты): сколько устройств держит каждый и сколько гонит трафика', () => {
  const { samples } = parseExposition(renderMetrics(fakeApp()));
  assert.equal(one(samples, 'nds_holder_devices', { holder_id: 'piano' }), 1);
  assert.equal(one(samples, 'nds_holder_devices', { holder_id: 'me' }), 1);
  assert.equal(one(samples, 'nds_holder_traffic_bytes_per_minute', { holder_id: 'me', direction: 'out' }), 3000);
  assert.equal(one(samples, 'nds_holder_traffic_session_bytes', { holder_id: 'piano', direction: 'in' }), 90000);
});

test('подключения этого узла, группы, запросы и обновление', () => {
  const { samples } = parseExposition(renderMetrics(fakeApp()));
  assert.equal(one(samples, 'nds_attachment_state', { target: 'usb:3-2', state: 'attached' }), 1);
  assert.equal(one(samples, 'nds_attachments_attached', {}), 1);
  assert.ok(one(samples, 'nds_attachment_heartbeat_age_seconds', { target: 'usb:3-2' }) < 5);
  assert.equal(one(samples, 'nds_group_members', { group_id: 'g1' }), 1);
  assert.equal(one(samples, 'nds_requests_incoming_pending', {}), 1);
  assert.equal(find(samples, 'nds_update_info')[0].labels.phase, 'idle');
  assert.equal(one(samples, 'nds_update_failed_versions', {}), 1);
});

// ----------------------------------------------------------- доступ (настоящие узлы)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-metrics-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));
let port = 48700 + Math.floor(Math.random() * 100) * 10;

function startNode(name, { extraArgs = [], config = {} } = {}) {
  const p = port; port += 10;
  const home = path.join(work, `${name}-${p}`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    name, apiPort: p, trafficPort: p + 1, netLinkPort: p + 2, usbipPort: p + 3,
    discoveryPort: 47921, announceIntervalMs: 1000, announceIdleIntervalMs: 2000, autoInstall: false, ...config,
  }));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'main.js'), '--backend', 'mock', '--no-open', ...extraArgs], {
    env: { ...process.env, NDS_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { name, port: p, home, child, get log() { return log; } };
}

function get(node, urlPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: node.port, path: urlPath, method, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function ready(node) {
  for (let i = 0; i < 80; i++) {
    try { const r = await get(node, '/api/v1/session'); if (r.status === 200) return; } catch { /* ещё поднимается */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`узел ${node.name} не поднялся:\n${node.log.slice(-1500)}`);
}

const kill = (...nodes) => { for (const n of nodes) { try { n.child.kill(); } catch { /* */ } } };

test('по умолчанию метрики выключены: /metrics отвечает 404', { timeout: 60000 }, async () => {
  const n = startNode('off');
  try {
    await ready(n);
    const r = await get(n, '/metrics');
    assert.equal(r.status, 404);
  } finally { kill(n); }
});

test('--metrics включает метрики на запуск; без токена — из рабочей сети, формат верный', { timeout: 60000 }, async () => {
  const n = startNode('on', { extraArgs: ['--metrics'] });
  try {
    await ready(n);
    const r = await get(n, '/metrics');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/plain; version=0\.0\.4/);
    const { samples } = parseExposition(r.body);
    assert.equal(find(samples, 'nds_build_info')[0].labels.node, 'on');
    assert.equal((await get(n, '/metrics', {}, 'POST')).status, 405);
    assert.equal((await get(n, '/metrics', {}, 'HEAD')).status, 200);
    // флаг не записан в настройки: следующий запуск вернётся к «выключено»
    assert.ok(!fs.readFileSync(path.join(n.home, 'config.json'), 'utf8').includes('"metricsEnabled":true'));
  } finally { kill(n); }
});

test('токен: без него 401, с неверным 401, с верным 200', { timeout: 60000 }, async () => {
  const token = 'tok_0123456789abcdef0123456789abcdef';
  const n = startNode('tok', { extraArgs: ['--metrics', '--metrics-token', token] });
  try {
    await ready(n);
    const noToken = await get(n, '/metrics');
    assert.equal(noToken.status, 401);
    assert.match(noToken.headers['www-authenticate'], /Bearer/);
    assert.equal((await get(n, '/metrics', { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await get(n, '/metrics', { authorization: `Bearer ${token}` })).status, 200);
    assert.equal((await get(n, '/metrics?token=' + token)).status, 401, 'токен в адресе не принимается — он попал бы в журналы');
  } finally { kill(n); }
});

test('настройки в интерфейсе: включение и токен; токен хранится хешем, а не открытым', { timeout: 60000 }, async () => {
  const n = startNode('cfg');
  const token = 'abcdefghijklmnopqrstuvwxyz012345';
  try {
    await ready(n);
    const post = (body) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: n.port, path: '/api/v1/settings', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nds-ui': '1', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject);
      req.end(data);
    });

    assert.equal((await post({ metricsToken: 'короткий' })).status, 400, 'плохой токен отвергается');
    const ok = await post({ metricsEnabled: true, metricsToken: token });
    assert.equal(ok.status, 200, ok.body);
    assert.equal((await get(n, '/metrics')).status, 401);
    assert.equal((await get(n, '/metrics', { authorization: `Bearer ${token}` })).status, 200);

    const saved = fs.readFileSync(path.join(n.home, 'config.json'), 'utf8');
    assert.ok(!saved.includes(token), 'открытого токена в файле настроек нет');
    assert.ok(saved.includes('"metricsEnabled": true') || saved.includes('"metricsEnabled":true'));

    // токен не отдаётся наружу, виден только факт «задан»
    const state = JSON.parse((await get(n, '/api/v1/state', { 'x-nds-ui': '1' })).body);
    assert.equal(state.config.metricsTokenSet, true);
    assert.ok(!JSON.stringify(state).includes(token));

    // снять токен → снова только из рабочей сети (мы с этого же компьютера)
    assert.equal((await post({ metricsToken: '' })).status, 200);
    assert.equal((await get(n, '/metrics')).status, 200);
    // выключить → 404
    assert.equal((await post({ metricsEnabled: false })).status, 200);
    assert.equal((await get(n, '/metrics')).status, 404);
  } finally { kill(n); }
});

test('один узел отдаёт статистику всей сети: сосед виден с его устройствами', { timeout: 90000 }, async () => {
  const a = startNode('NODE-A', { extraArgs: ['--metrics'] });
  const b = startNode('NODE-B');
  try {
    await Promise.all([ready(a), ready(b)]);
    let samples = [];
    for (let i = 0; i < 40; i++) {
      ({ samples } = parseExposition((await get(a, '/metrics')).body));
      if (find(samples, 'nds_node_up', { node: 'NODE-B' }).length) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(one(samples, 'nds_node_up', { node: 'NODE-B' }), 1, 'узел B виден с узла A');
    assert.equal(one(samples, 'nds_node_up', { node: 'NODE-A' }), 1);
    assert.equal(one(samples, 'nds_nodes', { state: 'online' }), 2);
    assert.ok(one(samples, 'nds_node_uptime_seconds', { node: 'NODE-B' }) >= 0);
    assert.ok(find(samples, 'nds_node_info', { node: 'NODE-B' })[0].labels.address);
  } finally { kill(a, b); }
});

// --------------------------------------------------------------- дашборд Grafana

const DASHBOARD = path.join(ROOT, 'docs', 'grafana', 'net-device-share.json');

test('дашборд Grafana: корректный JSON, панели без наложений, запросы только к существующим метрикам', () => {
  const d = JSON.parse(fs.readFileSync(DASHBOARD, 'utf8'));
  assert.equal(d.uid, 'net-device-share');
  assert.equal(d.__inputs[0].name, 'DS_PROMETHEUS');

  // переменные, которыми пользуются запросы, существуют
  const vars = new Set(d.templating.list.map((v) => v.name));
  assert.deepEqual([...vars].sort(), ['instance', 'node']);

  const ids = new Set();
  const boxes = [];
  const exprs = [];
  for (const p of d.panels) {
    assert.ok(!ids.has(p.id), `повтор id панели ${p.id}`);
    ids.add(p.id);
    const g = p.gridPos;
    assert.ok(g.x >= 0 && g.w > 0 && g.x + g.w <= 24, `панель «${p.title}» выходит за ширину`);
    boxes.push({ title: p.title || p.type, ...g });
    for (const t of p.targets || []) {
      assert.ok(t.expr && t.refId, `у панели «${p.title}» пустой запрос`);
      exprs.push(t.expr);
    }
  }
  // наложения
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `панели «${a.title}» и «${b.title}» накладываются`);
    }
  }

  // каждая метрика из запросов реально отдаётся приложением (по фикстуре со всеми видами сведений)
  const { families } = parseExposition(renderMetrics(fakeApp()));
  const used = new Set();
  for (const e of exprs) for (const m of e.matchAll(/\b((?:nds|process|nodejs)_[a-z_]+)\b/g)) used.add(m[1]);
  assert.ok(used.size >= 30, `метрик в запросах: ${used.size}`);
  for (const name of used) assert.ok(families.has(name), `дашборд ждёт метрику ${name}, а приложение её не отдаёт`);

  // переменные в запросах только известные
  for (const e of exprs) for (const m of e.matchAll(/\$([a-z_]+)/g)) assert.ok(vars.has(m[1]), `неизвестная переменная $${m[1]} в запросе: ${e}`);
});

test('дашборд собран из актуального генератора (файл в репозитории не устарел)', async () => {
  const before = fs.readFileSync(DASHBOARD, 'utf8');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-grafana-dashboard.mjs')], { stdio: 'ignore' });
  assert.equal(fs.readFileSync(DASHBOARD, 'utf8'), before, 'выполните node scripts/build-grafana-dashboard.mjs и закоммитьте результат');
});

test('документация: каждая отдаваемая метрика описана в docs/METRICS.md', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'METRICS.md'), 'utf8');
  const { families } = parseExposition(renderMetrics(fakeApp()));
  const missing = [...families.keys()].filter((n) => !doc.includes(n));
  assert.deepEqual(missing, [], 'не описаны в METRICS.md');
});
