#!/usr/bin/env node
// Дашборд Grafana для метрик Net Device Share → docs/grafana/net-device-share.json
//
//   node scripts/build-grafana-dashboard.mjs
//
// JSON собирается скриптом, а не набирается руками: так панели, переменные и
// запросы остаются согласованными (тест проверяет, что каждая метрика из запросов
// действительно отдаётся приложением). Готовый файл лежит в репозитории — импортируйте
// его в Grafana: Dashboards → New → Import → Upload JSON file, источник — Prometheus.
//
// Выбор узла-наблюдателя (переменная instance): каждый узел отдаёт всю сеть, поэтому
// если Prometheus опрашивает несколько узлов, панели берут данные одного, а не складывают
// одно и то же несколько раз.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'grafana', 'net-device-share.json');

const DS = { type: 'prometheus', uid: '${DS_PROMETHEUS}' };
const I = 'instance="$instance"';
const N = `${I}, node=~"$node"`;

let nextId = 1;
const panels = [];
let y = 0;

const green = { color: 'green', value: null };
const target = (expr, legend, refId = 'A', extra = {}) => ({ datasource: DS, editorMode: 'code', expr, legendFormat: legend, refId, ...extra });

function place(h, w, x, panel) {
  panel.id = nextId++;
  panel.gridPos = { h, w, x, y };
  panel.datasource = panel.datasource || DS;
  panels.push(panel);
  return panel;
}

function row(title) {
  const p = { type: 'row', title, collapsed: false, panels: [] };
  p.id = nextId++;
  p.gridPos = { h: 1, w: 24, x: 0, y };
  panels.push(p);
  y += 1;
}

const stat = (title, expr, { w = 4, h = 4, x = 0, unit = 'none', steps = [green], desc = '', decimals } = {}) => place(h, w, x, {
  type: 'stat',
  title,
  description: desc,
  targets: [target(expr, '')],
  fieldConfig: { defaults: { unit, decimals, thresholds: { mode: 'absolute', steps }, mappings: [] }, overrides: [] },
  options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'value', graphMode: 'area', textMode: 'auto', orientation: 'auto', justifyMode: 'auto' },
});

const timeseries = (title, targets, { w = 12, h = 8, x = 0, unit = 'none', stack = false, desc = '', min } = {}) => place(h, w, x, {
  type: 'timeseries',
  title,
  description: desc,
  targets,
  fieldConfig: {
    defaults: {
      unit,
      min,
      color: { mode: 'palette-classic' },
      custom: { lineWidth: 1, fillOpacity: stack ? 30 : 10, showPoints: 'never', spanNulls: false, stacking: { mode: stack ? 'normal' : 'none', group: 'A' } },
    },
    overrides: [],
  },
  options: { legend: { displayMode: 'table', placement: 'bottom', showLegend: true, calcs: ['lastNotNull', 'max'] }, tooltip: { mode: 'multi', sort: 'desc' } },
});

const stateTimeline = (title, targets, { w = 12, h = 8, x = 0, desc = '', texts = { 0: ['нет', 'red'], 1: ['да', 'green'] } } = {}) => place(h, w, x, {
  type: 'state-timeline',
  title,
  description: desc,
  targets,
  fieldConfig: {
    defaults: {
      custom: { fillOpacity: 75, lineWidth: 0 },
      mappings: [{ type: 'value', options: Object.fromEntries(Object.entries(texts).map(([k, [text, color]]) => [k, { text, color }])) }],
      thresholds: { mode: 'absolute', steps: [green] },
    },
    overrides: [],
  },
  options: { mergeValues: true, showValue: 'auto', alignValue: 'left', rowHeight: 0.85, legend: { displayMode: 'list', placement: 'bottom', showLegend: false }, tooltip: { mode: 'single', sort: 'none' } },
});

const bargauge = (title, expr, legend, { w = 8, h = 8, x = 0, unit = 'none', desc = '' } = {}) => place(h, w, x, {
  type: 'bargauge',
  title,
  description: desc,
  targets: [target(expr, legend, 'A', { instant: true })],
  fieldConfig: { defaults: { unit, min: 0, thresholds: { mode: 'absolute', steps: [green] }, color: { mode: 'continuous-GrYlRd' } }, overrides: [] },
  options: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true, reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, valueMode: 'color', namePlacement: 'auto', minVizHeight: 16 },
});

