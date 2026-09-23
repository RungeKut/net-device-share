// Вкладка «Сеть»: карта связей адаптеров, коммутаторы, виртуальные адаптеры,
// настройки IP. И настройки занятой сетевой карты — у её держателя.
//
// Карта сети в общий снимок состояния не входит: её опись стоит секунду
// PowerShell. Она читается отдельно (GET /api/v1/net/map) — пока вкладка
// открыта, раз в несколько секунд и сразу по знаку от сервера (событие
// «net»), что что-то поменялось.
//
// Всё, что здесь меняет сеть, доступно только при полном доступе: с этого
// компьютера или после входа по паролю. Сервер проверяет это сам; здесь
// лишь не рисуем бесполезных кнопок.

/** Как часто перечитывать карту, пока вкладка открыта. */
const POLL_MS = 6000;

const NODE_W = 212;
const NODE_H = 86;
const COL_GAP = 64;
const ROW_GAP = 14;
const BAND_GAP = 26;

const CATEGORY = {
  Private: 'частная',
  Public: 'общедоступная',
  DomainAuthenticated: 'доменная',
};

const ROLE = {
  physical: 'физическая карта',
  wifi: 'Wi-Fi',
  bridge: 'адаптер моста — этот компьютер',
  vnic: 'виртуальный адаптер',
  uplink: 'выход коммутатора в сеть',
  lend: 'мост отданной карты',
  borrow: 'чужая карта у вас',
  tap: 'TAP-адаптер другой программы',
  virtual: 'программный адаптер',
};

