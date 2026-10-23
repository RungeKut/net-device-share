// Метрики для Prometheus.
//
// По умолчанию выключены (настройка metricsEnabled). Включить можно на любом узле:
// он отдаёт не только своё, а всё, что видит сам, — каждый узел сети со своей
// статистикой, все опубликованные устройства, кто их занял, трафик, свои подключения
// к чужим устройствам, обновление. Поэтому подключать к Prometheus достаточно одного
// узла (или нескольких — для надёжности, тогда в запросах выбирают наблюдателя
// по метке instance).
//
// Формат — текстовый, Prometheus exposition 0.0.4. Все имена начинаются с nds_, кроме
// стандартных process_* (по ним работают готовые панели Grafana).
//
// Метки у узлов и устройств одинаковые во всех семействах, чтобы запросы можно было
// соединять: node_id, node (имя), а у устройств ещё owner_id, owner, device_id, type,
// title. Имя узла может меняться — для устойчивых запросов есть node_id.

const SECOND = 1000;

/** Реестр: семейство (HELP/TYPE) заводится один раз, серии без повторов. */
class Registry {
  constructor() {
    this.families = new Map();
  }

  /** @param {'gauge'|'counter'} type */
  add(type, name, help, labels, value) {
    if (value === null || value === undefined) return;
    const num = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
    if (!Number.isFinite(num)) return;
    let fam = this.families.get(name);
    if (!fam) {
      fam = { type, help, series: new Map() };
      this.families.set(name, fam);
    }
    const key = labelString(labels);
    fam.series.set(key, num);   // повторная серия с теми же метками перезаписывается, а не дублируется
  }

  gauge(name, help, labels, value) { this.add('gauge', name, help, labels, value); }

  counter(name, help, labels, value) { this.add('counter', name, help, labels, value); }

  render() {
    const out = [];
    for (const [name, fam] of this.families) {
      out.push(`# HELP ${name} ${fam.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`);
      out.push(`# TYPE ${name} ${fam.type}`);
      for (const [key, value] of fam.series) {
        out.push(`${name}${key ? `{${key}}` : ''} ${formatValue(value)}`);
      }
    }
    return out.join('\n') + '\n';
  }
}

export function escapeLabel(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelString(labels) {
  if (!labels) return '';
  return Object.entries(labels)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(',');
}

function formatValue(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(6)));
}

const secondsSince = (ms, now) => (ms ? Math.max(0, (now - ms) / SECOND) : null);

/** Метки узла. */
const nodeLabels = (n) => ({ node_id: n.nodeId, node: n.name });

/** Метки устройства: владелец и само устройство. */
const deviceLabels = (owner, d) => ({
  owner_id: owner.nodeId,
  owner: owner.name,
  device_id: d.deviceId,
  type: d.type,
  title: d.title,
});

const TYPES = ['usb', 'com', 'lpt', 'net'];

/**
 * Собрать метрики приложения.
 *
 * @param {object} app  App (core/app.js); читаются только его публичные части
 * @returns {string} текст в формате Prometheus
 */