const pie = (title, expr, legend, { w = 6, h = 8, x = 0, desc = '' } = {}) => place(h, w, x, {
  type: 'piechart',
  title,
  description: desc,
  targets: [target(expr, legend, 'A', { instant: true })],
  fieldConfig: { defaults: { unit: 'none', color: { mode: 'palette-classic' } }, overrides: [] },
  options: { pieType: 'donut', displayLabels: ['value'], legend: { displayMode: 'table', placement: 'right', showLegend: true, values: ['value'] }, reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, tooltip: { mode: 'single', sort: 'none' } },
});

/**
 * Таблица из нескольких мгновенных запросов, склеенных по меткам (merge).
 * @param {Array<{expr: string, name: string}>} queries  колонка значения получает имя name
 * @param {string[]} hidden   какие колонки скрыть (метки и служебные)
 * @param {string[]} order    порядок колонок
 * @param {object[]} overrides
 */
function table(title, queries, { hidden = [], order = [], overrides = [], w = 24, h = 9, x = 0, desc = '', sort } = {}) {
  const refs = queries.map((_, i) => String.fromCharCode(65 + i));
  const renameByName = {};
  queries.forEach((q, i) => { renameByName[`Value #${refs[i]}`] = q.name; });
  return place(h, w, x, {
    type: 'table',
    title,
    description: desc,
    targets: queries.map((q, i) => target(q.expr, '', refs[i], { instant: true, range: false, format: 'table' })),
    transformations: [
      { id: 'merge', options: {} },
      {
        id: 'organize',
        options: {
          excludeByName: Object.fromEntries(['Time', '__name__', 'instance', 'job', ...hidden].map((k) => [k, true])),
          renameByName,
          indexByName: Object.fromEntries(order.map((k, i) => [k, i])),
        },
      },
    ],
    fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' }, filterable: true }, thresholds: { mode: 'absolute', steps: [green] } }, overrides },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false }, sortBy: sort ? [{ displayName: sort, desc: false }] : [] },
  });
}

const unitOverride = (name, unit) => ({ matcher: { id: 'byName', options: name }, properties: [{ id: 'unit', value: unit }] });
const yesNoOverride = (name, goodIsOne = true) => ({
  matcher: { id: 'byName', options: name },
  properties: [
    { id: 'mappings', value: [{ type: 'value', options: { 0: { text: 'нет', color: goodIsOne ? 'red' : 'green' }, 1: { text: 'да', color: goodIsOne ? 'green' : 'red' } } }] },
    { id: 'custom.cellOptions', value: { type: 'color-text' } },
  ],
});

// ================================================================== раскладка

place(4, 24, 0, {
  type: 'text',
  title: '',
  datasource: undefined,
  options: {
    mode: 'markdown',
    content: [
      '**Net Device Share** — все метрики берутся у узла-наблюдателя (переменная **Узел-наблюдатель**): он отдаёт не только своё, а всё, что видит —',
      'все узлы сети со статистикой, устройства, кто их занял, трафик. Если Prometheus опрашивает несколько узлов, выберите один, чтобы данные не складывались дважды.',
      '',
      'Метрики включаются в настройках узла («Метрики для Prometheus») или флагом `--metrics`. Подробности — `docs/METRICS.md`.',
    ].join('\n'),
  },
});
y += 4;

row('Сеть');
stat('Узлов в сети', `sum(nds_nodes{${I}, state="online"})`, { x: 0, desc: 'Сколько узлов отвечает (включая узел-наблюдатель).' });
stat('Узлов не отвечает', `sum(nds_nodes{${I}, state="offline"})`, { x: 4, steps: [green, { color: 'red', value: 1 }] });
stat('Опубликовано устройств', `sum(nds_node_devices{${I}, scope="published"})`, { x: 8 });
stat('Занято', `sum(nds_node_devices_busy{${I}})`, { x: 12, steps: [{ color: 'blue', value: null }] });
stat('Загрузка', `100 * sum(nds_node_devices_busy{${I}}) / clamp_min(sum(nds_node_devices{${I}, scope="published"}), 1)`, {
  x: 16, unit: 'percent', decimals: 0, steps: [green, { color: 'orange', value: 60 }, { color: 'red', value: 90 }], desc: 'Занятые устройства от опубликованных.',
});
stat('Трафик сети', `sum(nds_node_traffic_bytes_per_minute{${I}}) / 60`, { x: 20, unit: 'Bps', desc: 'Все устройства всех узлов, оба направления, средний за последнюю минуту.' });
y += 4;