export function initNet(h) {
  const { $, esc, post, action, toast, canEdit, getState } = h;
  let map = null;
  let error = null;
  let loading = false;
  let selected = null;
  let ipSave = null;
  let vnicMode = null;

  const visible = () => $('#tab-net').classList.contains('active');
  const available = () => {
    const s = getState();
    return Boolean(s && canEdit() && s.netAdmin?.supported);
  };
  const may = () => Boolean(map?.elevated) && canEdit();

  async function load() {
    if (!available() || loading) return;
    loading = true;
    try {
      const r = await fetch('/api/v1/net/map');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      map = d;
      error = null;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
    if (visible()) render();
  }

  setInterval(() => { if (visible()) load(); }, POLL_MS);

  /** Вызывается при каждом новом снимке состояния. */
  function onState() {
    $('#tabNet').hidden = !available();
    if (!available() && visible()) {
      document.querySelector('.tab[data-tab="catalog"]').click();
    }
  }

  function onShow() {
    render();
    load();
  }

  // --------------------------------------------------------------- текст

  function addrText(a) {
    if (a.bridged) return 'в мосту — адрес у моста';
    if (a.tcpip === false) return 'IP выключен';
    const live = (a.addresses || []).filter((x) => !x.address.startsWith('169.254.'));
    if (live.length) {
      const shown = live.slice(0, 2).map((x) => `${x.address}/${x.prefixLength}`).join(', ');
      return `${shown}${live.length > 2 ? ` +${live.length - 2}` : ''}${a.ip?.dhcp ? ' (DHCP)' : ''}`;
    }
    if (a.ip && !a.ip.dhcp && a.ip.addresses?.length) return `${a.ip.addresses[0].address}/${a.ip.addresses[0].prefixLength} (нет связи)`;
    if (a.ip?.dhcp) return 'DHCP, адреса нет';
    return 'адреса нет';
  }

  /** Настройки IP одной строкой — как в каталоге. */
  function cfgText(ip) {
    if (!ip) return 'не прочитаны';
    const parts = [];
    if (ip.dhcp) parts.push(ip.lease ? `DHCP, сейчас ${ip.lease.address}/${ip.lease.prefixLength ?? '?'}` : 'DHCP');
    else parts.push(`${(ip.addresses || []).map((x) => `${x.address}/${x.prefixLength}`).join(', ') || 'нет адреса'} вручную`);
    const gw = ip.dhcp ? ip.lease?.gateways : ip.gateways;
    if (gw?.length) parts.push(`шлюз ${gw.join(', ')}`);
    const dns = ip.dns?.length ? ip.dns : ip.lease?.dns || [];
    if (dns.length) parts.push(`DNS ${dns.join(', ')}`);
    return parts.join(' · ');
  }

  function statusBadge(a) {
    if (a.status === 'Up') return '';
    if (a.status === 'Disconnected') return '<span class="pill plain">нет связи</span>';
    if (a.status === 'Disabled') return '<span class="pill err">отключён</span>';
    return a.status ? `<span class="pill plain">${esc(a.status)}</span>` : '';
  }

  function categoryBadge(a) {
    const c = a.category;
    if (!c) return '';
    const cls = c === 'Public' ? 'warn' : 'plain';
    const tip = c === 'Public'
      ? 'Общедоступная сеть: сетевой экран (и Windows, и Kaspersky) режет входящие — приборы стенда не достучатся до серверов на этом компьютере'
      : 'Частная сеть: входящие соединения разрешены правилами для частных сетей';
    return `<span class="pill ${cls}" title="${esc(tip)}">сеть ${esc(CATEGORY[c] || c)}</span>`;
  }

  function claimBadge(a) {
    const d = a.device;
    if (!d) return '';
    if (d.preparing) return '<span class="pill warn">готовится к выдаче</span>';
    if (!d.claim) return d.shared ? '<span class="pill free">опубликована</span>' : '';
    const who = esc(d.claim.holderName);
    return a.lend || (d.hasTransport && a.bridged)
      ? `<span class="pill busy">отдана: ${who}</span>`
      : `<span class="pill busy" title="Карта не пробрасывается: держатель работает с ней на этом компьютере">бронь: ${who}</span>`;
  }

  // ---------------------------------------------------------------- карта

  /**
   * Раскладка карты: полосы сверху вниз, в каждой — колонки слева направо:
   *
   *   0 — чужая карта (её мы заняли), 1 — карты этого компьютера,
   *   2 — мост и коммутаторы, 3 — интерфейсы компьютера (где живут адреса),
   *   4 — другие компьютеры (кому отдана или забронирована карта).
   *
   * Пустые колонки выбрасываются, чтобы карта не была шире нужного.
   */
  function layout(m) {
    const bands = [];
    const shown = new Set();
    const A = m.adapters || [];
    const byGuid = new Map(A.map((a) => [a.guid, a]));
    const band = () => { const b = { nodes: [], edges: [] }; bands.push(b); return b; };
    const node = (b, n) => { b.nodes.push(n); return n; };
    const adapterNode = (b, a, col) => {
      shown.add(a.guid);
      return node(b, { id: a.guid, col, kind: a.role, a });
    };
    const remoteFor = (b, a, from) => {
      const d = a.device;
      if (!d?.claim) return;
      const forwarded = Boolean(a.lend) || (a.bridged && d.hasTransport);
      const r = node(b, {
        id: `remote:${a.guid}`, col: 4, kind: 'remote',
        title: d.claim.holderName, sub: forwarded ? 'занял карту — у него адаптер' : 'забронировал карту',
        line: forwarded ? `«${a.name}» по сети` : 'работает на этом компьютере',
      });
      b.edges.push({ from: from.id, to: r.id, style: forwarded ? 'forward' : 'reserve', label: forwarded ? 'проброс' : 'бронь' });
    };

    // Мост Windows со всем, что к нему подключено.
    if (m.bridge) {
      const b = band();
      const sw = m.bridge.owner?.kind === 'switch' ? m.switches.find((s) => s.id === m.bridge.owner.id) : null;
      const lendTap = A.find((a) => a.role === 'lend');
      const center = node(b, {
        id: sw ? `sw:${sw.id}` : 'bridge', col: 2, kind: sw ? 'switch' : 'bridge',
        title: sw ? sw.name : 'Мост Windows',
        sub: sw ? 'коммутатор · мост Windows' : m.bridge.owner?.kind === 'lend' ? 'мост отданной карты' : 'мост, собранный не приложением',
        line: sw?.problem || (m.bridge.ipEnabled === false ? 'IP на мосту выключен' : ''),
        problem: Boolean(sw?.problem),
      });
      if (sw) shown.add(`sw:${sw.id}`);
      for (const a of A.filter((x) => x.bridged && !['uplink', 'lend'].includes(x.role))) {
        const n = adapterNode(b, a, 1);
        b.edges.push({ from: n.id, to: center.id, style: 'solid' });
      }
      for (const a of A.filter((x) => ['uplink', 'lend'].includes(x.role))) shown.add(a.guid);
      const host = A.find((a) => a.role === 'bridge');
      if (host) {
        const n = adapterNode(b, host, 3);
        b.edges.push({ from: center.id, to: n.id, style: host.tcpip === false ? 'off' : 'solid' });
      }
      if (sw) {
        for (const a of A.filter((x) => x.role === 'vnic' && x.switchId === sw.id)) {
          const n = adapterNode(b, a, 3);
          b.edges.push({ from: center.id, to: n.id, style: 'solid' });
        }
      }
      if (lendTap?.lend) {
        const nic = A.find((a) => a.name === lendTap.lend.nic);
        const holder = lendTap.lend.holderName || nic?.device?.claim?.holderName || 'занявший';
        const r = node(b, {
          id: `remote:${lendTap.guid}`, col: 3, kind: 'remote', title: holder,
          sub: lendTap.lend.connected ? 'занял карту — канал подключён' : 'занял карту — канал ждёт подключения',
          line: `у него адаптер «${lendTap.lend.nic} на …»`, problem: !lendTap.lend.connected,
        });
        b.edges.push({ from: center.id, to: r.id, style: 'forward', label: 'проброс' });
        if (nic) shown.add(`claim:${nic.guid}`);
      }
    }

    // Коммутаторы без моста: внутренние и внешние, чей мост разобран.
    for (const sw of m.switches || []) {
      if (shown.has(`sw:${sw.id}`)) continue;
      const b = band();
      const center = node(b, {
        id: `sw:${sw.id}`, col: 2, kind: 'switch', title: sw.name,
        sub: sw.external ? 'коммутатор · мост не собран' : 'внутренний коммутатор',
        line: sw.problem || '', problem: Boolean(sw.problem),
      });
      for (const nic of sw.nics || []) {
        const a = byGuid.get(nic.guid);
        if (a && !shown.has(a.guid)) {
          const n = adapterNode(b, a, 1);
          b.edges.push({ from: n.id, to: center.id, style: 'off' });
        }
      }
      for (const a of A.filter((x) => x.role === 'vnic' && x.switchId === sw.id)) {
        const n = adapterNode(b, a, 3);
        b.edges.push({ from: center.id, to: n.id, style: 'solid' });
      }
    }

    // Чужие карты, занятые этим компьютером.
    for (const a of A.filter((x) => x.role === 'borrow' && !shown.has(x.guid))) {
      const b = band();
      const label = a.borrow?.label || a.name;
      const owner = label.includes(' на ') ? label.split(' на ').pop() : (a.borrow?.host || 'владелец');
      const card = label.includes(' на ') ? label.slice(0, label.lastIndexOf(' на ')) : 'карта';
      const r = node(b, {
        id: `owner:${a.guid}`, col: 0, kind: 'remote', title: owner,
        sub: `карта «${card}»`, line: a.borrow?.host || '', problem: a.borrow && !a.borrow.connected,
      });
      const n = adapterNode(b, a, 3);
      b.edges.push({ from: r.id, to: n.id, style: 'forward', label: a.borrow?.connected ? 'проброс' : 'проброс — связь потеряна' });
    }

    // Виртуальные адаптеры без коммутатора.
    const loose = A.filter((x) => x.role === 'vnic' && !shown.has(x.guid));
    if (loose.length) {
      const b = band();
      for (const a of loose) adapterNode(b, a, 3);
    }

    // Остальные карты — каждая сама по себе; у брони — кто её держит.
    const rest = A.filter((x) => !shown.has(x.guid) && x.role !== 'bridge');
    const order = { physical: 0, wifi: 1, virtual: 2, tap: 3, uplink: 4, lend: 5 };
    rest.sort((x, y) => (order[x.role] ?? 9) - (order[y.role] ?? 9) || x.name.localeCompare(y.name));
    for (const a of rest) {
      const b = band();
      const n = adapterNode(b, a, 1);
      remoteFor(b, a, n);
    }

    // Колонки: только занятые.
    const used = [...new Set(bands.flatMap((b) => b.nodes.map((n) => n.col)))].sort((x, y) => x - y);
    const colX = new Map(used.map((c, i) => [c, i * (NODE_W + COL_GAP)]));
    let y = 0;
    const nodes = [];
    const edges = [];
    for (const b of bands) {
      const perCol = new Map();
      for (const n of b.nodes) perCol.set(n.col, [...(perCol.get(n.col) || []), n]);
      const rows = Math.max(...[...perCol.values()].map((l) => l.length));
      const height = rows * NODE_H + (rows - 1) * ROW_GAP;
      for (const [col, list] of perCol) {
        const h = list.length * NODE_H + (list.length - 1) * ROW_GAP;
        let top = y + (height - h) / 2;
        for (const n of list) {
          n.x = colX.get(col);
          n.y = top;
          top += NODE_H + ROW_GAP;
          nodes.push(n);
        }
      }
      edges.push(...b.edges);
      y += height + BAND_GAP;
    }
    const width = used.length ? used.length * NODE_W + (used.length - 1) * COL_GAP : 0;
    return { nodes, edges, width, height: Math.max(0, y - BAND_GAP) };
  }

  function nodeHtml(n) {
    if (!n.a) {
      return `<div class="nm-node nm-${n.kind}${n.problem ? ' nm-problem' : ''}${selected === n.id ? ' nm-sel' : ''}"
        style="left:${n.x}px;top:${n.y}px;width:${NODE_W}px;height:${NODE_H}px" data-nm="${esc(n.id)}">
        <div class="nm-title">${n.kind === 'remote' ? '🖥 ' : n.kind === 'switch' ? '🔀 ' : '🌉 '}${esc(n.title)}</div>
        <div class="nm-sub">${esc(n.sub || '')}</div>
        ${n.line ? `<div class="nm-line${n.problem ? ' err' : ''}">${esc(n.line)}</div>` : ''}
      </div>`;
    }
    const a = n.a;
    const icon = { physical: '🔌', wifi: '📶', bridge: '💻', vnic: '🧩', borrow: '🔗', virtual: '▫', tap: '▫', uplink: '↔', lend: '↔' }[a.role] || '▫';
    const badges = [];
    if (a.working) badges.push('<span class="nm-b">рабочая</span>');
    if (a.status && a.status !== 'Up') badges.push(`<span class="nm-b off">${a.status === 'Disconnected' ? 'нет связи' : esc(a.status)}</span>`);
    if (a.category === 'Public') badges.push('<span class="nm-b warn" title="общедоступная сеть: входящие закрыты">общедост.</span>');
    if (a.device?.claim && !a.bridged) badges.push(`<span class="nm-b busy">бронь</span>`);
    if (a.device?.heldEdit) badges.push('<span class="nm-b busy" title="настройки поменял держатель брони; вернутся при освобождении">адрес держателя</span>');
    return `<div class="nm-node nm-a-${a.role}${a.status !== 'Up' ? ' nm-down' : ''}${selected === a.guid ? ' nm-sel' : ''}"
      style="left:${n.x}px;top:${n.y}px;width:${NODE_W}px;height:${NODE_H}px" data-nm="${esc(a.guid)}"
      title="${esc(`${a.name}\n${a.description}\nMAC ${a.mac || '—'}`)}">
      <div class="nm-title">${icon} ${esc(a.name)}</div>
      <div class="nm-sub">${esc(ROLE[a.role] || a.role)}</div>
      <div class="nm-line mono">${esc(addrText(a))}</div>
      <div class="nm-badges">${badges.join('')}</div>
    </div>`;
  }

  function edgePath(e, byId) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return '';
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const dx = Math.max(30, (x2 - x1) / 2);
    const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    const label = e.label
      ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" class="nm-elabel">${esc(e.label)}</text>` : '';
    return `<path d="${d}" class="nm-edge nm-${e.style}"/>${label}`;
  }

  function renderMap() {
    const box = $('#netMap');
    if (!map?.adapters) { box.innerHTML = ''; box.style.width = ''; box.style.height = ''; return; }
    const L = layout(map);
    const byId = new Map(L.nodes.map((n) => [n.id, n]));
    box.style.width = `${L.width}px`;
    box.style.height = `${L.height}px`;
    box.innerHTML = `<svg class="nm-edges" width="${L.width}" height="${L.height}">${L.edges.map((e) => edgePath(e, byId)).join('')}</svg>`
      + L.nodes.map(nodeHtml).join('');
  }

  // ------------------------------------------------------------- карточки

  function renderNotes() {
    const out = [];
    if (error) out.push(`<div class="banner err">Карта сети не прочитана: ${esc(error)}</div>`);
    if (!map) { $('#netNotes').innerHTML = out.join('') || '<div class="empty">Читается состав сети…</div>'; return; }
    if (map.supported === false) { $('#netNotes').innerHTML = `<div class="empty">${esc(map.reason)}</div>`; return; }
    if (map.createNote) out.push(`<div class="banner info">${esc(map.createNote)}</div>`);
    if (map.busy) out.push(`<div class="banner">⏳ ${esc(map.busy)}… Мост Windows меняется секундами — дождитесь окончания.</div>`);
    const fw = map.firewall;
    if (fw?.thirdParty?.length) {
      out.push(`<div class="banner info">Входящие соединения на этом компьютере фильтрует
        <b>${esc(fw.thirdParty.join(', '))}</b>. Тип сети он берёт у Windows: в <b>общедоступной</b> сети входящие
        (ping, ваши серверы) закрыты. Своим адаптерам — виртуальным и чужим картам — приложение ставит тип
        «частная» само. Если приборы стенда всё равно не видят ваших серверов, откройте в нём
        «Сетевой экран → Сети» и дайте сети адаптера статус «Локальная сеть».</div>`);
    }
    const lendHost = map.adapters.find((a) => a.role === 'bridge');
    if (map.bridge?.owner?.kind === 'lend') {
      out.push(`<div class="banner info">Карта «${esc(map.bridge.owner.nic)}» отдана. Её адрес теперь у занявшего,
        а на адаптере моста IP ${lendHost?.tcpip === false ? 'выключен — сам компьютер в сети карты не участвует' : 'включён'}.
        Чтобы остаться в этой сети, включите IP на мосту и задайте свой адрес — другой, не тот, что у занявшего.
        При освобождении карты всё вернётся как было.</div>`);
    }
    $('#netNotes').innerHTML = out.join('');
  }

  function switchCard(sw) {
    const vnics = map.adapters.filter((a) => a.role === 'vnic' && a.switchId === sw.id);
    const nics = sw.nics.map((n) => map.adapters.find((a) => a.guid === n.guid)?.name || n.name);
    const host = sw.external ? map.adapters.find((a) => a.role === 'bridge') : null;
    const candidates = map.adapters.filter((a) => a.role === 'physical' && !a.bridged && !a.working && !sw.nics.some((n) => n.guid === a.guid));
    const acts = [];
    if (may()) {
      acts.push(`<button class="btn small" data-sw-rename="${esc(sw.id)}">Переименовать</button>`);
      acts.push(`<button class="btn small" data-sw-vnic="${esc(sw.id)}">Добавить адаптер</button>`);
      if (sw.external) {
        acts.push(`<button class="btn small" data-sw-host="${esc(sw.id)}|${sw.hostAccess ? '0' : '1'}">${sw.hostAccess ? 'Отключить компьютер от сети' : 'Подключить компьютер к сети'}</button>`);
      }
      acts.push(`<button class="btn small danger" data-sw-delete="${esc(sw.id)}">Удалить</button>`);
    }
    const addNic = may() && candidates.length ? `<div class="row-inline sw-addnic">
        <select data-sw-nicsel="${esc(sw.id)}">${candidates.map((a) => `<option value="${esc(a.guid)}">${esc(a.name)} — ${esc(a.description)}</option>`).join('')}</select>
        <button class="btn small" data-sw-addnic="${esc(sw.id)}">${sw.external ? 'Добавить карту' : 'Выход в сеть карты'}</button>
      </div>` : '';
    return `<article class="card ${sw.problem ? 'error' : 'free'}${selected === `sw:${sw.id}` ? ' sel' : ''}" id="card-sw-${esc(sw.id)}">
      <div class="card-main">
        <div class="card-title">🔀 ${esc(sw.name)}
          <span class="pill ${sw.external ? 'mine' : 'plain'}">${sw.external ? 'внешний — в сети карты' : 'внутренний'}</span>
          ${sw.problem ? `<span class="pill err">${esc(sw.problem)}</span>` : ''}
        </div>
        <div class="card-meta">
          ${sw.external ? `<span>карта: <b>${esc(nics.join(', '))}</b>${may() ? sw.nics.map((n) => ` <button class="btn small" data-sw-dropnic="${esc(sw.id)}|${esc(n.guid)}" title="вывести карту из коммутатора">убрать ${esc(map.adapters.find((a) => a.guid === n.guid)?.name || n.name)}</button>`).join('') : ''}</span>` : ''}
          ${sw.external ? `<span>компьютер в сети карты: <b>${sw.hostAccess ? 'да' : 'нет'}</b>${host ? ` — адаптер «${esc(host.name)}»` : ''}</span>` : ''}
          <span>адаптеры: ${vnics.length ? vnics.map((a) => `<b>${esc(a.name)}</b>`).join(', ') : 'нет'}</span>
          ${sw.stats ? `<span>MAC в таблице: ${sw.stats.macs}</span>` : ''}
        </div>
        ${addNic}
      </div>
      <div class="card-actions">${acts.join('')}</div>
    </article>`;
  }

  function adapterCard(a) {
    const acts = [];
    const sw = map.switches.find((s) => s.id === a.switchId);
    if (may()) {
      if (a.can.ip) acts.push(`<button class="btn small" data-ip="${esc(a.guid)}">Настройки IP</button>`);
      if (a.role === 'bridge') {
        acts.push(`<button class="btn small" data-bridge-ip="${a.tcpip === false ? '1' : '0'}">${a.tcpip === false ? 'Включить IP' : 'Выключить IP'}</button>`);
      }
      if (a.category === 'Public' && a.can.category) {
        acts.push(`<button class="btn small" data-cat="${esc(a.guid)}|Private" title="Входящие соединения из этой сети станут разрешены правилами для частных сетей">Сделать сеть частной</button>`);
      }
      if (a.role === 'vnic') {
        acts.push(`<button class="btn small" data-vnic-edit="${esc(a.guid)}">Изменить</button>`);
        acts.push(`<button class="btn small danger" data-vnic-delete="${esc(a.guid)}">Удалить</button>`);
      }
      if (a.role === 'physical' && !a.bridged && !a.working && !a.device?.claim) {
        const ext = map.switches.find((s) => s.external);
        if (ext) acts.push(`<button class="btn small" data-sw-addnic-one="${esc(ext.id)}|${esc(a.guid)}">В коммутатор «${esc(ext.name)}»</button>`);
        else acts.push(`<button class="btn small" data-new-switch-nic="${esc(a.guid)}">Коммутатор на этой карте…</button>`);
      }
      if (a.bridged && sw && a.role === 'physical') {
        acts.push(`<button class="btn small" data-sw-dropnic="${esc(sw.id)}|${esc(a.guid)}">Вывести из коммутатора</button>`);
      }
    }
    const why = Object.values(a.why || {}).filter(Boolean);
    const pills = [
      `<span class="pill plain">${esc(ROLE[a.role] || a.role)}</span>`,
      statusBadge(a),
      a.working ? '<span class="pill mine" title="через эту карту работает приложение">рабочая</span>' : '',
      a.bridged ? `<span class="pill plain">в мосту${sw ? ` · «${esc(sw.name)}»` : ''}</span>` : '',
      categoryBadge(a),
      claimBadge(a),
      a.device?.heldEdit ? '<span class="pill busy">адрес задал держатель брони</span>' : '',
      a.borrow ? `<span class="pill ${a.borrow.connected ? 'mine' : 'err'}">${a.borrow.connected ? 'канал подключён' : 'канал ждёт владельца'}</span>` : '',
      a.port?.failed ? `<span class="pill err" title="${esc(a.port.failed)}">адаптер не поднят</span>` : '',
    ].join(' ');
    const live = (a.addresses || []).map((x) => `${x.address}/${x.prefixLength}${x.state && x.state !== 'Preferred' ? ` (${x.state === 'Duplicate' ? 'занят другим!' : x.state})` : ''}`);
    return `<article class="card ${a.status === 'Up' ? '' : 'offline'}${selected === a.guid ? ' sel' : ''}" id="card-a-${esc(a.guid)}">
      <div class="card-main">
        <div class="card-title">${esc(a.name)} ${pills}</div>
        <div class="card-meta">
          <span>${esc(a.description)}</span>
          ${a.mac ? `<span>MAC: <span class="mono">${esc(a.mac)}</span></span>` : ''}
          ${a.speed && a.status === 'Up' ? `<span>${esc(a.speed)}</span>` : ''}
          ${a.bridged || a.tcpip === false ? '' : `<span>настройки: ${esc(cfgText(a.ip))}</span>`}
          ${live.length && !a.bridged ? `<span>сейчас: <span class="mono">${esc(live.join(', '))}</span></span>` : ''}
          ${a.metric && !a.bridged && a.tcpip !== false ? `<span>метрика ${esc(a.metric)}</span>` : ''}
          ${a.profile ? `<span>сеть Windows: «${esc(a.profile.name)}»</span>` : ''}
          ${a.borrow?.announced?.length ? `<span title="адреса, объявленные в сеть владельца (gratuitous ARP)">объявлено: <span class="mono">${esc(a.borrow.announced.join(', '))}</span></span>` : ''}
          ${a.device?.transportNote && a.role !== 'bridge' ? `<span class="muted">проброс: ${esc(a.device.transportNote)}</span>` : ''}
          ${why.length && may() ? `<span class="muted">${esc(why.join('; '))}</span>` : ''}
          ${(a.notes || []).map((x) => `<span class="pill err">${esc(x)}</span>`).join('')}
        </div>
      </div>
      <div class="card-actions">${acts.join('')}</div>
    </article>`;
  }

  function render() {
    if (!visible()) return;
    renderNotes();
    const editable = may();
    $('#btnNewSwitch').hidden = !editable;
    $('#btnNewVnic').hidden = !editable;
    if (!map?.adapters) {
      $('#netMap').innerHTML = '';
      $('#netSwitches').innerHTML = '';
      $('#netAdapters').innerHTML = '';
      return;
    }
    renderMap();
    $('#netSwitches').innerHTML = map.switches.length
      ? map.switches.map(switchCard).join('')
      : '<div class="empty">Коммутаторов нет. «Создать коммутатор» — чтобы подключить виртуальные адаптеры к сети карты или друг к другу.</div>';
    const order = { borrow: 0, vnic: 1, bridge: 2, physical: 3, wifi: 4, lend: 5, uplink: 6, virtual: 7, tap: 8 };
    const list = [...map.adapters].sort((x, y) => (order[x.role] ?? 9) - (order[y.role] ?? 9) || x.name.localeCompare(y.name));
    $('#netAdapters').innerHTML = list.map(adapterCard).join('');
  }

  // ------------------------------------------------------------ редактор IP

  /** Разобрать строку адреса: «10.0.0.5/24», «10.0.0.5 24», «10.0.0.5 255.255.255.0». */
  function parseAddr(line) {
    const m = line.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\s*\/\s*(\d{1,2})|\s+(\d{1,3}(?:\.\d{1,3}){3})|\s+(\d{1,2}))?$/);
    if (!m) throw new Error(`не разобран адрес «${line.trim()}» — нужно «адрес/префикс», например 192.168.2.35/24`);
    let prefix = 24;
    if (m[2] || m[4]) prefix = Number(m[2] || m[4]);
    if (m[3]) {
      const bits = m[3].split('.').map(Number).reduce((acc, p) => acc * 256 + p, 0);
      prefix = 0;
      for (let i = 31; i >= 0 && Math.floor(bits / 2 ** i) % 2 === 1; i--) prefix++;
    }
    return { address: m[1], prefixLength: prefix };
  }

  /** Поля настроек IP в контейнере; read() — собрать то, что ввели. */
  function ipEditor(box, cfg, { category = null, showCategory = true, categoryNote = '' } = {}) {
    const id = box.id;
    const c = cfg || { dhcp: true, addresses: [], gateways: [], dns: [] };
    box.innerHTML = `
      <div class="field">
        <span>Адрес IPv4</span>
        <label class="check"><input type="radio" name="${id}-mode" value="dhcp" ${c.dhcp ? 'checked' : ''}> получать автоматически (DHCP)</label>
        <label class="check"><input type="radio" name="${id}-mode" value="static" ${c.dhcp ? '' : 'checked'}> задать вручную</label>
      </div>
      <label class="field ${id}-st">
        <span>Адреса — по одному в строке</span>
        <textarea id="${id}-addrs" rows="3" spellcheck="false" placeholder="192.168.2.35/24">${esc((c.addresses || []).map((a) => `${a.address}/${a.prefixLength}`).join('\n'))}</textarea>
        <small>«адрес/префикс»: 24 — это маска 255.255.255.0. Можно и маской: «192.168.2.35 255.255.255.0».
          Несколько адресов — компьютер отвечает в сети за каждый.</small>
      </label>
      <div class="grid2">
        <label class="field ${id}-st"><span>Шлюз</span><input type="text" id="${id}-gw" placeholder="необязательно" value="${esc((c.gateways || []).join(', '))}"></label>
        <label class="field"><span>DNS</span><input type="text" id="${id}-dns" placeholder="через запятую, необязательно" value="${esc((c.dns || []).join(', '))}"></label>
      </div>
      ${showCategory ? `<label class="field">
        <span>Тип сети</span>
        <select id="${id}-cat">
          <option value="">не менять</option>
          <option value="Private" ${category === 'Private' ? 'selected' : ''}>частная — входящие соединения разрешены</option>
          <option value="Public" ${category === 'Public' ? 'selected' : ''}>общедоступная — входящие закрыты</option>
        </select>
        <small>${esc(categoryNote || 'От типа сети зависит, пустит ли сетевой экран к этому компьютеру ping и соединения к вашим серверам.')}</small>
      </label>` : ''}`;
    const sync = () => {
      const dhcp = box.querySelector(`input[name="${id}-mode"]:checked`)?.value === 'dhcp';
      box.querySelectorAll(`.${id}-st textarea, .${id}-st input`).forEach((el) => { el.disabled = dhcp; });
    };
    box.querySelectorAll(`input[name="${id}-mode"]`).forEach((el) => el.addEventListener('change', sync));
    sync();
    return {
      read() {
        const dhcp = box.querySelector(`input[name="${id}-mode"]:checked`)?.value === 'dhcp';
        const split = (v) => String(v || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
        const addresses = dhcp ? [] : $(`#${id}-addrs`).value.split(/\n/).filter((l) => l.trim()).map(parseAddr);
        if (!dhcp && !addresses.length) throw new Error('впишите хотя бы один адрес или выберите DHCP');
        return {
          ip: { dhcp, addresses, gateways: dhcp ? [] : split($(`#${id}-gw`).value), dns: split($(`#${id}-dns`).value) },
          category: showCategory ? ($(`#${id}-cat`).value || undefined) : undefined,
        };
      },
    };
  }

  /**
   * Диалог настроек IP.
   * @param {{ title: string, sub?: string, cfg: object|null, category?: string|null,
   *   showCategory?: boolean, note?: string, save: (v: {ip, category}) => Promise<any> }} o
   */
  function openIp(o) {
    $('#ipTitle').textContent = o.title;
    $('#ipSub').innerHTML = o.sub || '';
    $('#ipNote').textContent = o.note || '';
    const ed = ipEditor($('#ipEditor'), o.cfg, { category: o.category, showCategory: o.showCategory !== false, categoryNote: o.categoryNote });
    ipSave = { ed, save: o.save };
    $('#ipDialog').showModal();
  }

  $('#ipDialog').addEventListener('close', () => {
    const dlg = $('#ipDialog');
    const pending = ipSave;
    ipSave = null;
    if (dlg.returnValue !== 'save' || !pending) return;
    let v;
    try {
      v = pending.ed.read();
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    toast('Применяется…');
    pending.save(v)
      .then((r) => { toast(r?.pending ? r.note : 'Настройки применены', 'ok'); load(); })
      .catch((e) => toast(e.message, 'err'));
  });

  // ----------------------------------------------------------- коммутатор

  function openSwitch(preselect = null) {
    const nics = map.adapters.filter((a) => a.role === 'physical' && !a.bridged);
    $('#swName').value = '';
    $('#swHost').checked = true;
    $('#swNics').innerHTML = nics.length
      ? nics.map((a) => {
        const why = a.working ? 'через неё работает приложение' : a.device?.claim ? `занята: ${a.device.claim.holderName}` : '';
        return `<label class="member${why ? ' muted' : ''}"><input type="checkbox" value="${esc(a.guid)}"
          ${a.guid === preselect ? 'checked' : ''} ${why ? 'disabled' : ''}> ${esc(a.name)} — ${esc(a.description)}
          <span class="muted">${esc(addrText(a))}${why ? ` · ${esc(why)}` : ''}</span></label>`;
      }).join('')
      : '<div class="muted">Свободных физических карт нет — будет внутренний коммутатор.</div>';
    const warn = () => {
      const n = $('#swNics').querySelectorAll('input:checked').length;
      $('#swWarn').textContent = n > 1
        ? 'Две карты в одном коммутаторе — это две сети, слитые в одну. Убедитесь, что это и нужно.'
        : n === 1 ? 'Связь на карте прервётся на несколько секунд, пока собирается мост.'
          : 'Внутренний коммутатор: соединяет только адаптеры этого компьютера.';
    };
    $('#swNics').onchange = warn;
    warn();
    $('#switchDialog').showModal();
  }

  $('#switchDialog').addEventListener('close', () => {
    if ($('#switchDialog').returnValue !== 'save') return;
    const nics = [...$('#swNics').querySelectorAll('input:checked')].map((el) => el.value);
    const body = { name: $('#swName').value, nics, hostAccess: $('#swHost').checked };
    toast(nics.length ? 'Собирается мост — это до минуты…' : 'Создаётся коммутатор…');
    post('/api/v1/net/switch/create', body)
      .then(() => { toast('Коммутатор создан', 'ok'); load(); })
      .catch((e) => toast(e.message, 'err'));
  });

  // --------------------------------------------------- виртуальный адаптер

  let vnicIp = null;
  function openVnic(switchId = null, a = null) {
    vnicMode = a ? { edit: a.guid, was: a } : { edit: null };
    $('#vnicTitle').textContent = a ? `Адаптер «${a.name}»` : 'Новый виртуальный адаптер';
    $('#vnicSave').textContent = a ? 'Сохранить' : 'Создать';
    const taken = new Set(map.adapters.map((x) => x.name));
    let n = 1;
    while (taken.has(`Стенд ${n}`)) n++;
    $('#vnicName').value = a ? a.name : `Стенд ${n}`;
    $('#vnicSwitch').innerHTML = '<option value="">не подключать</option>'
      + map.switches.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.external ? ' (в сети карты)' : ''}</option>`).join('');
    $('#vnicSwitch').value = a ? (a.switchId || '') : (switchId || map.switches[0]?.id || '');
    $('#vnicMacMode').value = '';
    $('#vnicMac').value = '';
    $('#vnicMac').hidden = true;
    $('#vnicNote').textContent = a ? `Сейчас MAC ${a.mac || '—'}. Смена MAC перезапускает адаптер.` : '';
    // Адрес — в отдельном окне у готового адаптера; при создании — сразу.
    $('#vnicIp').hidden = Boolean(a);
    vnicIp = a ? null : ipEditor($('#vnicIp'), null, { category: 'Private' });
    $('#vnicDialog').showModal();
  }

  $('#vnicMacMode').addEventListener('change', () => { $('#vnicMac').hidden = $('#vnicMacMode').value !== 'set'; });

  $('#vnicDialog').addEventListener('close', () => {
    if ($('#vnicDialog').returnValue !== 'save' || !vnicMode) return;
    const mode = $('#vnicMacMode').value;
    const mac = mode === 'random' ? 'random' : mode === 'set' ? $('#vnicMac').value.trim() : undefined;
    if (vnicMode.edit) {
      const was = vnicMode.was;
      const patch = {};
      if ($('#vnicName').value.trim() !== was.name) patch.name = $('#vnicName').value;
      if (mac !== undefined) patch.mac = mac;
      if (($('#vnicSwitch').value || null) !== (was.switchId || null)) patch.switchId = $('#vnicSwitch').value || null;
      if (!Object.keys(patch).length) return;
      toast('Меняется адаптер…');
      post('/api/v1/net/vnic/update', { guid: was.guid, ...patch })
        .then(() => { toast('Готово', 'ok'); load(); })
        .catch((e) => toast(e.message, 'err'));
      return;
    }
    let v;
    try { v = vnicIp.read(); } catch (e) { toast(e.message, 'err'); return; }
    toast('Создаётся адаптер — до минуты…');
    post('/api/v1/net/vnic/create', {
      name: $('#vnicName').value, switchId: $('#vnicSwitch').value || null, mac: mac || null, ip: v.ip, category: v.category || 'Private',
    })
      .then(() => { toast('Адаптер создан', 'ok'); load(); })
      .catch((e) => toast(e.message, 'err'));
  });

  // ------------------------------------------------------------- действия

  const byGuid = (g) => map?.adapters.find((a) => a.guid === g);

  function adapterIp(a) {
    const borrow = a.role === 'borrow';
    openIp({
      title: `Настройки IP — ${a.name}`,
      sub: borrow
        ? 'Это адаптер чужой карты у вас: адрес из сети её владельца. Шлюз и DNS получают пониженный приоритет, чтобы не перехватить ваш выход в интернет. Новые адреса приложение объявит в сеть владельца — приборы, помнившие адрес за другим MAC, узнают о переезде сразу. При освобождении адаптер очистится.'
        : a.role === 'bridge'
          ? (map.bridge?.owner?.kind === 'lend'
            ? 'Адаптер моста отданной карты: это сам компьютер в сети карты. Адрес задайте свой — не тот, что у занявшего. При освобождении карты настройки моста вернутся к прежним.'
            : 'Адаптер моста — это сам компьютер в сети коммутатора.')
          : a.role === 'vnic' ? 'Виртуальный адаптер: проверка адреса на дубликат у него выключена — в одном коммутаторе несколько адаптеров компьютера иначе гасили бы друг другу адреса.'
            : a.device?.claim ? `Карта забронирована «${esc(a.device.claim.holderName)}». Вы владелец — меняете её настройки насовсем, а не на время брони.` : '',
      cfg: a.ip,
      category: a.wantCategory || a.category,
      save: (v) => post('/api/v1/net/adapter/ip', { guid: a.guid, ip: v.ip, category: v.category }),
    });
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const nodeEl = t.closest('[data-nm]');
    if (nodeEl && $('#netMap').contains(nodeEl)) {
      selected = nodeEl.dataset.nm;
      render();
      const card = document.getElementById(selected.startsWith('sw:') ? `card-sw-${selected.slice(3)}` : `card-a-${selected}`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (t.id === 'btnNewSwitch') { openSwitch(); return; }
    if (t.id === 'btnNewVnic') { openVnic(); return; }
    if (t.id === 'btnNetRefresh') { action(t, () => load()); return; }

    const d = t.dataset;
    if (d.ip) { const a = byGuid(d.ip); if (a) adapterIp(a); return; }
    if (d.bridgeIp) {
      const on = d.bridgeIp === '1';
      if (!on && !confirm('Выключить IP на адаптере моста? Этот компьютер перестанет быть в сети карты.')) return;
      action(t, () => post('/api/v1/net/bridge/ip', { enabled: on }).then(load), on ? 'IP на мосту включён' : 'IP на мосту выключен');
      return;
    }
    if (d.cat) {
      const [guid, category] = d.cat.split('|');
      action(t, () => post('/api/v1/net/adapter/category', { guid, category }).then((r) => { if (r.pending) toast(r.note); return load(); }));
      return;
    }
    if (d.vnicEdit) { const a = byGuid(d.vnicEdit); if (a) openVnic(null, a); return; }
    if (d.vnicDelete) {
      const a = byGuid(d.vnicDelete);
      if (a && confirm(`Удалить адаптер «${a.name}»? Он исчезнет из Windows вместе с настройками.`)) {
        action(t, () => post('/api/v1/net/vnic/delete', { guid: a.guid }).then(load), 'Адаптер удалён');
      }
      return;
    }
    if (d.newSwitchNic) { openSwitch(d.newSwitchNic); return; }
    if (d.swRename) {
      const sw = map.switches.find((s) => s.id === d.swRename);
      const name = sw && prompt('Новое имя коммутатора', sw.name);
      if (name && name !== sw.name) action(t, () => post('/api/v1/net/switch/rename', { id: sw.id, name }).then(load));
      return;
    }
    if (d.swVnic) { openVnic(d.swVnic); return; }
    if (d.swHost) {
      const [id, flag] = d.swHost.split('|');
      if (flag === '0' && !confirm('Отключить этот компьютер от сети карты? На мосту выключится IP.')) return;
      action(t, () => post('/api/v1/net/switch/host', { id, enabled: flag === '1' }).then(load));
      return;
    }
    if (d.swDelete) {
      const sw = map.switches.find((s) => s.id === d.swDelete);
      if (sw && confirm(`Удалить коммутатор «${sw.name}»?${sw.external ? ' Мост разберётся, карта вернётся к своим настройкам.' : ''} Виртуальные адаптеры останутся — неподключёнными.`)) {
        toast('Коммутатор удаляется…');
        action(t, () => post('/api/v1/net/switch/delete', { id: sw.id }).then(load), 'Коммутатор удалён');
      }
      return;
    }
    if (d.swAddnic || d.swAddnicOne) {
      const [id, fixed] = (d.swAddnic || d.swAddnicOne).split('|');
      const guid = fixed || document.querySelector(`[data-sw-nicsel="${CSS.escape(id)}"]`)?.value;
      const sw = map.switches.find((s) => s.id === id);
      const a = byGuid(guid);
      if (!sw || !a) return;
      const merge = sw.nics.length > 0;
      if (!confirm(merge
        ? `Добавить «${a.name}» в коммутатор «${sw.name}»? В нём уже есть карта — две сети сольются в одну.`
        : `Включить «${a.name}» в коммутатор «${sw.name}»? Связь на карте прервётся на несколько секунд.`)) return;
      toast('Собирается мост — это до минуты…');
      action(t, () => post('/api/v1/net/switch/nic', { id, guid, add: true }).then(load), 'Карта в коммутаторе');
      return;
    }
    if (d.swDropnic) {
      const [id, guid] = d.swDropnic.split('|');
      const a = byGuid(guid);
      if (!confirm(`Вывести «${a?.name || 'карту'}» из коммутатора? Она вернётся к своим настройкам IP.`)) return;
      action(t, () => post('/api/v1/net/switch/nic', { id, guid, add: false }).then(load), 'Карта выведена');
    }
  });

  // ------------------------------------------------------- у держателя

  /** Настройки занятой сетевой карты — из «Занято мной». */
  function openHeldIp(attachmentId, deviceId) {
    const s = getState();
    const a = s.attachments.find((x) => x.id === attachmentId);
    const p = a?.parts.find((x) => x.deviceId === deviceId);
    if (!p) return;
    let cfg = p.ip;
    if (!p.adapter) {
      // Бронь: настройки — у владельца, берём их из каталога.
      const entries = s.catalog.flatMap((e) => (e.kind === 'group' ? e.members : [e]));
      cfg = entries.find((e) => e.ownerId === a.nodeId && e.target === deviceId)?.meta?.ip || null;
    }
    openIp({
      title: `Настройки IP — ${p.adapter || p.description || p.title}`,
      sub: p.adapter
        ? `Карта проброшена к вам: это ваш адаптер «${esc(p.adapter)}», и меняются его настройки. У владельца ничего не меняется. Новые адреса приложение объявит в сеть владельца. После освобождения адаптер очистится.`
        : `Карта забронирована: она у «${esc(a.nodeName)}», и настройки поменяет его приложение. При освобождении карта получит прежние настройки обратно.`,
      cfg,
      category: p.adapter ? 'Private' : null,
      showCategory: Boolean(p.adapter),
      save: (v) => post('/api/v1/net/held/ip', { attachmentId, deviceId, ip: v.ip, category: v.category }),
    });
  }

  return { onState, onShow, onNetEvent: () => { if (visible()) load(); }, openHeldIp };
}