export function renderMetrics(app) {
  const started = process.hrtime.bigint();
  const now = Date.now();
  const r = new Registry();
  const selfId = app.config.get('nodeId');
  const selfName = app.config.get('name');

  // ------------------------------------------------------------ этот узел
  r.gauge('nds_build_info', 'Сведения об этом узле: версия, платформа, бэкенд USB/IP. Всегда 1.', {
    node_id: selfId,
    node: selfName,
    version: app.version,
    platform: process.platform,
    backend: app.backend?.name,
    network: app.network?.cidr,
  }, 1);
  r.gauge('nds_backend_capability', 'Что умеет бэкенд USB/IP этого узла: server — раздавать свои устройства, client — подключать чужие.',
    { capability: 'server' }, Boolean(app.backendInfo?.server));
  r.gauge('nds_backend_capability', 'Что умеет бэкенд USB/IP этого узла: server — раздавать свои устройства, client — подключать чужие.',
    { capability: 'client' }, Boolean(app.backendInfo?.client));
  r.gauge('nds_traffic_meter_enabled', 'Включён ли учёт трафика USB/IP на этом узле (1 — да).', null, Boolean(app.traffic));
  r.gauge('nds_autostart_enabled', 'Включён ли автозапуск этого узла вместе с системой (1 — да).', null, app.autostartState?.enabled);

  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  r.gauge('process_resident_memory_bytes', 'Физическая память процесса приложения.', null, mem.rss);
  r.gauge('nodejs_heap_used_bytes', 'Используемая куча Node.js.', null, mem.heapUsed);
  r.counter('process_cpu_seconds_total', 'Процессорное время процесса (user + system), секунды.', null, (cpu.user + cpu.system) / 1e6);
  r.gauge('process_start_time_seconds', 'Время запуска процесса, секунды с 1970 года.', null, app.startedAt / SECOND);

  // --------------------------------------------------------- узлы сети
  // Все узлы, включая этот: у каждого своя статистика. Устройства узла берём у самого
  // узла (его собственный список) или из последнего ответа соседа.
  const peers = app.peers?.list() || [];
  const owners = [{
    nodeId: selfId,
    name: selfName,
    self: true,
    online: true,
    address: app.network?.address,
    apiPort: app.config.get('apiPort'),
    platform: process.platform,
    version: app.version,
    startedAt: app.startedAt,
    lastSeen: now,
    network: app.network?.cidr,
    origin: 'self',
    realm: null,
    devices: app.share?.listAll() || [],
    groups: app.share?.listGroups() || [],
    stateError: null,
    requests: [],
  }];
  for (const p of peers) {
    owners.push({
      nodeId: p.nodeId,
      name: p.name,
      self: false,
      online: Boolean(p.online),
      address: p.address,
      apiPort: p.apiPort,
      platform: p.platform,
      version: p.version,
      startedAt: p.startedAt,
      lastSeen: p.lastSeen,
      network: p.network,
      origin: p.origin,
      realm: p.realm,
      devices: p.devices || [],
      groups: p.groups || [],
      stateError: p.stateError || null,
      requests: p.requests || [],
    });
  }

  r.gauge('nds_nodes', 'Сколько узлов видит этот узел (включая себя) по состоянию.', { state: 'online' }, owners.filter((o) => o.online).length);
  r.gauge('nds_nodes', 'Сколько узлов видит этот узел (включая себя) по состоянию.', { state: 'offline' }, owners.filter((o) => !o.online).length);

  // Занявшие: кто сколько устройств держит и сколько гонит трафика. Считаем по всем
  // устройствам, которые видим, — это и есть «клиенты» сети.
  const holders = new Map();

  for (const o of owners) {
    const nl = nodeLabels(o);

    r.gauge('nds_node_info', 'Сведения об узле сети: адрес, порт, платформа, версия, откуда узел известен. Всегда 1.', {
      ...nl,
      address: o.address,
      api_port: o.apiPort,
      platform: o.platform,
      version: o.version,
      network: o.network,
      origin: o.origin,
      realm: o.realm,
      self: o.self,
    }, 1);
    r.gauge('nds_node_up', 'Отвечает ли узел (1 — да, 0 — нет). Этот узел всегда 1.', nl, o.online);
    r.gauge('nds_node_last_seen_age_seconds', 'Сколько секунд назад узел последний раз подавал признаки жизни.', nl, o.self ? 0 : secondsSince(o.lastSeen, now));
    r.gauge('nds_node_start_time_seconds', 'Когда узел запущен, секунды с 1970 года.', nl, o.startedAt ? o.startedAt / SECOND : null);
    r.gauge('nds_node_uptime_seconds', 'Сколько секунд узел работает (для неотвечающих — 0).', nl, o.online ? secondsSince(o.startedAt, now) : 0);
    r.gauge('nds_node_state_error', 'Не удалось получить состояние узла (1 — ошибка, причина в журнале).', nl, Boolean(o.stateError));

    const devices = o.devices;
    // Для своего узла опубликованы только отмеченные; для чужих список уже опубликованный.
    const shared = devices.filter((d) => d.shared !== false);
    const busy = devices.filter((d) => d.claim);
    const joiners = devices.flatMap((d) => (d.joins || []).map((j) => ({ ...j, device: d })));
    r.gauge('nds_node_devices', 'Устройства узла: published — опубликованные, all — все, что у него есть (для чужих узлов они совпадают).',
      { ...nl, scope: 'published' }, shared.length);
    r.gauge('nds_node_devices', 'Устройства узла: published — опубликованные, all — все, что у него есть (для чужих узлов они совпадают).',
      { ...nl, scope: 'all' }, devices.length);
    r.gauge('nds_node_devices_busy', 'Сколько устройств узла сейчас занято.', nl, busy.length);
    r.gauge('nds_node_devices_free', 'Сколько опубликованных устройств узла свободно.', nl, shared.filter((d) => !d.claim).length);
    for (const type of TYPES) {
      r.gauge('nds_node_devices_by_type', 'Устройства узла по типам (usb, com, lpt, net).',
        { ...nl, type }, devices.filter((d) => d.type === type).length);
    }
    r.gauge('nds_node_groups', 'Опубликованные группы устройств узла.', nl, o.groups.filter((g) => g.shared !== false).length);
    // Держатель — и занявший устройство, и подключённый к карте в общий мост:
    // оба работают с устройствами узла.
    r.gauge('nds_node_holders', 'Сколько разных узлов держат устройства этого узла (занявшие и подключённые в общий мост).',
      nl, new Set([...busy.map((d) => d.claim.holderId), ...joiners.map((j) => j.holderId)]).size);

    // Трафик узла как владельца: сумма по его устройствам.
    let inRate = 0; let outRate = 0; let inTotal = 0; let outTotal = 0; let hasTraffic = false;
    for (const d of devices) {
      if (!d.traffic) continue;
      hasTraffic = true;
      inRate += d.traffic.bytesInPerMinute || 0;
      outRate += d.traffic.bytesOutPerMinute || 0;
      inTotal += d.traffic.totalIn || 0;
      outTotal += d.traffic.totalOut || 0;
    }
    if (hasTraffic || o.self) {
      r.gauge('nds_node_traffic_bytes_per_minute', 'Трафик устройств узла за последнюю минуту, байт: in — от клиентов к устройствам, out — обратно.',
        { ...nl, direction: 'in' }, inRate);
      r.gauge('nds_node_traffic_bytes_per_minute', 'Трафик устройств узла за последнюю минуту, байт: in — от клиентов к устройствам, out — обратно.',
        { ...nl, direction: 'out' }, outRate);
      r.gauge('nds_node_traffic_session_bytes', 'Трафик устройств узла за текущие занятия, байт (при освобождении устройства его счётчик обнуляется).',
        { ...nl, direction: 'in' }, inTotal);
      r.gauge('nds_node_traffic_session_bytes', 'Трафик устройств узла за текущие занятия, байт (при освобождении устройства его счётчик обнуляется).',
        { ...nl, direction: 'out' }, outTotal);
    }

    if (o.self) {
      r.gauge('nds_node_local_devices_shared', 'Сколько локальных устройств этого узла отмечено «опубликовать».', nl, devices.filter((d) => d.shared).length);
    }

    // ------------------------------------------------------ устройства
    for (const d of devices) {
      // У своего узла видим и неопубликованные — их тоже показываем, но с признаком.
      const dl = deviceLabels(o, d);
      r.gauge('nds_device_info', 'Устройство в сети: владелец, тип, название. Всегда 1.', {
        ...dl,
        description: d.description,
        group: d.groupName,
        shared: d.shared !== false,
        vendor_id: d.meta?.vendorId,
        product_id: d.meta?.productId,
      }, 1);
      r.gauge('nds_device_busy', 'Занято ли устройство (1 — да).', dl, Boolean(d.claim));
      if (d.bindState) {
        r.gauge('nds_device_bind_state', 'Состояние устройства у владельца (метка state), значение всегда 1.', { ...dl, state: d.bindState }, 1);
      }
      r.gauge('nds_device_error', 'У устройства есть ошибка (1 — да, текст у владельца в журнале и карточке).', dl, Boolean(d.lastError));

      if (d.claim) {
        const c = d.claim;
        r.gauge('nds_device_claim_info', 'Кто занял устройство: узел-держатель и режим (remote — чужой узел, local — сам владелец). Всегда 1.', {
          ...dl, holder_id: c.holderId, holder: c.holderName, mode: c.mode,
        }, 1);
        r.gauge('nds_device_claim_age_seconds', 'Сколько секунд устройство занято.', dl, secondsSince(c.since, now));
        if (c.holderSilentMs !== undefined && c.mode === 'remote') {
          r.gauge('nds_device_holder_silent_seconds', 'Сколько секунд держатель не продлевал аренду (проверка связи идёт раз в 10 секунд).', dl, c.holderSilentMs / SECOND);
        }
        const h = holders.get(c.holderId) || { id: c.holderId, name: c.holderName, devices: 0, inRate: 0, outRate: 0, inTotal: 0, outTotal: 0 };
        h.devices++;
        if (d.traffic) {
          h.inRate += d.traffic.bytesInPerMinute || 0;
          h.outRate += d.traffic.bytesOutPerMinute || 0;
          h.inTotal += d.traffic.totalIn || 0;
          h.outTotal += d.traffic.totalOut || 0;
        }
        holders.set(c.holderId, h);
      }

      // Подключённые к карте в общий мост: карта не «занята», но узлы в ней
      // работают, и у каждого своя скорость (joins[].traffic).
      for (const j of d.joins || []) {
        const jl = { ...dl, holder_id: j.holderId, holder: j.holderName };
        r.gauge('nds_device_join_info', 'Узел, подключённый к карте в общий мост. Всегда 1.', jl, 1);
        r.gauge('nds_device_join_age_seconds', 'Сколько секунд узел подключён к карте в общем мосту.', jl, secondsSince(j.since, now));
        const h = holders.get(j.holderId) || { id: j.holderId, name: j.holderName, devices: 0, inRate: 0, outRate: 0, inTotal: 0, outTotal: 0 };
        h.devices++;
        if (j.traffic) {
          r.gauge('nds_device_join_traffic_bytes_per_minute', 'Личный трафик держателя моста за последнюю минуту, байт (in — от держателя в сеть карты, out — обратно).',
            { ...jl, direction: 'in' }, j.traffic.bytesInPerMinute);
          r.gauge('nds_device_join_traffic_bytes_per_minute', 'Личный трафик держателя моста за последнюю минуту, байт (in — от держателя в сеть карты, out — обратно).',
            { ...jl, direction: 'out' }, j.traffic.bytesOutPerMinute);
          r.gauge('nds_device_join_traffic_session_bytes', 'Личный трафик держателя моста за подключение, байт.',
            { ...jl, direction: 'in' }, j.traffic.totalIn);
          r.gauge('nds_device_join_traffic_session_bytes', 'Личный трафик держателя моста за подключение, байт.',
            { ...jl, direction: 'out' }, j.traffic.totalOut);
          h.inRate += j.traffic.bytesInPerMinute || 0;
          h.outRate += j.traffic.bytesOutPerMinute || 0;
          h.inTotal += j.traffic.totalIn || 0;
          h.outTotal += j.traffic.totalOut || 0;
        }
        holders.set(j.holderId, h);
      }

      if (d.traffic) {
        const t = d.traffic;
        r.gauge('nds_device_traffic_bytes_per_minute', 'Трафик устройства за последнюю минуту, байт (in — к устройству, out — от него).',
          { ...dl, direction: 'in' }, t.bytesInPerMinute);
        r.gauge('nds_device_traffic_bytes_per_minute', 'Трафик устройства за последнюю минуту, байт (in — к устройству, out — от него).',
          { ...dl, direction: 'out' }, t.bytesOutPerMinute);
        r.gauge('nds_device_traffic_session_bytes', 'Трафик устройства за текущее занятие, байт (при освобождении обнуляется).',
          { ...dl, direction: 'in' }, t.totalIn);
        r.gauge('nds_device_traffic_session_bytes', 'Трафик устройства за текущее занятие, байт (при освобождении обнуляется).',
          { ...dl, direction: 'out' }, t.totalOut);
        r.gauge('nds_device_traffic_last_activity_age_seconds', 'Сколько секунд назад по устройству последний раз шёл обмен.', dl, secondsSince(t.lastActivity, now));
        r.gauge('nds_device_connections', 'Сколько подключений к устройству было за текущее занятие.', dl, t.connections);
      }
    }

    // ----------------------------------------------------------- группы
    for (const g of o.groups) {
      const gl = { owner_id: o.nodeId, owner: o.name, group_id: g.id, group: g.name };
      r.gauge('nds_group_members', 'Сколько устройств в группе.', gl, (g.members || []).length);
      r.gauge('nds_group_busy', 'Занята ли группа (1 — да). Группа занимается целиком.', gl, Boolean(g.claim));
      r.gauge('nds_group_shared', 'Опубликована ли группа (1 — да).', gl, g.shared !== false);
    }

  }

  // Запросы «освободите устройство»: наши к чужим владельцам и чужие к нам.
  const outgoing = owners.filter((o) => !o.self).reduce((n, o) => n + o.requests.filter((q) => q.requesterId === selfId && q.state === 'pending').length, 0);
  r.gauge('nds_requests_outgoing_pending', 'Наши запросы «освободите устройство», на которые ещё нет ответа.', null, outgoing);
  r.gauge('nds_requests_incoming_pending', 'Запросы к этому узлу, на которые нужно ответить.', null, (app.attach?.pendingRequests() || []).length);

  // ----------------------------------------------------- занявшие (клиенты)
  for (const h of holders.values()) {
    const hl = { holder_id: h.id, holder: h.name };
    r.gauge('nds_holder_devices', 'Сколько устройств сети держит этот узел (виден по всем устройствам, которые видим).', hl, h.devices);
    r.gauge('nds_holder_traffic_bytes_per_minute', 'Трафик устройств, которые держит узел, за последнюю минуту, байт.', { ...hl, direction: 'in' }, h.inRate);
    r.gauge('nds_holder_traffic_bytes_per_minute', 'Трафик устройств, которые держит узел, за последнюю минуту, байт.', { ...hl, direction: 'out' }, h.outRate);
    r.gauge('nds_holder_traffic_session_bytes', 'Трафик устройств, которые держит узел, за текущие занятия, байт.', { ...hl, direction: 'in' }, h.inTotal);
    r.gauge('nds_holder_traffic_session_bytes', 'Трафик устройств, которые держит узел, за текущие занятия, байт.', { ...hl, direction: 'out' }, h.outTotal);
  }

  // ---------------------------------- подключения этого узла к чужим устройствам
  let attached = 0;
  for (const a of app.attach?.list() || []) {
    const al = { owner_id: a.nodeId, owner: a.nodeName, target: a.target, title: a.title };
    r.gauge('nds_attachment_state', 'Подключения этого узла к устройствам (метка state: attaching, attached, detaching, error), значение 1.',
      { ...al, state: a.state }, 1);
    r.gauge('nds_attachment_age_seconds', 'Сколько секунд устройство занято этим узлом.', al, secondsSince(a.attachedAt || a.since, now));
    r.gauge('nds_attachment_heartbeat_age_seconds', 'Сколько секунд назад владелец ответил на проверку связи.', al, a.lastHeartbeat ? secondsSince(a.lastHeartbeat, now) : null);
    if (a.state === 'attached') attached++;
  }
  r.gauge('nds_attachments_attached', 'Сколько целей этот узел занимает прямо сейчас.', null, attached);

  // ---------------------------------------------------------- обновление
  const u = app.updater?.snapshot();
  if (u) {
    r.gauge('nds_update_info', 'Состояние самообновления этого узла: запущенная версия, режим, фаза. Всегда 1.', {
      running: u.running, mode: u.mode, phase: u.phase,
    }, 1);
    r.gauge('nds_update_supported', 'Доступно ли самообновление на этом узле (1 — да).', null, u.supported);
    r.gauge('nds_update_staged', 'Подготовлена ли версия, ожидающая перезапуска (1 — да).', null, Boolean(u.staged));
    r.gauge('nds_update_failed_versions', 'Сколько версий отвергнуто на этом узле (откат, сообщения соседей).', null, (u.failed || []).length);
    r.gauge('nds_update_reported_bad_versions', 'О скольких версиях соседи сообщили как об испорченных.', null, (u.reported || []).length);
    r.gauge('nds_update_trial', 'Идёт ли пробный запуск новой версии (1 — да).', null, u.trial);
  }

  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  r.gauge('nds_scrape_duration_seconds', 'Сколько секунд собирались эти метрики.', null, seconds);
  return r.render();
}