row('Узлы');
table('Узлы сети', [
  { expr: `nds_node_info{${N}}`, name: 'info' },
  { expr: `nds_node_up{${N}}`, name: 'Отвечает' },
  { expr: `nds_node_uptime_seconds{${N}}`, name: 'Аптайм' },
  { expr: `nds_node_devices{${N}, scope="published"}`, name: 'Устройств' },
  { expr: `nds_node_devices_busy{${N}}`, name: 'Занято' },
  { expr: `nds_node_holders{${N}}`, name: 'Держателей' },
  { expr: `sum by (node_id, node) (nds_node_traffic_bytes_per_minute{${N}, direction="in"}) / 60`, name: 'Трафик к устройствам' },
  { expr: `sum by (node_id, node) (nds_node_traffic_bytes_per_minute{${N}, direction="out"}) / 60`, name: 'Трафик от устройств' },
  { expr: `nds_node_last_seen_age_seconds{${N}}`, name: 'Последний ответ' },
  { expr: `nds_node_state_error{${N}}`, name: 'Ошибка состояния' },
], {
  hidden: ['node_id', 'Value #A', 'self', 'api_port', 'network', 'realm', 'scope'],
  order: ['node', 'address', 'platform', 'version', 'origin', 'Отвечает', 'Аптайм', 'Устройств', 'Занято', 'Держателей', 'Трафик к устройствам', 'Трафик от устройств', 'Последний ответ', 'Ошибка состояния'],
  overrides: [
    yesNoOverride('Отвечает'),
    yesNoOverride('Ошибка состояния', false),
    unitOverride('Аптайм', 's'),
    unitOverride('Последний ответ', 's'),
    unitOverride('Трафик к устройствам', 'Bps'),
    unitOverride('Трафик от устройств', 'Bps'),
  ],
  h: 8,
  sort: 'node',
  desc: 'По одной строке на узел сети. «Отвечает» — отвечал ли узел последний раз; «Занято» и «Держателей» — устройства этого узла.',
});
y += 8;
stateTimeline('Доступность узлов', [target(`nds_node_up{${N}}`, '{{node}}')], { w: 12, x: 0, desc: 'Зелёный — узел отвечает.' });
timeseries('Занятость устройств по узлам', [
  target(`nds_node_devices_busy{${N}}`, 'занято · {{node}}', 'A'),
  target(`nds_node_devices_free{${N}}`, 'свободно · {{node}}', 'B'),
], { w: 12, x: 12, stack: true, min: 0 });
y += 8;
timeseries('Трафик к устройствам (по узлам-владельцам)', [target(`sum by (node) (nds_node_traffic_bytes_per_minute{${N}, direction="in"}) / 60`, '{{node}}')], { w: 12, x: 0, unit: 'Bps', min: 0, desc: 'От клиентов к устройствам узла.' });
timeseries('Трафик от устройств (по узлам-владельцам)', [target(`sum by (node) (nds_node_traffic_bytes_per_minute{${N}, direction="out"}) / 60`, '{{node}}')], { w: 12, x: 12, unit: 'Bps', min: 0, desc: 'От устройств узла к клиентам.' });
y += 8;
timeseries('Аптайм узлов', [target(`nds_node_uptime_seconds{${N}}`, '{{node}}')], { w: 8, x: 0, unit: 's', min: 0 });
timeseries('Давность последнего ответа', [target(`nds_node_last_seen_age_seconds{${N}}`, '{{node}}')], { w: 8, x: 8, unit: 's', min: 0, desc: 'Растёт у узла, который перестал отвечать.' });
pie('Устройства по типам', `sum by (type) (nds_node_devices_by_type{${N}})`, '{{type}}', { w: 8, x: 16, desc: 'usb, com, lpt, net — у всех выбранных узлов.' });
y += 8;

