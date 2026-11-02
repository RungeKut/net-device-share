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

import { t, srv } from './i18n.js';

/** Как часто перечитывать карту, пока вкладка открыта. */
const POLL_MS = 6000;

const NODE_W = 212;
const NODE_H = 86;
const COL_GAP = 64;
const ROW_GAP = 14;
const BAND_GAP = 26;

const CATEGORY = {
  Private: t('common.private'),
  Public: t('common.public'),
  DomainAuthenticated: t('common.domain'),
};

const ROLE = {
  physical: t('common.physicalNic'),
  wifi: 'Wi-Fi',
  bridge: t('common.bridgeAdapterThisComputer'),
  vnic: t('common.virtualAdapter'),
  uplink: t('common.switchUplink'),
  lend: t('common.sharedNicsBridge'),
  borrow: t('common.someonesNicAtYourSide'),
  tap: t('common.anotherProgramsTapAdapter'),
  virtual: t('common.softwareAdapter'),
};

export function initNet(h) {
  const { $, esc, post, action, toast, canEdit, getState, routeWarning } = h;
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
      error = srv(e);
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

  /** Кем адаптер приходится этому компьютеру — подпись на карте и карточке. */
  function roleText(a) {
    if (a.adopted) return t('common.anotherProgramsTapAdapterIn');
    if (a.role === 'virtual' && a.hyperv) return t('common.hypervAdapter');
    return ROLE[a.role] || a.role;
  }

  /** Где адаптер сейчас — для списков «подключить к коммутатору». */
  function portNote(a) {
    if (a.role === 'tap') return t('common.notCreatedByTheApp');
    const sw = map.switches.find((s) => s.id === a.switchId);
    return sw ? t('net.currentlyInSwitch', { name: sw.name }) : t('common.notConnected');
  }

  function addrText(a) {
    if (a.bridged) return t('common.bridgedTheAddressIsOn');
    if (a.tcpip === false) return t('common.ipOff');
    const live = (a.addresses || []).filter((x) => !x.address.startsWith('169.254.'));
    if (live.length) {
      const shown = live.slice(0, 2).map((x) => `${x.address}/${x.prefixLength}`).join(', ');
      return `${shown}${live.length > 2 ? ` +${live.length - 2}` : ''}${a.ip?.dhcp ? ' (DHCP)' : ''}`;
    }
    if (a.ip && !a.ip.dhcp && a.ip.addresses?.length) return t('net.noLinkAddress', { address: `${a.ip.addresses[0].address}/${a.ip.addresses[0].prefixLength}` });
    if (a.ip?.dhcp) return t('common.dhcpNoAddress');
    return t('common.noAddress');
  }

  /** Настройки IP одной строкой — как в каталоге. */
  function cfgText(ip) {
    if (!ip) return t('common.notRead');
    const parts = [];
    if (ip.dhcp) parts.push(ip.lease ? `DHCP, ${t('net.currentLease', { address: `${ip.lease.address}/${ip.lease.prefixLength ?? '?'}` })}` : 'DHCP');
    else parts.push(`${(ip.addresses || []).map((x) => `${x.address}/${x.prefixLength}`).join(', ') || t('common.noAddress_2')} ${t('net.manual')}`);
    const gw = ip.dhcp ? ip.lease?.gateways : ip.gateways;
    if (gw?.length) parts.push(t('net.gateway', { list: gw.join(', ') }));
    const dns = ip.dns?.length ? ip.dns : ip.lease?.dns || [];
    if (dns.length) parts.push(`DNS ${dns.join(', ')}`);
    return parts.join(' · ');
  }

  function statusBadge(a) {
    if (a.status === 'Up') return '';
    if (a.status === 'Disconnected') return `<span class="pill plain">${t('common.noLink')}</span>`;
    if (a.status === 'Disabled') return `<span class="pill err">${t('common.disabled')}</span>`;
    return a.status ? `<span class="pill plain">${esc(a.status)}</span>` : '';
  }

  function categoryBadge(a) {
    const c = a.category;
    if (!c) return '';
    const cls = c === 'Public' ? 'warn' : 'plain';
    const tip = c === 'Public'
      ? t('common.publicNetworkTheFirewallWindows')
      : t('common.privateNetworkIncomingConnectionsAre');
    return `<span class="pill ${cls}" title="${esc(tip)}">${t('net.networkTypePrefix')} ${esc(CATEGORY[c] || c)}</span>`;
  }

  function claimBadge(a) {
    const d = a.device;
    if (!d) return '';
    if (d.preparing) return `<span class="pill warn">${t('common.beingPrepared')}</span>`;
    if (!d.claim) return d.shared ? `<span class="pill free">${t('common.published')}</span>` : '';
    const who = esc(d.claim.holderName);
    return a.lend || (d.hasTransport && a.bridged)
      ? `<span class="pill busy">${t('net.sharedTo', { who })}</span>`
      : `<span class="pill busy" title="${esc(t('common.theNicCannotBeForwarded'))}">${t('net.bookingFor', { who })}</span>`;
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
        title: d.claim.holderName, sub: forwarded ? t('net.ownerLine') : t('net.ownerLineBooked'),
        line: forwarded ? t('net.ownerSubForward', { name: a.name }) : t('net.ownerSubLocal'),
      });
      b.edges.push({ from: from.id, to: r.id, style: forwarded ? 'forward' : 'reserve', label: forwarded ? t('net.edgeLabelForward') : t('net.edgeLabelBooking') });
    };

    // Мост Windows со всем, что к нему подключено.
    if (m.bridge) {
      const b = band();
      const sw = m.bridge.owner?.kind === 'switch' ? m.switches.find((s) => s.id === m.bridge.owner.id) : null;
      const lendTap = A.find((a) => a.role === 'lend');
      const center = node(b, {
        id: sw ? `sw:${sw.id}` : 'bridge', col: 2, kind: sw ? 'switch' : 'bridge',
        title: sw ? sw.name : t('common.windowsBridge'),
        sub: sw ? t('common.switchWindowsBridge') : m.bridge.owner?.kind === 'lend' ? t('common.sharedNicsBridge') : t('common.aBridgeNotBuiltBy'),
        line: sw?.problem || (m.bridge.ipEnabled === false ? t('common.ipTurnedOffForThe') : ''),
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
        const holder = lendTap.lend.holderName || nic?.device?.claim?.holderName || t('common.taker');
        const r = node(b, {
          id: `remote:${lendTap.guid}`, col: 3, kind: 'remote', title: holder,
          sub: lendTap.lend.connected ? t('common.tookTheNicLinkConnected') : t('common.tookTheNicLinkWaiting'),
          line: t('net.hasAdapterNic', { nic: lendTap.lend.nic }), problem: !lendTap.lend.connected,
        });
        b.edges.push({ from: center.id, to: r.id, style: 'forward', label: t('common.forward') });
        if (nic) shown.add(`claim:${nic.guid}`);
      }
    }

    // Коммутаторы без моста: внутренние и внешние, чей мост разобран.
    for (const sw of m.switches || []) {
      if (shown.has(`sw:${sw.id}`)) continue;
      const b = band();
      const center = node(b, {
        id: `sw:${sw.id}`, col: 2, kind: 'switch', title: sw.name,
        sub: sw.external ? t('common.switchNoBridge') : t('common.internalSwitch'),
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
      const owner = label.includes(' на ') ? label.split(' на ').pop() : (a.borrow?.host || t('common.owner'));
      const card = label.includes(' на ') ? label.slice(0, label.lastIndexOf(' на ')) : t('common.nic');
      const r = node(b, {
        id: `owner:${a.guid}`, col: 0, kind: 'remote', title: owner,
        sub: t('net.ownerLabel', { card }), line: a.borrow?.host || '', problem: a.borrow && !a.borrow.connected,
      });
      const n = adapterNode(b, a, 3);
      b.edges.push({ from: r.id, to: n.id, style: 'forward', label: a.borrow?.connected ? t('common.forward') : t('common.forwardLinkLost') });
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
    if (a.working) badges.push(`<span class="nm-b">${t('common.inUse')}</span>`);
    if (a.status && a.status !== 'Up') badges.push(`<span class="nm-b off">${a.status === 'Disconnected' ? t('common.noLink') : esc(a.status)}</span>`);
    if (a.category === 'Public') badges.push(`<span class="nm-b warn" title="${esc(t('net.nmPublicTitle'))}">${t('common.public_2')}</span>`);
    if (a.device?.claim && !a.bridged) badges.push(`<span class="nm-b busy">${t('ui.booking')}</span>`);
    if (a.device?.heldEdit) badges.push(`<span class="nm-b busy" title="${esc(t('common.settingsChangedByTheBooking'))}">${t('common.holdersAddress')}</span>`);
    return `<div class="nm-node nm-a-${a.role}${a.status !== 'Up' ? ' nm-down' : ''}${selected === a.guid ? ' nm-sel' : ''}"
      style="left:${n.x}px;top:${n.y}px;width:${NODE_W}px;height:${NODE_H}px" data-nm="${esc(a.guid)}"
      title="${esc(`${a.name}\n${a.description}\nMAC ${a.mac || '—'}`)}">
      <div class="nm-title">${icon} ${esc(a.name)}</div>
      <div class="nm-sub">${esc(roleText(a))}</div>
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
    if (error) out.push(`<div class="banner err">${t('net.mapNotRead')}: ${esc(error)}</div>`);
    if (!map) { $('#netNotes').innerHTML = out.join('') || `<div class="empty">${t('common.readingTheNetworkComposition')}</div>`; return; }
    if (map.supported === false) { $('#netNotes').innerHTML = `<div class="empty">${esc(map.reason)}</div>`; return; }
    if (map.createNote) out.push(`<div class="banner info">${esc(map.createNote)}</div>`);
    if (map.busy) out.push(`<div class="banner">⏳ ${esc(map.busy)}${t('net.bridgeChangesSeconds')}</div>`);
    const fw = map.firewall;
    if (fw?.thirdParty?.length) {
      out.push(`<div class="banner info">${t('net.firewallNote', { list: esc(fw.thirdParty.join(', ')) })}</div>`);
    }
    const lendHost = map.adapters.find((a) => a.role === 'bridge');
    if (map.bridge?.owner?.kind === 'lend') {
      const ipState = lendHost?.tcpip === false ? t('common.offTheComputerItselfIs') : t('common.on');
      out.push(`<div class="banner info">${t('net.lendBridgeNote', { nic: esc(map.bridge.owner.nic), ipState })}</div>`);
    }
    $('#netNotes').innerHTML = out.join('');
  }

  function switchCard(sw) {
    const vnics = map.adapters.filter((a) => a.role === 'vnic' && a.switchId === sw.id);
    const nics = sw.nics.map((n) => map.adapters.find((a) => a.guid === n.guid)?.name || n.name);
    const host = sw.external ? map.adapters.find((a) => a.role === 'bridge') : null;
    // Мост в Windows один: карту можно добавить только туда, где он уже есть,
    // или куда угодно, пока его нет ни у кого.
    const bridgeOwner = map.switches.find((s) => s.external);
    const candidates = !bridgeOwner || bridgeOwner.id === sw.id ? map.adapters.filter((a) => a.can.bridge) : [];
    const portable = map.adapters.filter((a) => a.can.move && a.switchId !== sw.id);
    const acts = [];
    if (may()) {
      acts.push(`<button class="btn small" data-sw-rename="${esc(sw.id)}">${t('common.rename')}</button>`);
      acts.push(`<button class="btn small" data-sw-vnic="${esc(sw.id)}">${t('common.addAdapter')}</button>`);
      if (sw.external) {
        acts.push(`<button class="btn small" data-sw-host="${esc(sw.id)}|${sw.hostAccess ? '0' : '1'}">${sw.hostAccess ? t('common.disconnectTheComputerFromThe') : t('common.connectTheComputerToThe')}</button>`);
      }
      acts.push(`<button class="btn small danger" data-sw-delete="${esc(sw.id)}">${t('common.delete')}</button>`);
    }
    const addNic = may() && candidates.length ? `<div class="row-inline sw-addnic">
        <select data-sw-nicsel="${esc(sw.id)}">${candidates.map((a) => `<option value="${esc(a.guid)}">${esc(a.name)} — ${esc(a.description)}</option>`).join('')}</select>
        <button class="btn small" data-sw-addnic="${esc(sw.id)}">${sw.external ? t('common.addNic') : t('common.uplinkToTheNicsNetwork')}</button>
      </div>` : '';
    const addPort = may() && portable.length ? `<div class="row-inline sw-addnic">
        <select data-sw-portsel="${esc(sw.id)}">${portable.map((a) => `<option value="${esc(a.guid)}">${esc(a.name)} — ${esc(portNote(a))}</option>`).join('')}</select>
        <button class="btn small" data-sw-port="${esc(sw.id)}">${t('common.connectAdapter')}</button>
      </div>` : '';
    return `<article class="card ${sw.problem ? 'error' : 'free'}${selected === `sw:${sw.id}` ? ' sel' : ''}" id="card-sw-${esc(sw.id)}">
      <div class="card-main">
        <div class="card-title">🔀 ${esc(sw.name)}
          <span class="pill ${sw.external ? 'mine' : 'plain'}">${sw.external ? t('common.externalOnTheNicsNetwork') : t('common.internal')}</span>
          ${sw.problem ? `<span class="pill err">${esc(sw.problem)}</span>` : ''}
        </div>
        <div class="card-meta">
          ${sw.external ? `<span>${t('common.nicColon')} <b>${esc(nics.join(', '))}</b>${may() ? sw.nics.map((n) => ` <button class="btn small" data-sw-dropnic="${esc(sw.id)}|${esc(n.guid)}" title="${esc(t('common.removeTheNicFromThe'))}">${t('common.remove')} ${esc(map.adapters.find((a) => a.guid === n.guid)?.name || n.name)}</button>`).join('') : ''}</span>` : ''}
          ${sw.external ? `<span>${t('common.computerInNicNetwork')}: <b>${sw.hostAccess ? t('common.yes') : t('common.no')}</b>${host ? ` — ${t('common.adapterNamed', { name: esc(host.name) })}` : ''}</span>` : ''}
          <span>${t('common.adaptersColon')} ${vnics.length ? vnics.map((a) => `<b>${esc(a.name)}</b>${a.adopted ? ` <span class="muted">${t('common.foreign')}</span>` : ''}`).join(', ') : t('common.no')}</span>
          ${sw.stats ? `<span>${t('common.macInTable')}: ${sw.stats.macs}</span>` : ''}
        </div>
        ${addNic}
        ${addPort}
      </div>
      <div class="card-actions">${acts.join('')}</div>
    </article>`;
  }

  function adapterCard(a) {
    const acts = [];
    const sw = map.switches.find((s) => s.id === a.switchId);
    if (may()) {
      if (a.can.ip) acts.push(`<button class="btn small" data-ip="${esc(a.guid)}">${t('common.ipSettings')}</button>`);
      if (a.role === 'bridge') {
        acts.push(`<button class="btn small" data-bridge-ip="${a.tcpip === false ? '1' : '0'}">${a.tcpip === false ? t('common.turnIpOn') : t('common.turnIpOff')}</button>`);
      }
      if (a.category === 'Public' && a.can.category) {
        acts.push(`<button class="btn small" data-cat="${esc(a.guid)}|Private" title="${esc(t('common.incomingConnectionsFromThisNetwork'))}">${t('common.makeTheNetworkPrivate')}</button>`);
      }
      // Соединить: TAP — портом коммутатора, остальное — мостом, как карту.
      if (a.can.move && !a.switchId) {
        acts.push(map.switches.length
          ? `<button class="btn small" data-a-connect="${esc(a.guid)}">${t('common.toASwitch')}</button>`
          : `<button class="btn small" data-new-switch-port="${esc(a.guid)}">${t('common.aSwitchForThisAdapter')}</button>`);
      }
      if (a.can.bridge) {
        const ext = map.switches.find((s) => s.external);
        if (ext) acts.push(`<button class="btn small" data-sw-addnic-one="${esc(ext.id)}|${esc(a.guid)}">${t('common.intoSwitch', { name: esc(ext.name) })}</button>`);
        else acts.push(`<button class="btn small" data-new-switch-nic="${esc(a.guid)}">${t('common.aSwitchOn', { what: a.role === 'physical' ? t('common.thisNic') : t('common.thisAdapter') })}</button>`);
      }
      if (a.can.unbridge && sw) {
        acts.push(`<button class="btn small" data-sw-dropnic="${esc(sw.id)}|${esc(a.guid)}">${t('common.removeFromSwitch')}</button>`);
      }
      if (a.can.rename || a.can.mac || (a.can.move && a.switchId)) {
        acts.push(`<button class="btn small" data-a-edit="${esc(a.guid)}">${t('common.edit_2')}</button>`);
      }
      if (a.can.enable) {
        const off = a.status === 'Disabled';
        acts.push(`<button class="btn small" data-a-enable="${esc(a.guid)}|${off ? '1' : '0'}">${off ? t('common.enable') : t('common.disable')}</button>`);
      }
      if (a.can.release) {
        acts.push(`<button class="btn small" data-a-release="${esc(a.guid)}" title="${esc(t('common.removeFromTheSwitchThe'))}">${t('common.release')}</button>`);
      }
      if (a.can.delete) acts.push(`<button class="btn small danger" data-a-delete="${esc(a.guid)}">${t('common.delete')}</button>`);
    }
    // Отказ во всём перекрывает отказ в настройках IP — он о том же.
    const why = [a.why?.manage || a.why?.ip].filter(Boolean);
    const pills = [
      `<span class="pill plain">${esc(roleText(a))}</span>`,
      statusBadge(a),
      a.working ? `<span class="pill mine" title="${esc(t('common.theAppWorksThroughThis'))}">${t('common.inUse')}</span>` : '',
      a.bridged ? `<span class="pill plain">${t('common.inBridge')}${sw ? ` · «${esc(sw.name)}»` : ''}</span>` : '',
      categoryBadge(a),
      claimBadge(a),
      a.device?.heldEdit ? `<span class="pill busy">${t('common.theAddressWasSetBy')}</span>` : '',
      a.borrow ? `<span class="pill ${a.borrow.connected ? 'mine' : 'err'}">${a.borrow.connected ? t('common.linkConnected') : t('common.linkWaitingForTheOwner')}</span>` : '',
      a.port?.failed ? `<span class="pill err" title="${esc(a.port.failed)}">${t('net.adapterNotRaised')}</span>` : '',
    ].join(' ');
    const live = (a.addresses || []).map((x) => `${x.address}/${x.prefixLength}${x.state && x.state !== 'Preferred' ? ` (${x.state === 'Duplicate' ? t('common.takenBySomeoneElse') : x.state})` : ''}`);
    return `<article class="card ${a.status === 'Up' ? '' : 'offline'}${selected === a.guid ? ' sel' : ''}" id="card-a-${esc(a.guid)}">
      <div class="card-main">
        <div class="card-title">${esc(a.name)} ${pills}</div>
        <div class="card-meta">
          <span>${esc(a.description)}</span>
          ${a.mac ? `<span>MAC: <span class="mono">${esc(a.mac)}</span></span>` : ''}
          ${a.speed && a.status === 'Up' ? `<span>${esc(a.speed)}</span>` : ''}
          ${a.bridged || a.tcpip === false ? '' : `<span>${t('net.settingsLabel')}: ${esc(cfgText(a.ip))}</span>`}
          ${live.length && !a.bridged ? `<span>${t('net.currentLabel')}: <span class="mono">${esc(live.join(', '))}</span></span>` : ''}
          ${a.metric && !a.bridged && a.tcpip !== false ? `<span>${t('net.metricLabel', { m: esc(a.metric) })}</span>` : ''}
          ${a.profile ? `<span>${t('net.windowsNetworkLabel')}: «${esc(a.profile.name)}»</span>` : ''}
          ${a.borrow?.announced?.length ? `<span title="${esc(t('common.addressesAnnouncedIntoTheOwners'))}">${t('net.announcedLabel')}: <span class="mono">${esc(a.borrow.announced.join(', '))}</span></span>` : ''}
          ${a.device?.transportNote && a.role !== 'bridge' ? `<span class="muted">${t('net.forwardLabel')}: ${esc(a.device.transportNote)}</span>` : ''}
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
      : `<div class="empty">${t('common.noSwitchesYetCreateSwitch')}</div>`;
    const order = { borrow: 0, vnic: 1, bridge: 2, physical: 3, wifi: 4, lend: 5, uplink: 6, virtual: 7, tap: 8 };
    const list = [...map.adapters].sort((x, y) => (order[x.role] ?? 9) - (order[y.role] ?? 9) || x.name.localeCompare(y.name));
    $('#netAdapters').innerHTML = list.map(adapterCard).join('');
  }

  // ------------------------------------------------------------ редактор IP

  /** Разобрать строку адреса: «10.0.0.5/24», «10.0.0.5 24», «10.0.0.5 255.255.255.0». */
  function parseAddr(line) {
    const m = line.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\s*\/\s*(\d{1,2})|\s+(\d{1,3}(?:\.\d{1,3}){3})|\s+(\d{1,2}))?$/);
    if (!m) throw new Error(t('net.parseAddrError', { line: line.trim() }));
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
        <span>${t('net.ip.ipv4Address')}</span>
        <label class="check"><input type="radio" name="${id}-mode" value="dhcp" ${c.dhcp ? 'checked' : ''}> ${t('net.ip.auto')}</label>
        <label class="check"><input type="radio" name="${id}-mode" value="static" ${c.dhcp ? '' : 'checked'}> ${t('net.ip.static')}</label>
      </div>
      <label class="field ${id}-st">
        <span>${t('net.ip.addrsField')}</span>
        <textarea id="${id}-addrs" rows="3" spellcheck="false" placeholder="${t('net.selPlaceholder')}">${esc((c.addresses || []).map((a) => `${a.address}/${a.prefixLength}`).join('\n'))}</textarea>
        <small>${t('net.ip.addrsHint')}</small>
      </label>
      <div class="grid2">
        <label class="field ${id}-st"><span>${t('common.gateway')}</span><input type="text" id="${id}-gw" placeholder="${t('common.optional')}" value="${esc((c.gateways || []).join(', '))}"></label>
        <label class="field"><span>DNS</span><input type="text" id="${id}-dns" placeholder="${t('common.commaseparatedOptional')}" value="${esc((c.dns || []).join(', '))}"></label>
      </div>
      ${showCategory ? `<label class="field">
        <span>${t('net.ip.networkType')}</span>
        <select id="${id}-cat">
          <option value="">${t('net.ip.notChange')}</option>
          <option value="Private" ${category === 'Private' ? 'selected' : ''}>${t('net.ip.catPrivate')}</option>
          <option value="Public" ${category === 'Public' ? 'selected' : ''}>${t('net.ip.catPublic')}</option>
        </select>
        <small>${esc(categoryNote || t('net.ip.catHint'))}</small>
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
        if (!dhcp && !addresses.length) throw new Error(t('common.enterAtLeastOneAddress'));
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
      toast(srv(e), 'err');
      return;
    }
    toast(t('common.applying'));
    pending.save(v)
      .then((r) => { toast(r?.pending ? r.note : t('common.settingsApplied'), 'ok'); if (r?.routeWarn?.length) routeWarning(r); load(); })
      .catch((e) => toast(srv(e), 'err'));
  });

  // ----------------------------------------------------------- коммутатор

  /**
   * Окно нового коммутатора.
   * @param {{ nic?: string, port?: string }} [pre] — что отметить сразу:
   *   карту для моста или адаптер-порт
   */
  function openSwitch({ nic = null, port = null } = {}) {
    // Карты и прочие адаптеры, которые мост мог бы взять; кому нельзя —
    // видно почему. Мост в Windows один: если он уже у коммутатора, новый
    // будет внутренним.
    const owner = map.switches.find((s) => s.external);
    const nics = map.adapters.filter((a) => ['physical', 'wifi', 'virtual'].includes(a.role) && !a.bridged);
    $('#swName').value = '';
    $('#swHost').checked = true;
    $('#swNics').innerHTML = nics.length
      ? nics.map((a) => {
        const why = owner ? t('net.bridgeAlreadyAtSwitch', { name: owner.name })
          : a.can.bridge ? '' : (a.why?.move || a.why?.manage || t('common.cannotJoinABridge'));
        return `<label class="member${why ? ' muted' : ''}"><input type="checkbox" value="${esc(a.guid)}"
          ${a.guid === nic && !why ? 'checked' : ''} ${why ? 'disabled' : ''}> ${esc(a.name)} — ${esc(a.description)}
          <span class="muted">${esc(addrText(a))}${why ? ` · ${esc(why)}` : ''}</span></label>`;
      }).join('')
      : `<div class="muted">${t('common.noFreeNicsTheSwitch')}</div>`;
    const ports = map.adapters.filter((a) => a.can.move);
    $('#swPorts').innerHTML = ports.length
      ? ports.map((a) => `<label class="member"><input type="checkbox" value="${esc(a.guid)}"
          ${a.guid === port ? 'checked' : ''}> ${esc(a.name)} — ${esc(a.description)}
          <span class="muted">${esc(addrText(a))} · ${esc(portNote(a))}</span></label>`).join('')
      : `<div class="muted">${t('common.noTapAdaptersToConnect')}</div>`;
    const warn = () => {
      const n = $('#swNics').querySelectorAll('input:checked').length;
      $('#swWarn').textContent = n > 1
        ? t('common.twoNicsInOneSwitch')
        : n === 1 ? t('common.theNicsLinkDropsFor')
          : t('common.internalSwitchJoinsOnlyThis');
    };
    $('#swNics').onchange = warn;
    warn();
    $('#switchDialog').showModal();
  }

  $('#switchDialog').addEventListener('close', () => {
    if ($('#switchDialog').returnValue !== 'save') return;
    const nics = [...$('#swNics').querySelectorAll('input:checked')].map((el) => el.value);
    const ports = [...$('#swPorts').querySelectorAll('input:checked')].map((el) => el.value);
    const body = { name: $('#swName').value, nics, ports, hostAccess: $('#swHost').checked };
    toast(nics.length ? t('common.assemblingTheBridgeUpTo') : ports.length ? t('common.creatingTheSwitchConnectingThe') : t('common.creatingTheSwitch'));
    post('/api/v1/net/switch/create', body)
      .then((r) => {
        if (r?.warnings?.length) toast(t('net.switchCreatedWithWarnings', { warnings: r.warnings.join('; ') }), 'err');
        else toast(t('common.switchCreated'), 'ok');
        load();
      })
      .catch((e) => toast(srv(e), 'err'));
  });

  // ------------------------------------------------------------- адаптер

  const TAP_MAC_HINT = t('common.theTapDriverAcceptsOnly') + ' '
    + t('common.itWillNotAcceptA');
  const NIC_MAC_HINT = t('common.theDriverUsuallyAcceptsAny') + ' '
    + t('common.andYouWillSeeAn');

  let vnicIp = null;
  /**
   * Окно адаптера: новый виртуальный (a не задан) или правка любого — своего
   * или чужого. Поля, которые у этого адаптера менять нельзя, скрыты, а
   * почему — написано внизу.
   *
   * @param {string|null} switchId — коммутатор нового адаптера
   * @param {object|null} a — адаптер из карты
   * @param {{ connect?: boolean }} [o] — сразу предложить коммутатор
   */
  function openVnic(switchId = null, a = null, { connect = false } = {}) {
    vnicMode = a ? { edit: a.guid, was: a } : { edit: null };
    const can = a ? a.can : { rename: true, mac: true, move: true };
    // TAP подключается портом; остальные — мостом, как карта.
    const port = a ? can.move : true;
    const viaBridge = Boolean(a && !port && (can.bridge || can.unbridge));
    $('#vnicTitle').textContent = a ? t('common.adapter', { name: a.name }) : t('common.newVirtualAdapter');
    $('#vnicSub').textContent = a ? `${a.description} · ${roleText(a)}` : '';
    $('#vnicSave').textContent = a ? t('common.save') : t('common.create');

    const taken = new Set(map.adapters.map((x) => x.name));
    let n = 1;
    while (taken.has(t('net.benchDefault', { n }))) n++;
    $('#vnicNameRow').hidden = !can.rename;
    $('#vnicName').value = a ? a.name : t('net.benchDefault', { n });

    let options = map.switches;
    if (viaBridge) {
      const owner = map.switches.find((s) => s.external);
      options = a.switchId ? map.switches.filter((s) => s.id === a.switchId) : owner ? [owner] : map.switches;
    }
    $('#vnicSwitchRow').hidden = !(port || viaBridge);
    $('#vnicSwitch').innerHTML = `<option value="">${a?.adopted ? t('common.dontConnectReleaseTheAdapter') : t('common.dontConnect')}</option>`
      + options.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.external ? ` ${t('common.onTheNicsNetwork')}` : ''}</option>`).join('');
    $('#vnicSwitch').value = a ? (a.switchId || (connect ? options[0]?.id || '' : '')) : (switchId || map.switches[0]?.id || '');
    $('#vnicSwitchHint').textContent = viaBridge
      ? t('common.thisAdapterJoinsTheSwitch')
      : a?.role === 'tap'
        ? t('common.thisAdapterWasNotCreated')
        : a?.adopted ? t('common.thisAdapterWasNotCreated_2') : '';

    $('#vnicMacRow').hidden = !can.mac;
    $('#vnicMacMode').value = '';
    $('#vnicMacMode').querySelector('option[value="factory"]').hidden = !a;
    $('#vnicMac').value = '';
    $('#vnicMac').hidden = true;
    $('#vnicMacHint').textContent = !a || a.tap ? TAP_MAC_HINT : NIC_MAC_HINT;

    const notes = [];
    if (a && can.mac) notes.push(t('net.currentMac', { mac: a.mac || '—', custom: a.macCustom ? t('net.macCustom') : '' }) + ' ' + t('net.macRestartHint'));
    if (a) {
      const labels = { rename: t('common.name_2'), mac: 'MAC', move: t('common.switch') };
      for (const [k, label] of Object.entries(labels)) {
        if (a.why?.[k] && !(k === 'move' && (port || viaBridge))) notes.push(t('net.labelNotChanged', { label, reason: a.why[k] }));
      }
    }
    $('#vnicNote').textContent = notes.join(' ');
    // Адрес — в отдельном окне у готового адаптера; при создании — сразу.
    $('#vnicIp').hidden = Boolean(a);
    vnicIp = a ? null : ipEditor($('#vnicIp'), null, { category: 'Private' });
    $('#vnicDialog').showModal();
  }

  $('#vnicMacMode').addEventListener('change', () => { $('#vnicMac').hidden = $('#vnicMacMode').value !== 'set'; });

  $('#vnicDialog').addEventListener('close', () => {
    if ($('#vnicDialog').returnValue !== 'save' || !vnicMode) return;
    const mode = $('#vnicMacMode').value;
    const mac = mode === 'random' ? 'random' : mode === 'set' ? $('#vnicMac').value.trim() : mode === 'factory' ? '' : undefined;
    if (vnicMode.edit) {
      const was = vnicMode.was;
      const patch = {};
      if (!$('#vnicNameRow').hidden && $('#vnicName').value.trim() !== was.name) patch.name = $('#vnicName').value;
      if (!$('#vnicMacRow').hidden && mac !== undefined) patch.mac = mac;
      if (!$('#vnicSwitchRow').hidden && ($('#vnicSwitch').value || null) !== (was.switchId || null)) {
        patch.switchId = $('#vnicSwitch').value || null;
      }
      if (!Object.keys(patch).length) return;
      const bridging = patch.switchId !== undefined && !was.can.move;
      if (bridging && !confirm(patch.switchId
        ? t('net.confirmBridgeJoin', { name: was.name })
        : t('net.confirmBridgeLeave', { name: was.name }))) return;
      toast(bridging ? t('common.changingTheBridgeUpTo') : t('common.changingTheAdapter'));
      post('/api/v1/net/adapter/update', { guid: was.guid, ...patch })
        .then(() => { toast(t('common.done'), 'ok'); load(); })
        .catch((e) => toast(srv(e), 'err'));
      return;
    }
    let v;
    try { v = vnicIp.read(); } catch (e) { toast(srv(e), 'err'); return; }
    toast(t('common.creatingTheAdapterUpTo'));
    post('/api/v1/net/vnic/create', {
      name: $('#vnicName').value, switchId: $('#vnicSwitch').value || null, mac: mac || null, ip: v.ip, category: v.category || 'Private',
    })
      .then(() => { toast(t('common.adapterCreated'), 'ok'); load(); })
      .catch((e) => toast(srv(e), 'err'));
  });

  // ------------------------------------------------------------- действия

  const byGuid = (g) => map?.adapters.find((a) => a.guid === g);

  function adapterIp(a) {
    const borrow = a.role === 'borrow';
    openIp({
      title: t('net.ipSettingsFor', { name: a.name }),
      sub: borrow
        ? t('net.ipBorrowSub')
        : a.role === 'bridge'
          ? (map.bridge?.owner?.kind === 'lend'
            ? t('net.ipBridgeLendNote')
            : t('net.ipBridgeNote'))
          : a.role === 'vnic' ? t('net.ipVnicNote')
            : a.device?.claim ? t('net.ipClaimedNote', { holder: esc(a.device.claim.holderName) }) : '',
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
      if (!on && !confirm(t('common.turnIpOffOnThe'))) return;
      action(t, () => post('/api/v1/net/bridge/ip', { enabled: on }).then(load), on ? t('common.ipTurnedOnForThe') : t('common.ipTurnedOffForThe'));
      return;
    }
    if (d.cat) {
      const [guid, category] = d.cat.split('|');
      action(t, () => post('/api/v1/net/adapter/category', { guid, category }).then((r) => { if (r.pending) toast(r.note); return load(); }));
      return;
    }
    if (d.aEdit) { const a = byGuid(d.aEdit); if (a) openVnic(null, a); return; }
    if (d.aConnect) { const a = byGuid(d.aConnect); if (a) openVnic(null, a, { connect: true }); return; }
    if (d.aEnable) {
      const [guid, flag] = d.aEnable.split('|');
      const a = byGuid(guid);
      if (!a) return;
      if (flag === '0' && !confirm(t('net.disableAdapter.confirm', { name: a.name }))) return;
      action(t, () => post('/api/v1/net/adapter/update', { guid, enabled: flag === '1' }).then(load), flag === '1' ? t('common.adapterEnabled') : t('common.adapterDisabled'));
      return;
    }
    if (d.aRelease) {
      const a = byGuid(d.aRelease);
      const sw = a && map.switches.find((s) => s.id === a.switchId);
      if (a && confirm(sw
        ? t('net.releaseAdapter.confirmWithSw', { name: a.name, sw: sw.name })
        : t('net.releaseAdapter.confirm', { name: a.name }))) {
        action(t, () => post('/api/v1/net/adapter/update', { guid: a.guid, switchId: null }).then(load), t('common.adapterReleased'));
      }
      return;
    }
    if (d.aDelete) {
      const a = byGuid(d.aDelete);
      if (!a) return;
      const text = a.role === 'vnic' && !a.adopted
        ? t('net.deleteVnic.confirm', { name: a.name })
        : t('net.deleteAdapter.confirm', { name: a.name, desc: a.description });
      if (confirm(text)) action(t, () => post('/api/v1/net/adapter/delete', { guid: a.guid }).then(load), t('common.adapterRemoved'));
      return;
    }
    if (d.newSwitchNic) { openSwitch({ nic: d.newSwitchNic }); return; }
    if (d.newSwitchPort) { openSwitch({ port: d.newSwitchPort }); return; }
    if (d.swPort) {
      const guid = document.querySelector(`[data-sw-portsel="${CSS.escape(d.swPort)}"]`)?.value;
      const a = byGuid(guid);
      if (!a) return;
      if (a.role === 'tap' && !confirm(t('net.connectTap.confirm', { name: a.name }))) return;
      action(t, () => post('/api/v1/net/adapter/update', { guid, switchId: d.swPort }).then(load), t('common.adapterConnected'));
      return;
    }
    if (d.swRename) {
      const sw = map.switches.find((s) => s.id === d.swRename);
      const name = sw && prompt(t('common.newSwitchName'), sw.name);
      if (name && name !== sw.name) action(t, () => post('/api/v1/net/switch/rename', { id: sw.id, name }).then(load));
      return;
    }
    if (d.swVnic) { openVnic(d.swVnic); return; }
    if (d.swHost) {
      const [id, flag] = d.swHost.split('|');
      if (flag === '0' && !confirm(t('common.disconnectThisComputerFromThe'))) return;
      action(t, () => post('/api/v1/net/switch/host', { id, enabled: flag === '1' }).then(load));
      return;
    }
    if (d.swDelete) {
      const sw = map.switches.find((s) => s.id === d.swDelete);
      if (sw && confirm(sw.external
        ? t('net.deleteSwitch.confirmExternal', { name: sw.name })
        : t('net.deleteSwitch.confirm', { name: sw.name }))) {
        toast(t('common.removingTheSwitch'));
        action(t, () => post('/api/v1/net/switch/delete', { id: sw.id }).then(load), t('common.switchRemoved'));
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
        ? t('net.addNicMerge.confirm', { name: a.name, swName: sw.name })
        : t('net.addNic.confirm', { name: a.name, swName: sw.name }))) return;
      toast(t('common.assemblingTheBridgeUpTo'));
      action(t, () => post('/api/v1/net/switch/nic', { id, guid, add: true }).then(load), t('net.nicInSwitch'));
      return;
    }
    if (d.swDropnic) {
      const [id, guid] = d.swDropnic.split('|');
      const a = byGuid(guid);
      if (!confirm(t('net.removeNicFromSwitch.confirm', { name: a?.name || t('common.nic_2') }))) return;
      action(t, () => post('/api/v1/net/switch/nic', { id, guid, add: false }).then(load), t('common.nicRemoved'));
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
    // Мост в сети со статикой: владелец предложил свободный адрес — подставляем
    // его, человеку остаётся проверить и сохранить.
    if (!cfg && p.adapter && p.suggest) {
      cfg = {
        dhcp: false,
        addresses: [{ address: p.suggest.address, prefixLength: p.suggest.prefixLength }],
        gateways: p.suggest.gateways || [],
        dns: p.suggest.dns || [],
      };
    }
    if (!p.adapter) {
      // Бронь: настройки — у владельца, берём их из каталога.
      const entries = s.catalog.flatMap((e) => (e.kind === 'group' ? e.members : [e]));
      cfg = entries.find((e) => e.ownerId === a.nodeId && e.target === deviceId)?.meta?.ip || null;
    }
    openIp({
      title: t('net.ipSettingsFor', { name: p.adapter || p.description || p.title }),
      sub: p.adapter
        ? t('net.heldIpBorrowSub', { adapter: esc(p.adapter) })
        : t('net.heldIpBookedSub', { nodeName: esc(a.nodeName) }),
      cfg,
      category: p.adapter ? 'Private' : null,
      showCategory: Boolean(p.adapter),
      save: (v) => post('/api/v1/net/held/ip', { attachmentId, deviceId, ip: v.ip, category: v.category }),
    });
  }

  return { onState, onShow, onNetEvent: () => { if (visible()) load(); }, openHeldIp };
}