row('Устройства');
table('Занятые устройства', [
  { expr: `nds_device_claim_info{${I}, owner=~"$node"}`, name: 'claim' },
  { expr: `nds_device_claim_age_seconds{${I}, owner=~"$node"}`, name: 'Занято' },
  { expr: `sum by (owner_id, owner, device_id, type, title) (nds_device_traffic_bytes_per_minute{${I}, owner=~"$node", direction="in"}) / 60`, name: 'К устройству' },
  { expr: `sum by (owner_id, owner, device_id, type, title) (nds_device_traffic_bytes_per_minute{${I}, owner=~"$node", direction="out"}) / 60`, name: 'От устройства' },
  { expr: `nds_device_holder_silent_seconds{${I}, owner=~"$node"}`, name: 'Держатель молчит' },
], {
  hidden: ['owner_id', 'device_id', 'holder_id', 'direction', 'Value #A'],
  order: ['owner', 'title', 'type', 'holder', 'mode', 'Занято', 'К устройству', 'От устройства', 'Держатель молчит'],
  overrides: [unitOverride('Занято', 's'), unitOverride('К устройству', 'Bps'), unitOverride('От устройства', 'Bps'), unitOverride('Держатель молчит', 's')],
  h: 8,
  sort: 'owner',
  desc: 'Что занято, кем и с каким трафиком. «Держатель молчит» — сколько секунд он не продлевал аренду (больше 15 — связь с ним теряется).',
});
y += 8;
stateTimeline('Занятость устройств', [target(`nds_device_busy{${I}, owner=~"$node"}`, '{{owner}} · {{title}} ({{type}})')], {
  w: 12, x: 0, h: 10, texts: { 0: ['свободно', 'green'], 1: ['занято', 'orange'] },
});
timeseries('Трафик по устройствам (10 самых нагруженных)', [
  target(`topk(10, sum by (owner, title) (nds_device_traffic_bytes_per_minute{${I}, owner=~"$node"})) / 60`, '{{owner}} · {{title}}'),
], { w: 12, x: 12, h: 10, unit: 'Bps', min: 0 });
y += 10;
timeseries('Держатель не отвечает (секунд)', [target(`nds_device_holder_silent_seconds{${I}, owner=~"$node"}`, '{{owner}} · {{title}} ← {{holder_id}}')], {
  w: 12, x: 0, unit: 's', min: 0, desc: 'Проверка связи идёт раз в 10 секунд; аренда истекает на 30-й.',
});
stat('Устройств с ошибкой', `sum(nds_device_error{${I}, owner=~"$node"})`, { w: 6, x: 12, steps: [green, { color: 'red', value: 1 }] });
stat('Держателей молчит дольше 15 с', `count(nds_device_holder_silent_seconds{${I}, owner=~"$node"} > 15) or vector(0)`, { w: 6, x: 18, steps: [green, { color: 'orange', value: 1 }] });
y += 8;

row('Клиенты (кто занимает устройства)');
bargauge('Устройств у держателей', `sort_desc(nds_holder_devices{${I}})`, '{{holder}}', { w: 8, x: 0 });
timeseries('Трафик устройств по держателям', [
  target(`sum by (holder) (nds_holder_traffic_bytes_per_minute{${I}}) / 60`, '{{holder}}'),
], { w: 16, x: 8, unit: 'Bps', min: 0 });
y += 8;
timeseries('Подключения этого узла к чужим устройствам', [
  target(`nds_attachments_attached{${I}}`, 'занято целей'),
], { w: 12, x: 0, min: 0, desc: 'Сколько целей узел-наблюдатель занимает сам.' });
table('Подключения узла-наблюдателя', [
  { expr: `nds_attachment_state{${I}}`, name: 'state' },
  { expr: `nds_attachment_age_seconds{${I}}`, name: 'Занято' },
  { expr: `nds_attachment_heartbeat_age_seconds{${I}}`, name: 'Связь с владельцем' },
], {
  hidden: ['owner_id', 'target', 'Value #A'],
  order: ['title', 'owner', 'state', 'Занято', 'Связь с владельцем'],
  overrides: [unitOverride('Занято', 's'), unitOverride('Связь с владельцем', 's')],
  w: 12, x: 12, h: 8,
});
y += 8;

row('Обновления');
pie('Версии приложения в сети', `count by (version) (nds_node_info{${I}})`, '{{version}}', { w: 6, x: 0, desc: 'На скольких узлах какая версия. Во время обновления видно, как версия проходит по сети.' });
table('Состояние самообновления узла-наблюдателя', [
  { expr: `nds_update_info{${I}}`, name: 'info' },
  { expr: `nds_update_staged{${I}}`, name: 'Подготовлена версия' },
  { expr: `nds_update_failed_versions{${I}}`, name: 'Отвергнуто версий' },
  { expr: `nds_update_reported_bad_versions{${I}}`, name: 'Сообщили о плохих' },
  { expr: `nds_update_trial{${I}}`, name: 'Пробный запуск' },
], {
  hidden: ['Value #A'],
  order: ['running', 'mode', 'phase', 'Подготовлена версия', 'Пробный запуск', 'Отвергнуто версий', 'Сообщили о плохих'],
  overrides: [yesNoOverride('Подготовлена версия', true), yesNoOverride('Пробный запуск', true), yesNoOverride('Отвергнуто версий', false), yesNoOverride('Сообщили о плохих', false)],
  w: 18, x: 6, h: 8,
});
y += 8;

row('Узел-наблюдатель (процесс)');
timeseries('Процессор', [target(`rate(process_cpu_seconds_total{${I}}[5m])`, 'ядер')], { w: 8, x: 0, min: 0, desc: 'Занятые ядра процесса приложения.' });
timeseries('Память', [
  target(`process_resident_memory_bytes{${I}}`, 'физическая память', 'A'),
  target(`nodejs_heap_used_bytes{${I}}`, 'куча Node.js', 'B'),
], { w: 8, x: 8, unit: 'bytes', min: 0 });
timeseries('Время сбора метрик', [target(`nds_scrape_duration_seconds{${I}}`, 'сбор')], { w: 8, x: 16, unit: 's', min: 0, desc: 'Сколько занимает формирование ответа /metrics.' });
y += 8;

// ============================================================== панель целиком

const dashboard = {
  __inputs: [{ name: 'DS_PROMETHEUS', label: 'Prometheus', description: 'Источник данных Prometheus, который опрашивает узел Net Device Share', type: 'datasource', pluginId: 'prometheus', pluginName: 'Prometheus' }],
  __requires: [
    { type: 'grafana', id: 'grafana', name: 'Grafana', version: '10.0.0' },
    { type: 'datasource', id: 'prometheus', name: 'Prometheus', version: '1.0.0' },
    { type: 'panel', id: 'stat', name: 'Stat', version: '' },
    { type: 'panel', id: 'timeseries', name: 'Time series', version: '' },
    { type: 'panel', id: 'state-timeline', name: 'State timeline', version: '' },
    { type: 'panel', id: 'table', name: 'Table', version: '' },
    { type: 'panel', id: 'piechart', name: 'Pie chart', version: '' },
    { type: 'panel', id: 'bargauge', name: 'Bar gauge', version: '' },
    { type: 'panel', id: 'text', name: 'Text', version: '' },
  ],
  annotations: { list: [{ builtIn: 1, datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)', name: 'Annotations & Alerts', type: 'dashboard' }] },
  description: 'Сеть общего доступа к USB-устройствам, COM, LPT и сетевым интерфейсам: узлы и их статистика, устройства, кто их занял, трафик, обновления. Метрики берутся у одного узла-наблюдателя.',
  editable: true,
  fiscalYearStartMonth: 0,
  graphTooltip: 1,
  id: null,
  links: [],
  liveNow: false,
  panels,
  refresh: '30s',
  schemaVersion: 39,
  tags: ['net-device-share', 'usb'],
  templating: {
    list: [
      {
        name: 'instance',
        label: 'Узел-наблюдатель',
        type: 'query',
        datasource: DS,
        definition: 'label_values(nds_build_info, instance)',
        query: { query: 'label_values(nds_build_info, instance)', refId: 'StandardVariableQuery' },
        refresh: 2,
        sort: 1,
        includeAll: false,
        multi: false,
        hide: 0,
        current: {},
        options: [],
      },
      {
        name: 'node',
        label: 'Узлы',
        type: 'query',
        datasource: DS,
        definition: 'label_values(nds_node_info{instance="$instance"}, node)',
        query: { query: 'label_values(nds_node_info{instance="$instance"}, node)', refId: 'StandardVariableQuery' },
        refresh: 2,
        sort: 1,
        includeAll: true,
        allValue: '.*',
        multi: true,
        hide: 0,
        current: { selected: true, text: ['All'], value: ['$__all'] },
        options: [],
      },
    ],
  },
  time: { from: 'now-6h', to: 'now' },
  timepicker: {},
  timezone: 'browser',
  title: 'Net Device Share — сеть устройств',
  uid: 'net-device-share',
  version: 1,
  weekStart: '',
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(dashboard, null, 2) + '\n');
process.stdout.write(`${path.relative(ROOT, OUT)}: панелей ${panels.length}, переменных ${dashboard.templating.list.length}\n`);
