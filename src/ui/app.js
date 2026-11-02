// Интерфейс пользователя.
//
// Состояние приходит целиком одним объектом по SSE — так экран не может
// разойтись с реальностью: нет частичных обновлений, которые пришлось бы
// сшивать на клиенте.
//
// Уровень доступа приходит в том же снимке (`access`). В режиме только для
// чтения интерфейс не рисует действий, но полагаться на это нельзя —
// права проверяет сервер, здесь лишь убираем заведомо бесполезные кнопки.

import { initNet } from './net.js';
import { getLang, setLang, startI18n, t, srv } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
let state = null;
/** Запуск с этого же компьютера: доступ и так всегда полный, сессия не нужна. */
let sessionLocal = false;
/** Вкладка «Сеть» (net.js); заводится перед подключением к потоку. */
let net = null;
let logBuffer = [];
let bannerDismissed = false;
let shownRequestIds = new Set();
let currentRequest = null;
let askContext = null;
let routeContext = null;
let driverToken = null;
let titleFlashTimer = null;

// ------------------------------------------------------------- утилиты вывода

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** «3 мин», «2 ч 14 мин», «4 дн» — для длительностей в интерфейсе. */
function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} ${t('unit.sec')}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${t('unit.min')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${t('unit.hour')}${m % 60 ? ` ${m % 60} ${t('unit.min')}` : ''}`;
  const d = Math.floor(h / 24);
  return `${d} ${t('unit.day')}${h % 24 ? ` ${h % 24} ${t('unit.hour')}` : ''}`;
}

const since = (ts) => (ts ? duration(Date.now() - ts) : '—');
const at = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '');
const canEdit = () => state && state.access === 'full';

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 8000 : 4000);
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    // Свой заголовок: по нему сервер отличает наш интерфейс от посторонней
    // страницы, которая тоже может послать POST на 127.0.0.1.
    headers: { 'content-type': 'application/json', 'x-nds-ui': '1' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

/** Обёртка для кнопок: блокирует на время запроса и показывает ошибку. */
function action(btn, fn, okMessage) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '…';
  fn()
    .then(() => { if (okMessage) toast(okMessage, 'ok'); })
    .catch((e) => toast(srv(e), 'err'))
    .finally(() => { btn.disabled = false; btn.textContent = label; });
}

// ------------------------------------------------- уведомления о запросах
//
// «Поверх открытых окон» страница сама по себе не умеет — это ограничение
// браузера, а не недоработка. Единственный механизм, рисующий поверх всего,
// это системное уведомление через Notification API. Поэтому здесь сразу три
// способа привлечь внимание: системное уведомление, звук и мигание заголовка
// вкладки, плюс модальное окно в самой странице.

function ensureNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function systemNotify(req) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(t('app.deviceRequest'), {
      body: t('app.requesterAsksFor', { name: req.requesterName, title: req.title })
        + (req.message ? `\n«${req.message}»` : ''),
      tag: req.id,
      requireInteraction: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* браузер может запретить — останутся звук и модальное окно */ }
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    setTimeout(() => ctx.close().catch(() => {}), 800);
  } catch { /* звук — не обязательное средство */ }
}

function flashTitle(on) {
  clearInterval(titleFlashTimer);
  const base = state ? `${state.self.name} — Net Device Share` : 'Net Device Share';
  if (!on) { document.title = base; return; }
  let flip = false;
  titleFlashTimer = setInterval(() => {
    flip = !flip;
    document.title = flip ? t('app.flashTitle') : base;
  }, 900);
}

function handleIncomingRequests() {
  const incoming = (state.requests?.incoming || []).filter((r) => r.state === 'pending');
  if (!incoming.length) {
    flashTitle(false);
    if (currentRequest && !incoming.some((r) => r.id === currentRequest.id)) {
      $('#requestDialog').close();
      currentRequest = null;
    }
    return;
  }

  const req = incoming[0];
  if (currentRequest && currentRequest.id === req.id) return;

  currentRequest = req;
  $('#requestBody').innerHTML = `
    <p class="request-line"><b>${esc(req.requesterName)}</b> ${t('app.asksToRelease')}</p>
    <p class="request-target">${esc(req.title)}</p>
    ${req.message ? `<p class="request-message">«${esc(req.message)}»</p>` : ''}
<p class="dlg-note">${t('app.requestSentAgo', { time: esc(since(req.createdAt)) })}
	      ${incoming.length > 1 ? t('app.moreRequestsInQueue', { count: incoming.length - 1 }) : ''}</p>`;

  const dlg = $('#requestDialog');
  if (!dlg.open) dlg.showModal();

  if (!shownRequestIds.has(req.id)) {
    shownRequestIds.add(req.id);
    systemNotify(req);
    beep();
    flashTitle(true);
  }
}

// --------------------------------------------------------------- отрисовка

/** Пометка «чужая сеть» у владельца в каталоге: его анонсы идут через NAT/туннель. */
function natMark(e) {
  return e.ownerRedirected
    ? ' <span class="pill warn" title="' + t('common.thisNodeAnnouncesANetwork') + ' '
      + t('common.andItsPortsAreNot') + '">' + t('common.foreignNetwork') + '</span>'
    : '';
}

function render() {
  if (!state) return;
  renderHeader();
  renderGhosted();
  renderCatalog();
  renderMine();
  renderGroups();
  renderAttached();
  renderPeers();
  renderUpdate();
  net?.onState();
  // Пока настройки открыты, состояние обмена в них живое: адрес набирают
  // и тут же смотрят, ответил ли узел, а не переоткрывают окно.
  if ($('#settings').open) { renderFederation(); renderRealmNote(); }
  handleIncomingRequests();
}

function renderHeader() {
  const s = state.self;
  $('#selfLine').textContent = s.networks?.length > 1
    ? `${s.name} · ${s.networks.map((n) => `${n.address} (${n.cidr}, ${n.iface})`).join(' · ')}`
    : `${s.name} · ${s.address} · ${t('app.network')} ${s.network} (${s.iface})`;
  if (s.gateway) $('#selfLine').insertAdjacentHTML('beforeend', gatewayMark({ gateway: true }));
  if (!titleFlashTimer) document.title = `${s.name} — Net Device Share`;

  const server = $('#capServer');
  server.className = `cap ${state.backend.server ? 'on' : 'off'}`;
  server.title = state.backend.server ? t('common.ownUsbDevicesCanBe')
    : t('common.theUsbIpServerPart');

  const client = $('#capClient');
  client.className = `cap ${state.backend.client ? 'on' : 'off'}`;
  client.title = state.backend.client ? t('common.othersUsbDevicesCanBe')
    : t('common.theUsbIpClientPart');

  const ro = !canEdit();
  $('#accessBadge').hidden = !ro;
  $('#btnLogin').hidden = !ro;
  // «Выйти» гасит сессию пароля удалённого доступа — она есть только у
  // чужого компьютера. С localhost доступ полный независимо от cookie,
  // и кнопка там ничего не делает.
  $('#btnLogout').hidden = ro || !state.config.hasWebPassword || sessionLocal;
  $('#btnSettings').hidden = ro;

  const bar = $('#readonlyBar');
  bar.hidden = !ro;
  if (ro) {
    bar.innerHTML = state.config.hasWebPassword
      ? '<b>' + t('common.viewonlyMode') + '</b> ' + t('common.theCatalogAndOccupancyAre')
      : '<b>' + t('common.viewonlyMode') + '</b> ' + t('common.managingFromOtherComputersIs');
  }

  renderBanner();

  $('#cntCatalog').textContent = state.catalog.length;
  $('#cntMine').textContent = state.localDevices.length;
  $('#cntGroups').textContent = state.localGroups.length;
  $('#cntAttached').textContent = state.attachments.length;
  $('#cntPeers').textContent = state.peers.filter((p) => p.online).length;
  $('#autoShare').checked = Boolean(state.config.autoShareNew);
  $('#autoShare').disabled = ro;
  $('#btnNewGroup').hidden = ro;

  const filter = $('#typeFilter');
  if (filter.options.length <= 1) {
    for (const t of state.deviceTypes || []) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = `${t.icon} ${t.plural}`;
      filter.append(o);
    }
  }
}

function renderBanner() {
  const banner = $('#banner');
  const issues = state.backend.issues || [];
  const notes = state.backend.notes || [];
  const inst = state.install;
  const running = inst && inst.state === 'running';
  const failed = inst && inst.state === 'error';
  const justDone = inst && inst.state === 'done' && Date.now() - (inst.finishedAt || 0) < 90000;

  // Примечания — не неисправности. Режим имитации выбран флагом запуска,
  // и кричать про «настроено не полностью» о том, что запрошено намеренно,
  // значит приучать не читать предупреждения вовсе.
  renderNotes(notes);

  if ((!issues.length && !running && !failed && !justDone) || bannerDismissed || !canEdit()) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  banner.className = `banner${justDone && !issues.length ? ' ok' : failed ? ' err' : ''}`;

  if (running) {
    const tail = (inst.steps || []).slice(-6);
    banner.innerHTML = `
<b>${t('common.installingUsbIpComponents')}</b>
	      <p class="banner-hint">${t('common.windowsWillAskForAdministrator')}</p>
	      <pre class="banner-log">${tail.map((s) => esc(s.text)).join('\n') || t('common.preparing')}</pre>`;
    return;
  }

  if (justDone && !issues.length) {
    banner.innerHTML = `
<b>${t('common.doneEverythingNeededIsInstalled')}</b>
	      <p class="banner-hint">${t('common.theEnvironmentHasBeenRechecked')}</p>
	      <div class="banner-actions"><button class="btn small" data-dismiss="1">${t('common.hide')}</button></div>`;
    return;
  }

  const parts = ['<b>' + t('common.theUsbIpEnvironmentIs') + '</b>'];
  if (issues.length) parts.push(`<ul>${issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`);
  if (failed && inst.error) parts.push(`<p class="banner-error">${t('app.installFailed', { error: esc(inst.error) })}</p>`);

  if (inst && inst.canInstall) {
    const todo = inst.components.filter((c) => c.needed);
    const size = todo.reduce((s, c) => s + (c.sizeMb || 0), 0);
    parts.push(`
      <div class="banner-actions">
        <button class="btn primary" id="btnInstall">${failed ? t('common.retryInstallation') : t('common.install')}</button>
        <span class="banner-hint">${esc(todo.map((c) => `${c.title.split('—')[0].trim()} ${c.version}`).join(', '))}
${t('app.mbFromFolder', { size: size ? esc(size.toFixed(1)) : '?', folder: 'installers' })}
	          ${t('common.administratorRightsWillBeNeeded')}</span>
      </div>`);
    const note = todo.find((c) => c.signerNote);
    if (note) parts.push(`<p class="banner-hint">${esc(note.signerNote)}</p>`);
  } else if (inst && !inst.supported && (inst.hints || []).length) {
parts.push(`<p class="banner-hint">${t('app.manualInstall')}</p><ul>${
	      inst.hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`);
  }

  banner.innerHTML = parts.join('');
}

/** Нейтральная строка-примечание под шапкой. */
function renderNotes(notes) {
  let box = $('#notesBar');
  if (!box) {
    box = document.createElement('div');
    box.id = 'notesBar';
    box.className = 'banner info';
    $('#banner').after(box);
  }
  if (!notes.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = notes.map((n) => `<div class="note-line">ℹ ${esc(n)}</div>`).join('');
}

/**
 * Полоса «вас видно под чужим адресом»: узел стоит за NAT (например,
 * виртуалка, чьи UDP-анонсы выходят в сеть с адреса хоста, а TCP — нет).
 * Висит, пока обмен каталогом подтверждает отражение; уходит, когда утечку
 * закрыли или появился рабочий проброс портов.
 */
function renderGhosted() {
  let box = $('#ghostBar');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ghostBar';
    box.className = 'banner warn';
    $('#banner').after(box);
  }
  const g = state.self?.ghosted;
  if (!g) { box.hidden = true; return; }
  box.hidden = false;
box.innerHTML = `<b>${t('app.nodeSeenInNeighborNetwork', { addr: esc(g.address || '\u2014') })}</b>
	    <p class="banner-hint">${t('app.ghostedExplanation')}</p>`;
}

// ------------------------------------------------------------------ каталог

function statusPill(entry) {
  // Занятие идёт: показываем, что именно сейчас происходит. Сетевая карта
  // занимается секундами, и «…» на кнопке ничего не говорит о том, ждать ли.
  if (entry.attachState === 'attaching') {
    return `<span class="pill warn">${t('common.beingTaken')}${entry.attachStageCode ? `: ${esc(t('srv.' + entry.attachStageCode, entry.attachStageParams))}` : entry.attachStage ? `: ${esc(entry.attachStage)}` : '…'}</span>`;
  }
  if (entry.preparing && !entry.busy) return '<span class="pill warn">' + t('common.beingPrepared_2') + '</span>';
  if (entry.busyByMe) return `<span class="pill mine">${t('app.takenByYou')} · ${esc(since(entry.claim.since))}</span>`;
  if (entry.busy) return `<span class="pill busy">${t('app.takenByWith', { who: esc(entry.claim.holderName), since: esc(since(entry.claim.since)) })}</span>`;
  if (entry.reservedFor) return `<span class="pill warn">${t('app.heldFor', { name: esc(entry.reservedFor.nodeName) })}</span>`;
  return '<span class="pill free">' + t('common.free') + '</span>';
}

/** Кто сейчас в общем мосту карты и с какой скоростью каждый работает. Карта при этом не «занята»: подключаться могут и остальные. */
function joinPill(entry) {
  const joins = entry.joins || [];
  if (!joins.length) return '';
  const names = joins.map((j) => {
    const total = j.traffic ? (j.traffic.bytesInPerMinute || 0) + (j.traffic.bytesOutPerMinute || 0) : 0;
    return total ? `${j.holderName} · ${formatRate(total)}` : j.holderName;
  }).join(', ');
  const title = t('app.theNicIsJoinedIntoSharedBridge')
    + t('common.eachOnesRateIsThe');
  return `<span class="pill ${entry.joinedByMe ? 'mine' : 'warn'}" title="${esc(title)}">${t('app.inBridge')}${esc(names)}</span>`;
}

/** Можно ли подключить эту карту в общий мост с нашего компьютера. */
function canJoinBridge(d) {
  return d.type === 'net' && !d.ownerSelf && d.ownerOnline && d.hasTransport !== false
    && d.meta?.bridgeJoin === true && !d.busy && !d.joinedByMe && d.attachState !== 'attaching';
}

/** Кнопки карты внутри группы: целиком группу занимают её кнопкой, но в мост карту можно подключить отдельно. */
function memberActions(d) {
  if (!canEdit()) return '';
  if (d.joinedByMe && d.attachmentId) return `<button class="btn small danger" data-detach="${esc(d.attachmentId)}">${t('common.leaveTheBridge')}</button>`;
  return canJoinBridge(d) ? joinButton(d) : '';
}

function joinButton(d) {
  const m = d.meta || {};
  const adv = m.staticAddress
    ? t('app.ownerStaticAddress', { address: m.staticAddress.address, prefix: m.staticAddress.prefixLength, next: m.staticAddress.next ? t('app.weSuggest', { next: m.staticAddress.next }) : '' })
    : '';
  return `<button class="btn small primary" data-join="${esc(d.ownerId)}|${esc(d.target)}"
    title="${esc(t('common.anAdapterOnTheOwners') + adv)}"
    >${t('common.joinToBridge')}</button>`;
}

/**
 * Скорость обмена — «байт в минуту».
 *
 * Показывается объём за последнюю минуту, а не мгновенная скорость: минута
 * сглаживает рывки USB-обмена, и по ней видно, работает устройство или
 * просто числится занятым.
 */
function formatRate(bytesPerMinute) {
  if (!bytesPerMinute) return `0 ${t('common.bMin')}`;
  if (bytesPerMinute < 1024) return `${bytesPerMinute} ${t('common.bMin')}`;
  if (bytesPerMinute < 1024 * 1024) return `${(bytesPerMinute / 1024).toFixed(1)} ${t('common.kbMin')}`;
  return `${(bytesPerMinute / 1048576).toFixed(2)} ${t('common.mbMin')}`;
}

function formatVolume(bytes) {
  if (!bytes) return `0 ${t('unit.b')}`;
  if (bytes < 1024) return `${bytes} ${t('unit.b')}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t('common.kb')}`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} ${t('common.mb')}`;
  return `${(bytes / 1073741824).toFixed(2)} ${t('common.gb')}`;
}

/** Полоска активности: приём и передача за последнюю минуту. */
function trafficPill(t) {
  if (!t) return '';
  const total = (t.bytesInPerMinute || 0) + (t.bytesOutPerMinute || 0);
  const idle = total === 0;
  const title = t('app.trafficTitle', { inRate: formatRate(t.bytesInPerMinute), outRate: formatRate(t.bytesOutPerMinute), totalVol: formatVolume((t.totalIn || 0) + (t.totalOut || 0)) });
  return `<span class="pill traffic ${idle ? 'idle' : 'busy-flow'}" title="${esc(title)}">`
    + `${idle ? '⏸' : '⇅'} ${esc(formatRate(total))}</span>`;
}

/** Что потеряют соседи, если приложение перестанет искать узлы в сети карты. */
function neighborsOnNetwork(cidr) {
  return (state.peers || []).filter((p) => p.online && p.network === cidr);
}

/** Пояснение: карта задействована в обнаружении, и как её освободить для проброса. */
function discoveryInfo(meta, note) {
  // Значок — только когда причина отказа именно эта, а не, например, Wi-Fi.
  if (!meta?.discoveryUse || !/ищет через эту карту узлы|работает само приложение/.test(note || '')) return '';
  const text = meta.discoveryAuto
    ? t('app.discoveryAuto1') + t('app.discoveryAuto2') + t('common.orPickThePrimaryNetwork')
    : t('common.theAppItselfWorksThrough');
  return ` <span class="info-i" tabindex="0" title="${esc(text)}" aria-label="${esc(text)}">ⓘ</span>`;
}

function transportPill(d) {
  // По сети пробрасываются USB и сетевые карты. Для COM, LPT и карт, которые
  // отдать нельзя, приложение ведёт только учёт занятости, и не сказать об
  // этом заметно — значит отправить человека искать в системе устройство,
  // которого не будет. У карты причина своя, и её надо показать: «бронь»
  // рядом с соседней картой, которая пробрасывается, иначе непонятна.
  if (d.hasTransport) return '';
  const meta = d.meta || {};
  const note = meta.transportNote;
  const why = note
    ? t('app.noForwardPrefix', { note })
    : t('app.noForwardPrefix2') + t('common.theAppRecordsWhoHas_2');
  return `<span class="pill warn" title="${esc(why)}">${t('ui.bookingOnly')}</span>${usbAdapterHint(d, meta)}${discoveryInfo(meta, note)}`;
}

/** Совет для COM на USB-переходнике: полноценный проброс уже есть — через USB, а не через бронь. */
function usbAdapterText() {
  return t('app.usbAdapterText');
}

function usbAdapterHint(d, meta) {
  if (d.type !== 'com' || !meta?.viaUsb) return '';
  const text = usbAdapterText();
  return ` <span class="info-i" tabindex="0" title="${esc(text)}" aria-label="${esc(text)}">ⓘ</span>`;
}

/** Кнопки для записи каталога — и для устройства, и для группы. */
function entryActions(entry) {
  if (!canEdit()) return '';
  const acts = [];

  if (entry.joinedByMe && entry.attachmentId) {
    acts.push(`<button class="btn small danger" data-detach="${esc(entry.attachmentId)}">Выйти из моста</button>`);
  }
  if (canJoinBridge(entry)) acts.push(joinButton(entry));

  if (entry.busyByMe && entry.attachmentId) {
    acts.push(`<button class="btn small danger" data-detach="${esc(entry.attachmentId)}">Освободить</button>`);
    // Драйвер у владельца — рядом с «Освободить»: человек только что занял устройство
    // и именно здесь ищет, что с ним делать дальше (причины отказа — на вкладке «Занято мной»).
    const att = (state.attachments || []).find((x) => x.id === entry.attachmentId);
    if (att && att.state === 'attached') acts.push(driverButtons(att, String(entry.target).startsWith('group:') ? null : entry.target));
  } else if (entry.busy) {
    // Владелец забирает своё без спроса: оборудование стоит у него.
    if (entry.ownerSelf) {
      acts.push(`<button class="btn small danger" data-take="${esc(entry.ownerId)}|${esc(entry.target)}">Забрать себе</button>`);
      acts.push(`<button class="btn small" data-force="${esc(entry.target)}">Просто освободить</button>`);
    } else if (entry.ownerOnline) {
      acts.push(`<button class="btn small" data-ask="${esc(entry.ownerId)}|${esc(entry.target)}|${esc(entry.title)}">Попросить</button>`);
    }
  } else if (entry.ownerOnline && entry.available !== false && !entry.joinedByMe) {
    // У COM, LPT и сетевых интерфейсов проброса нет — есть только учёт
    // занятости. Кнопка «Занять» обещала бы то, чего не будет: человек
    // жмёт её и идёт искать новое устройство в системе. Поэтому здесь
    // другое слово и прямое пояснение в подсказке.
    const reserve = entry.hasTransport === false;
    // Тот же совет, что у значка «только бронь»: COM на переходнике пробрасывается через USB.
    const reserveWhy = t('app.reserveWhy')
    + (entry.type === 'com' && entry.meta?.viaUsb ? `. ${usbAdapterText()}` : '');
    acts.push(`<button class="btn small primary" data-attach="${esc(entry.ownerId)}|${esc(entry.target)}"
      data-reserve="${reserve ? '1' : ''}"
      title="${reserve
        ? reserveWhy
        : entry.type === 'net'
          ? t('app.netAppear')
          : entry.type === 'com'
            ? t('app.comAppear')
            : t('app.deviceAppear')}"
      >${reserve ? t('common.book') : t('common.take')}</button>`);
  }
  return acts.join('');
}

function deviceMeta(d) {
  const m = d.meta || {};
  const bits = [];
  if (m.vendorId && m.productId) bits.push(`${t('app.idLabel')}<span class="mono">${esc(m.vendorId)}:${esc(m.productId)}</span>`);
  if (m.serial) bits.push(`${t('app.snLabel')}<span class="mono">${esc(m.serial)}</span>`);
  if (m.viaUsb) bits.push(t('common.viaAUsbAdapter'));
  if (m.status) bits.push(`${t('app.statusLabel')}${esc(m.status)}`);
  if (m.mac) bits.push(`MAC: <span class="mono">${esc(m.mac)}</span>`);
  if (m.linkSpeed) bits.push(`${t('app.speedLabel')}${esc(m.linkSpeed)}`);
  if (m.usedIps?.length) bits.push(usedIpsText(m.usedIps, m.scannedAt));
  if (m.ip) {
    // Настройки карты, с которыми её получит занявший.
    bits.push(ipText(m.ip));
  } else if (Array.isArray(m.addresses) && m.addresses.length) {
    bits.push(`адреса: <span class="mono">${esc(m.addresses.map((a) => a.address).join(', '))}</span>`);
  }
  return bits;
}

/** Занятые адреса в сети карты (владелец сканирует её в фоне). Весь список — в подсказке. */
function usedIpsText(ips, scannedAt) {
  const shown = ips.slice(0, 12);
  const rest = ips.length - shown.length;
  const when = scannedAt ? t('app.scannedAtPrefix') + at(scannedAt) : '';
  return `<span title="${esc(ips.join(', '))}">${t('app.usedIpsPrefix')}<b>${ips.length}</b> — `
    + `<span class="mono">${esc(shown.join(', '))}${rest > 0 ? t('app.andMore', { count: rest }) : ''}</span>${esc(when)}</span>`;
}

/** Настройки IPv4 одной строкой: адрес, шлюз, DNS — или DHCP. */
function ipText(ip) {
  const mono = (list) => `<span class="mono">${esc(list.join(', '))}</span>`;
  const parts = [];
  if (ip.dhcp) {
    const l = ip.lease;
    parts.push(l ? `${t('app.ipv4Dhcp')}${mono([`${l.address}/${l.prefixLength ?? '?'}`])}` : t('app.ipv4DhcpPlain'));
    if (l && l.gateways?.length) parts.push(`${t('common.gateway_2')} ${mono(l.gateways)}`);
  } else if (ip.addresses?.length) {
    parts.push(`IPv4: ${mono(ip.addresses.map((a) => `${a.address}/${a.prefixLength}`))}${t('app.ipv4Manual')}`);
    if (ip.gateways?.length) parts.push(`${t('common.gateway_2')} ${mono(ip.gateways)}`);
  } else {
    parts.push(t('common.ipv4NotConfigured'));
  }
  const dns = ip.dns?.length ? ip.dns : (ip.dhcp ? ip.lease?.dns || [] : []);
  if (dns.length) parts.push(`DNS ${mono(dns)}`);
  return parts.join(' · ');
}

/** Что перенесено на наш адаптер и удалось ли. */
function adapterIpText(ip, applied) {
  if (!ip) return '';
  if (applied && !applied.ok) {
    return `<span class="pill err" title="${esc(applied.error || '')}">${t('app.ipSettingsNotApplied')}${esc(applied.error || t('common.error'))}</span>`;
  }
  if (applied?.remote) return t('app.ipSettingsRemote', { ip: ipText(ip) });
  if (applied?.own) return t('app.ipSettingsOwn', { ip: ipText(ip) });
  return t('app.ipSettingsDefault', { ip: ipText(ip) });
}

/** Значок узла, стоящего в нескольких сетях: он может пересказывать каталог и пропускать соединения. */
function gatewayMark(e) {
  return e.ownerGateway || e.gateway
    ? ' <span class="pill plain" title="' + t('app.gatewayPillTitle') + '">' + t('common.gateway_3') + '</span>'
    : '';
}

/** Адрес владельца; если узел виден из нескольких сетей — все адреса с пометкой сети и способа доступа. */
function ownerAddresses(e) {
  const routes = e.ownerRoutes || [];
  if (routes.length < 2) return `(${esc(e.ownerAddress)})`;
  const how = (r) => (r.via ? `${t('app.viaNamed', { name: esc(r.via.name || '?') })}${r.mode === 'tunnel' ? t('app.viaTunnel') : r.mode === 'direct' ? t('app.viaDirect') : ''}` : t('app.directOnly'));
  return '(' + routes.map((r) => `<span title="${esc(how(r).replace(/<[^>]+>/g, ''))}"><span class="mono">${esc(r.address)}</span> `
    + `<span class="muted">${esc(r.network || '')} · ${how(r)}</span></span>`).join(' · ') + ')';
}

function deviceCard(d, { insideGroup = false } = {}) {
  const cls = !d.ownerOnline ? 'offline' : d.busyByMe ? 'mine' : d.busy ? 'busy' : 'free';
  const meta = deviceMeta(d);
  return `
    <article class="card ${cls} ${insideGroup ? 'in-group' : ''}">
      <div class="card-main">
        <div class="card-title">
          <span class="type-icon" title="${esc(d.typeTitle)}">${esc(d.icon)}</span>
          ${esc(d.title)}
          ${insideGroup ? '' : statusPill(d)}
          ${joinPill(d)}
          ${d.busy ? trafficPill(d.traffic) : ''}
          ${transportPill(d)}
          ${d.ownerSelf ? '<span class="pill plain">моё</span>' : ''}
          ${d.ownerOnline ? '' : '<span class="pill err">владелец офлайн</span>'}
        </div>
        ${d.purpose ? `<div class="purpose">${esc(d.purpose)}</div>` : ''}
        <div class="card-meta">
          ${insideGroup ? '' : `<span>${t('app.ownerColon')}<b>${esc(d.ownerName)}</b>${gatewayMark(d)}${natMark(d)} ${ownerAddresses(d)}${remoteMark(d.ownerId)}</span>`}
          <span>${esc(d.typeTitle)}: <span class="mono">${esc(d.subtitle)}</span></span>
          ${meta.map((b) => `<span>${b}</span>`).join('')}
          ${d.connectedSince ? `<span>${t('app.connectedColon')}${esc(since(d.connectedSince))} (${esc(at(d.connectedSince))})</span>` : ''}
          ${d.vhciPort !== null && d.vhciPort !== undefined ? `<span>${t('app.vhciPortColon')}<b>${esc(d.vhciPort)}</b></span>` : ''}
          ${d.adapter ? `<span>${t('app.adapterYoursColon')}<b>${esc(d.adapter)}</b></span>` : ''}
          ${d.adapter && d.adapterIp ? `<span>${adapterIpText(d.adapterIp, d.adapterIpApplied)}</span>` : ''}
          ${d.adapter && !d.adapterIp && d.adapterNote ? `<span class="pill warn">${esc(d.adapterNote)}</span>` : ''}
          ${d.lastError ? `<span class="pill err">${esc(d.lastError)}</span>` : ''}
        </div>
      </div>
      <div class="card-actions">${insideGroup ? memberActions(d) : entryActions(d)}</div>
    </article>`;
}

function groupCard(g) {
  const cls = !g.ownerOnline ? 'offline' : g.busyByMe ? 'mine' : g.busy ? 'busy' : 'free';
  // Действия стоят справа — там же, где у обычных карточек. Колонка кнопок
  // берёт ровно свою ширину, поэтому рамка группы не становится шире.
  return `
    <section class="group ${cls}">
      <header class="group-head">
        <div class="group-info">
          <div class="group-title">
            <span class="type-icon">🧩</span>
            <b>${esc(g.title)}</b>
            <span class="pill group-pill">группа · ${g.members.length} устр.</span>
            ${statusPill(g)}
            ${g.busy ? trafficPill(g.traffic) : ''}
            ${g.ownerSelf ? '<span class="pill plain">моя</span>' : ''}
            ${g.partial ? '<span class="pill err">занята частично</span>' : ''}
            ${g.available === false ? '<span class="pill err">не все устройства на месте</span>' : ''}
          </div>
          ${g.purpose ? `<div class="purpose">${esc(g.purpose)}</div>` : ''}
          <div class="card-meta">
            <span>${t('app.ownerColon')}<b>${esc(g.ownerName)}</b>${gatewayMark(g)}${natMark(g)} ${ownerAddresses(g)}${remoteMark(g.ownerId)}</span>
            <span>занимается целиком</span>
          </div>
        </div>
        <div class="card-actions">${entryActions(g)}</div>
      </header>
      <div class="group-body">
        ${g.members.map((m) => deviceCard(m, { insideGroup: true })).join('')}
      </div>
    </section>`;
}

/**
 * Строка, по которой ищем. Узлов и устройств в сети бывает много, и
 * пролистывать их глазами — не работа; искать надо сразу по всему, что
 * человек помнит: по названию, по описанию, по владельцу, по номеру порта.
 */
function haystack(e) {
  const parts = [e.title, e.subtitle, e.purpose, e.ownerName, e.typeTitle, e.target];
  if (e.kind === 'group') {
    for (const m of e.members || []) {
      parts.push(m.title, m.subtitle, m.purpose, m.typeTitle);
    }
  } else {
    const m = e.meta || {};
    parts.push(m.vendorId && m.productId ? `${m.vendorId}:${m.productId}` : '', m.serial, m.mac, m.instanceId);
    for (const a of m.addresses || []) parts.push(a.address);
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function renderCatalog() {
  const onlyFree = $('#onlyFree').checked;
  const type = $('#typeFilter').value;
  // Слова ищутся все сразу и в любом порядке: так проще найти «стенд jtag»,
  // не помня точной формулировки описания.
  const words = $('#search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const items = state.catalog.filter((e) => {
    if (onlyFree && e.busy) return false;
    if (type && !(e.kind === 'group' ? e.members.some((m) => m.type === type) : e.type === type)) return false;
    if (!words.length) return true;
    const hay = haystack(e);
    return words.every((w) => hay.includes(w));
  });

  renderOutgoing();

  const box = $('#catalogList');
  if (!items.length) {
    box.innerHTML = `<div class="empty">${state.catalog.length
      ? (words.length ? t('app.notFoundForQuery', { query: esc($('#search').value.trim()) }) : t('common.nothingMatchesTheFilter'))
      : t('common.noPublishedDevicesOnThe')}</div>`;
    return;
  }
  box.innerHTML = items.map((e) => (e.kind === 'group' ? groupCard(e) : deviceCard(e))).join('');
}

/** Собственные запросы: что с ними стало. */
function renderOutgoing() {
  const box = $('#outgoingBox');
  const list = (state.requests?.outgoing || []).filter((r) => r.state !== 'cancelled');
  if (!list.length) { box.innerHTML = ''; return; }

  const label = {
    pending: ['warn', t('common.waitingForAnAnswer')],
    accepted: ['ok', t('common.handedToYouTakeIt')],
    granted: ['ok', t('common.released_2')],
    declined: ['err', t('common.declined')],
    expired: ['err', t('common.expiredUnanswered')],
    superseded: ['plain', t('common.theOwnerTookItBack')],
  };

  box.innerHTML = `<div class="outgoing">${list.map((r) => {
    const [kind, text] = label[r.state] || ['plain', r.state];
    return `<div class="outgoing-row">
      <span class="pill ${kind}">${esc(text)}</span>
<span>${t('app.yourRequest')} <b>${esc(r.title)}</b> ${t('app.atHolder', { holder: esc(r.holderName) })}</span>
	      ${r.state === 'pending' && canEdit()
	        ? `<button class="btn small" data-cancel-request="${esc(r.id)}">${t('app.cancel')}</button>` : ''}
    </div>`;
  }).join('')}</div>`;
}

// ------------------------------------------------------------ мои устройства

/**
 * «Не использовать для обнаружения»: приложение не ищет узлы в сети этой карты,
 * и карту можно пробросить. Показывается у настоящих карт при автоматическом
 * выборе сетей — там карта по умолчанию задействована в поиске.
 */
function discoveryToggle(d, ro) {
  const m = d.meta || {};
  if (d.type !== 'net' || ro || !m.hardware || !m.discoveryAuto) return '';
  if (!m.discoveryUse && !m.discoveryExcluded) return '';
return `<label class="member disc-toggle" title="${t('common.theAppWillStopSearching')}">
	    <input type="checkbox" data-disc-exclude="${esc(d.title)}" ${m.discoveryExcluded ? 'checked' : ''}>
	    <span>${t('app.doNotUseForDiscovery')}</span></label>`;
}

function renderMine() {
  const items = state.localDevices;
  const box = $('#mineList');
  if (!items.length) {
    box.innerHTML = '<div class="empty">' + t('common.noDevicesFoundCheckWhich') + '</div>';
    return;
  }

  const ro = !canEdit();
  box.innerHTML = items.map((d) => {
    const blocked = Boolean(d.unavailableReason);
    // Ограничения накладывает только ОПУБЛИКОВАННАЯ группа. Пока она
    // не опубликована, устройство публикуется и занимается само по себе.
    const inGroup = Boolean(d.groupPublished);
    const cls = blocked ? 'offline' : d.claim ? 'busy' : d.shared ? 'free' : '';
const status = d.preparing && !d.claim
	      ? '<span class="pill warn">' + t('common.beingPrepared_2') + '</span>'
	      : d.claim
	      ? `<span class="pill busy">${t('app.takenBy', { who: esc(d.claim.holderName), time: esc(since(d.claim.since)) })}</span>${silentHolderPill(d.claim)}`
	      : d.shared ? '<span class="pill free">' + t('common.publishedFree') + '</span>'
	        : '<span class="pill plain">' + t('common.notPublished') + '</span>';

    const acts = [];
    if (!blocked && !ro) {
      if (!inGroup) {
acts.push(`<button class="btn small ${d.shared ? '' : 'primary'}" data-share="${esc(d.deviceId)}|${d.shared ? '0' : '1'}">${
	          d.shared ? t('common.unpublish') : t('common.publish')}</button>`);
	      }
	      if (d.claim) acts.push(`<button class="btn small danger" data-force="${esc(d.deviceId)}">${t('common.release_2')}</button>`);
    }

    return `
      <article class="card ${cls}">
        <div class="card-main">
          <div class="card-title">
            <span class="type-icon" title="${esc(d.typeTitle)}">${esc(d.icon)}</span>
            ${esc(d.description)}
            ${blocked ? '' : status}
            ${d.claim ? trafficPill(d.traffic) : ''}
            ${transportPill(d)}
            ${d.groupId ? `<span class="pill group-pill">${inGroup ? t('common.sharedViaGroup') : t('common.inAGroupUnpublished')} «${esc(d.groupName || '')}»</span>` : ''}
          </div>
          <div class="card-meta">
            <span>${esc(d.typeTitle)}: <span class="mono">${esc(d.title)}</span></span>
            ${deviceMeta(d).map((b) => `<span>${b}</span>`).join('')}
            <span>${t('app.driverState')}: <b>${esc(d.bindState)}</b></span>
            ${d.lastError ? `<span class="pill err">${esc(d.lastError)}</span>` : ''}
            ${blocked ? `<span class="pill err">${esc(d.unavailableReason)}</span>` : ''}
          </div>
          ${discoveryToggle(d, ro)}
          ${blocked || ro ? (d.purpose ? `<div class="purpose">${esc(d.purpose)}</div>` : '')
            : `<input class="purpose-input" data-purpose="${esc(d.deviceId)}" value="${esc(d.purpose || '')}"
                 maxlength="500" placeholder="${t('app.purposePlaceholder')}">`}
        </div>
        <div class="card-actions">${acts.join('')}</div>
      </article>`;
  }).join('');
}

// ------------------------------------------------------------------- группы

function renderGroups() {
  const box = $('#groupsList');
  const groups = state.localGroups || [];
  if (!groups.length) {
    box.innerHTML = '<div class="empty">' + t('common.noGroupsYetGroupThe') + '</div>';
    return;
  }
  const byId = new Map(state.localDevices.map((d) => [d.deviceId, d]));
  box.innerHTML = groups.map((g) => {
    const status = g.claim
      ? `<span class="pill busy">занята: ${esc(g.claim.holderName)}</span>`
      : g.shared ? '<span class="pill free">опубликована, свободна</span>'
        : '<span class="pill plain">не опубликована</span>';

    const acts = canEdit() ? [
      `<button class="btn small ${g.shared ? '' : 'primary'}" data-group-share="${esc(g.id)}|${g.shared ? '0' : '1'}">${
        g.shared ? t('common.unpublish') : t('common.publish')}</button>`,
      `<button class="btn small" data-edit-group="${esc(g.id)}">Изменить</button>`,
    ].join('') : '';

    return `
    <article class="card ${g.claim ? 'busy' : g.shared ? 'free' : ''} group-manage">
      <div class="card-main">
        <div class="card-title">
          <span class="type-icon">🧩</span>${esc(g.name)} ${status}
        </div>
        ${g.description ? `<div class="purpose">${esc(g.description)}</div>` : ''}
        <div class="card-meta">
          ${g.members.map((m) => {
            const d = byId.get(m);
            return `<span>${d ? `${esc(d.icon)} ${esc(d.description)} (<span class="mono">${esc(d.title)}</span>)`
              : `<span class="pill err">нет устройства ${esc(m)}</span>`}</span>`;
          }).join('')}
        </div>
        <p class="hint group-rule">${g.shared
          ? t('common.theGroupIsPublishedIts')
          : t('common.theGroupIsNotPublished')}</p>
      </div>
      <div class="card-actions">${acts}</div>
    </article>`;
  }).join('');
}

// --------------------------------------------------------------- занято мной

function renderAttached() {
  const items = state.attachments;
  const box = $('#attachedList');
  if (!items.length) {
    box.innerHTML = `<div class="empty">${t('common.thisComputerHasNothingTaken')}</div>`;
    return;
  }

  const label = { attaching: t('common.taking'), attached: t('common.taken'), detaching: t('common.releasing'), error: t('common.error') };
  box.innerHTML = items.map((a) => `
    <article class="card ${a.state === 'error' ? 'error' : a.state === 'attached' ? 'mine' : ''}">
      <div class="card-main">
        <div class="card-title">
          ${a.kind === 'group' ? '<span class="type-icon">🧩</span>' : ''}
          ${esc(a.title)}
          <span class="pill ${a.state === 'error' ? 'err' : 'mine'}">${esc(label[a.state] || a.state)}</span>
          ${a.state === 'attaching' && a.stage ? `<span class="pill warn">${esc(a.stage)}</span>` : ''}
          ${a.self ? '<span class="pill plain">своё устройство</span>' : ''}
          ${a.mode === 'bridge' ? `<span class="pill warn" title="${t('app.nicConnectedToSharedBridgeTitle')}">${t('common.inTheSharedBridge')}</span>` : ''}
          ${a.orphan ? '<span class="pill plain">вне приложения</span>' : ''}
        </div>
        <div class="card-meta">
          <span>источник: <b>${esc(a.nodeName)}</b> (${esc(a.host)})</span>
          <span>занято: ${esc(since(a.attachedAt || a.since))}</span>
          ${a.lastHeartbeat ? `<span>${t('app.connectionWithOwnerAgo', { time: esc(since(a.lastHeartbeat)) })}</span>` : ''}
          ${a.lastError ? `<span class="pill err">${esc(a.lastError)}</span>` : ''}
        </div>
        <div class="card-meta">
          ${a.parts.map((p) => `<span>${esc(p.description || p.deviceId)}${partState(p)} ${p.comNote ? `<span class="pill warn" title="${t('common.theOwnersPortNameIs')}">${esc(p.comNote)}</span>` : ''} ${p.traffic ? trafficPill(p.traffic) : ''}</span>`).join('')}
        </div>
        ${a.parts.filter((p) => p.adapter && (p.ip || p.ipNote)).map((p) => `<div class="card-meta"><span>${
          p.ip ? adapterIpText(p.ip, p.ipApplied) : `<span class="pill warn">${esc(p.ipNote)}</span>`}</span>${
          !p.ip && p.suggest ? `<button class="btn small primary" data-held-ip="${esc(a.id)}|${esc(p.deviceId)}"
            title="${t('common.theSettingsWindowWillOpen')}">${t('app.setAddress', { address: esc(p.suggest.address) })}</button>` : ''}</div>
          ${p.usedIps?.length ? `<div class="card-meta"><span>${usedIpsText(p.usedIps)}</span></div>` : ''}`).join('')}
        ${a.parts.some((p) => p.hasTransport) && !a.parts.some((p) => p.traffic)
          ? '<p class="hint">Скорость не показывается: у владельца выключен учёт трафика.</p>' : ''}
        ${driverNotes(a)}
      </div>
      <div class="card-actions">
        ${canEdit() && a.state === 'attached' ? a.parts.filter((p) => p.type === 'net').map((p) => `<button class="btn small"
          data-held-ip="${esc(a.id)}|${esc(p.deviceId)}" title="${p.adapter
            ? t('common.changeTheSettingsOfYour')
            : t('common.theNicIsBookedAsk')}"
          >Настройки IP${a.parts.filter((x) => x.type === 'net').length > 1 ? ` · ${esc(p.title || p.key)}` : ''}</button>`).join('') : ''}
        ${canEdit() && a.state === 'attached' ? driverButtons(a) : ''}
        ${canEdit() ? `<button class="btn small danger" data-detach="${esc(a.id)}">Освободить</button>` : ''}
      </div>
    </article>`).join('');
}

/**
 * «Копировать драйвер». Если сделать это заведомо нельзя, кнопку не
 * показываем, а пишем, почему: молча пропавшая кнопка выглядела бы
 * как недоработка, а причина обычно в самой ситуации (другая система,
 * нет прав администратора, своё устройство).
 */
function driverButtons(a, onlyDeviceId = null) {
  const parts = a.parts.filter((p) => p.hasTransport && p.type === 'usb' && (!onlyDeviceId || p.deviceId === onlyDeviceId));
  return parts.filter((p) => !p.driverBlock).map((p) => `<button class="btn small"
    data-driver="${esc(a.id)}|${esc(p.deviceId)}"
    title="${t('common.fetchThisDevicesDriverFrom')}"
    >Копировать драйвер${parts.length > 1 ? ` · ${esc(p.description || p.key)}` : ''}</button>`).join('');
}

/** Объяснения, почему драйвер скопировать нельзя, — в карточке занятия. */
function driverNotes(a) {
  if (a.state !== 'attached') return '';
  const parts = a.parts.filter((p) => p.hasTransport && p.type === 'usb' && p.driverBlock);
  // Одна и та же причина у всех устройств занятия называется один раз.
  const reasons = [...new Set(parts.map((p) => {
    if (p.driverBlockCode) return t('srv.' + p.driverBlockCode, p.driverBlockParams);
    return p.driverBlock;
  }))];
  return reasons.map((r) => `<p class="hint"><b>Копировать драйвер нельзя.</b> ${esc(r)}</p>`).join('');
}

/** Во что превратилось устройство занятия на этом компьютере. */
function partState(p) {
  if (!p.hasTransport) return t('common.booking');
  if (p.comPort) return t('app.arrowPort', { name: esc(p.comPort) });
  if (p.adapter) return t('app.arrowAdapter', { name: esc(p.adapter) });
  if (p.vhciPort !== null && p.vhciPort !== undefined) return t('app.arrowVhciPort', { name: esc(p.vhciPort) });
  return t('common.connecting');
}

/** Метка у владельца из другой сети — прямо в карточке устройства. */
function remoteMark(ownerId) {
  const p = (state.peers || []).find((x) => x.nodeId === ownerId);
  if (!p || p.origin === 'local') return '';
  return ` <span class="pill remote" title="${esc(remoteHint(p))}">другая сеть</span>`;
}

/**
 * Подсказка к метке «другая сеть».
 *
 * Важна не сама метка, а то, что за ней стоит: такой узел доступен только
 * если между сетями есть маршрут и открыты порты. Когда устройство видно,
 * а занять его не выходит, смотреть надо именно сюда.
 */
function remoteHint(p) {
  const via = p.viaName ? t('app.learnedFrom', { name: p.viaName }) : t('common.learnedViaCatalog');
  return t('app.exchangeGoesDirectly', { via });
}

function renderPeers() {
  const box = $('#peersList');
  const self = state.self;
  const selfCard = `
    <article class="card mine">
      <div class="card-main">
        <div class="card-title">${esc(self.name)} <span class="pill mine">этот компьютер</span>${gatewayMark({ gateway: self.gateway })}</div>
        <div class="card-meta">
          <span>адрес: <b>${esc(self.address)}</b></span>
          <span>платформа: ${esc(self.platform)}</span>
          <span>версия: ${esc(self.version)}</span>
          <span>работает: ${esc(since(self.startedAt))}</span>
          <span>бэкенд: <b>${esc(state.backend.name)}</b></span>
        </div>
      </div>
      <div class="card-actions"></div>
    </article>`;

  const peers = state.peers.map((p) => {
    const url = nodeUrl(p);
    return `
    <article class="card ${p.online ? 'free' : 'offline'}${url ? ' node-link' : ''}"${url ? ` data-node-url="${esc(url)}" title="${t('common.openTheNodesInterfaceIn')}"` : ''}>
      <div class="card-main">
        <div class="card-title">${url ? `<a class="node-name" href="${esc(url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}
          <span class="pill ${p.online ? 'free' : 'err'}">${p.online ? t('common.online') : t('common.notResponding')}</span>${gatewayMark(p)}
          ${p.origin && p.origin !== 'local' ? `<span class="pill remote" title="${esc(remoteHint(p))}">другая сеть</span>` : ''}
          ${p.redirected ? natMark({ ownerRedirected: true }) : ''}
          ${p.realmLabel ? `<span class="pill plain" title="${t('app.trustCircle', { realm: esc(p.realm || '') })}">${esc(p.realmLabel)}</span>` : ''}</div>
        <div class="card-meta">
          <span>адрес: <b>${esc(p.address)}</b>:${esc(p.apiPort)}</span>
          ${p.origin !== 'local' && p.network ? `<span>${t('app.networkLabel', { name: esc(p.network) })}</span>` : ''}
          ${p.redirected ? `<span>${t('app.announcedFromHeardOn', { network: esc(p.redirected.network), heardOn: esc(p.redirected.heardOn) })}</span>` : ''}
          <span>платформа: ${esc(p.platform || '—')}</span>
          <span>версия: ${esc(p.version || '—')}</span>
          <span>устройств: <b>${esc(p.deviceCount)}</b> (занято ${esc(p.busyCount)})</span>
          <span>последний ответ: ${esc(since(p.lastSeen))} назад</span>
          ${p.stateError ? `<span class="pill err">${esc(p.stateError)}</span>` : ''}
        </div>
      </div>
      <div class="card-actions"></div>
    </article>`;
  }).join('');

  box.innerHTML = selfCard
    + (peers ? `<p class="hint">${t('common.clickANodeToOpen')}</p>` + peers
      : `<div class="empty">${t('common.noOtherNodesFoundOn')}</div>`);
}

/**
 * Адрес интерфейса другого узла. Только для отвечающих узлов, и только из
 * проверенных частей: адрес и порт пришли по сети, подставлять их в ссылку
 * как есть нельзя.
 */
function nodeUrl(p) {
  if (!p || !p.online) return '';
  const host = String(p.address || '');
  const port = Number(p.apiPort);
  if (!/^[0-9a-fA-F:.]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return '';
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
}

function renderLog() {
  const view = $('#logView');
  view.innerHTML = logBuffer.map((r) => {
    const time = new Date(r.ts).toLocaleTimeString('ru-RU');
    return `<span class="lv-${esc(r.level)}">${esc(time)}  ${esc(r.level.padEnd(5))} [${esc(r.scope)}] ${esc(r.msg)}</span>`;
  }).join('\n');
  if ($('#logAutoscroll').checked) view.scrollTop = view.scrollHeight;
}

// ------------------------------------------------------------------ события

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  ensureNotificationPermission();

  const nodeCard = t.closest('[data-node-url]');
  if (nodeCard && !t.closest('a, button, input, select, textarea, label')
    && !String(window.getSelection?.() || '')) {
    window.open(nodeCard.dataset.nodeUrl, '_blank', 'noopener');
    return;
  }

  const tab = t.closest('.tab');
  if (tab) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === tab));
    const name = tab.dataset.tab;
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'log') renderLog();
    if (name === 'net') net?.onShow();
    return;
  }

  if (t.id === 'btnInstall') { action(t, () => post('/api/v1/install', {})); return; }
  if (t.dataset.dismiss) { bannerDismissed = true; $('#banner').hidden = true; return; }

  if (t.dataset.attach) {
    const [nodeId, target] = t.dataset.attach.split('|');
    const reserve = t.dataset.reserve === '1';
    chooseRoute(nodeId, target, (routeKey) => action(t, () => post('/api/v1/attach', { nodeId, target, routeKey }),
      reserve
        ? t('common.bookedTheDeviceWillNot')
        : t('common.taken')));
  } else if (t.dataset.join) {
    const [nodeId, target] = splitLast(t.dataset.join);
    chooseRoute(nodeId, target, (routeKey) => action(t, async () => {
      const r = await post('/api/v1/attach', { nodeId, target, mode: 'bridge', routeKey });
      offerBridgeIp(r);
    }, t('common.joinedToTheBridgeAn')));
  } else if (t.dataset.take) {
    const [nodeId, target] = t.dataset.take.split('|');
    if (confirm(t('common.takeTheDeviceBackWhoever'))) {
      action(t, () => post('/api/v1/attach', { nodeId, target, force: true }), t('common.theDeviceIsYours'));
    }
  } else if (t.dataset.detach) {
    action(t, () => post('/api/v1/detach', { id: t.dataset.detach }), t('common.released'));
  } else if (t.dataset.force) {
    if (confirm(t('common.forcereleaseWhoeverWorksWithIt'))) {
      action(t, () => post('/api/v1/force-release', { target: t.dataset.force }), t('common.released'));
    }
  } else if (t.dataset.share) {
    const [deviceId, flag] = t.dataset.share.split('|');
    action(t, () => post('/api/v1/share', { deviceId, shared: flag === '1' }));
  } else if (t.dataset.ask) {
    const [nodeId, target, title] = t.dataset.ask.split('|');
    askContext = { nodeId, target };
    $('#askTarget').textContent = t('app.targetLabel', { title });
    $('#askMessage').value = '';
    $('#askDialog').showModal();
  } else if (t.dataset.cancelRequest) {
    action(t, () => post('/api/v1/request/cancel', { requestId: t.dataset.cancelRequest }));
  } else if (t.dataset.groupShare) {
    const [groupId, flag] = t.dataset.groupShare.split('|');
    action(t, () => post('/api/v1/group/share', { groupId, shared: flag === '1' }),
      flag === '1' ? t('common.groupPublished') : t('common.groupUnpublished'));
  } else if (t.dataset.editGroup) {
    openGroupDialog(state.localGroups.find((g) => g.id === t.dataset.editGroup));
  } else if (t.dataset.update) {
    const act = t.dataset.update;
    if (act === 'rollback' && !confirm(t('common.rollBackToThePrevious'))) return;
    if ((act === 'restart' || act === 'now') && !confirm(t('common.restartTheAppNowConnections'))) return;
    action(t, () => post(`/api/v1/update/${act}`, act === 'approve' ? { version: t.dataset.version } : {}),
      act === 'restart' || act === 'now' ? t('common.updating') : act === 'rollback' ? t('common.rollingBack') : null);
  } else if (t.dataset.driver) {
    const [id, deviceId] = splitLast(t.dataset.driver);
    openDriverDialog(id, deviceId);
  } else if (t.dataset.heldIp) {
    const [attachmentId, deviceId] = splitLast(t.dataset.heldIp);
    net?.openHeldIp(attachmentId, deviceId);
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.discExclude !== undefined) {
    const iface = t.dataset.discExclude;
    const now = new Set(state.discoveryExclude || []);
    if (t.checked) {
      const net = (state.self?.networks || []).find((n) => n.iface === iface);
      const lost = net ? neighborsOnNetwork(net.cidr) : [];
      const names = lost.slice(0, 8).map((p) => p.name).join(', ');
      const msg = net
        ? (lost.length
            ? t('app.stopSearchingNetworkWithNeighbors', { cidr: net.cidr, iface, count: lost.length, names, ellipsis: lost.length > 8 ? '…' : '' })
            : t('app.stopSearchingNetworkSimple', { cidr: net.cidr, iface }))
        : t('app.stopSearchingIfaceConfirm', { iface });
      if (!confirm(msg)) { t.checked = false; return; }
      now.add(iface);
    } else {
      now.delete(iface);
    }
    post('/api/v1/settings', { discoveryExclude: [...now] })
      .then(() => toast(t.checked ? t('common.theNicIsExcludedFrom') : t('common.theNicTakesPartIn'), 'ok'))
      .catch((e) => { t.checked = !t.checked; toast(srv(e), 'err'); });
    return;
  }
  if (t.dataset.purpose) {
    post('/api/v1/purpose', { deviceId: t.dataset.purpose, purpose: t.value })
      .then(() => toast(t('common.descriptionSaved'), 'ok'))
      .catch((e) => toast(srv(e), 'err'));
  } else if (t.id === 'autoShare') {
    post('/api/v1/settings', { autoShareNew: t.checked }).catch((e) => toast(srv(e), 'err'));
  } else if (t.id === 'setAutostart') {
    // Действие над системой, а не правка настройки: применяем сразу и
    // возвращаем галочку на место, если не получилось.
    const wanted = t.checked;
    t.disabled = true;
    post('/api/v1/autostart', { enabled: wanted })
      .then((st) => {
        t.checked = Boolean(st.enabled);
        toast(st.enabled ? t('common.autostartEnabled') : t('common.autostartDisabled'), 'ok');
      })
      .catch((e) => { t.checked = !wanted; toast(srv(e), 'err'); })
      .finally(() => { t.disabled = false; });
  } else if (t.id === 'onlyFree' || t.id === 'typeFilter') {
    renderCatalog();
  }
});

// Поиск отрабатывает по каждому нажатию: список уже в браузере,
// перерисовка дешевле, чем ожидание.
$('#search').addEventListener('input', () => renderCatalog());
$('#search').addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { $('#search').value = ''; renderCatalog(); }
});

$('#btnRefresh').addEventListener('click', (ev) => action(ev.target, () => post('/api/v1/refresh', {})));
$('#btnNewGroup').addEventListener('click', () => openGroupDialog(null));
$('#btnLogin').addEventListener('click', () => {
  $('#loginPassword').value = '';
  $('#loginError').textContent = '';
  $('#loginDialog').showModal();
});
$('#btnLogout').addEventListener('click', (ev) => {
  action(ev.target, async () => { await post('/api/v1/logout', {}); location.reload(); });
});

// --- диалог запроса (мы держатель) ---
$('#requestDialog').addEventListener('close', async () => {
  const dlg = $('#requestDialog');
  const req = currentRequest;
  currentRequest = null;
  flashTitle(false);
  if (!req || dlg.returnValue === '') return;

  const accept = dlg.returnValue === 'accept';
  try {
    await post('/api/v1/request/answer', { requestId: req.id, accept });
    toast(accept ? t('common.deviceHandedOver') : t('common.requestDeclined'), accept ? 'ok' : '');
  } catch (e) {
    toast(srv(e), 'err');
  }
});

// --- диалог «попросить» (мы проситель) ---
$('#btnNetDiag').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    const d = await post('/api/v1/net/diag', {});
    $('#diagText').textContent = JSON.stringify(d, null, 2);
    $('#diagDialog').showModal();
  } catch (e) {
    toast(srv(e), 'err');
  } finally {
    btn.disabled = false;
  }
});
$('#diagClose').addEventListener('click', () => $('#diagDialog').close());
$('#diagCopy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('#diagText').textContent).then(() => toast(t('common.copied'), 'ok'), () => toast(t('common.copyFailedSelectTheText'), 'err'));
});

$('#routeDialog').addEventListener('close', () => {
  const go = routeContext;
  routeContext = null;
  if ($('#routeDialog').returnValue !== 'go' || !go) return;
  go(document.querySelector('#routeList input[name="route"]:checked')?.value || null);
});

// --- диалог адреса после подключения в общий мост ---
let bridgeIpContext = null;

/** Часть занятия, которой стоит предложить адрес: мост, адаптер есть, адреса ещё нет. */
function bridgeIpPartOf(r) {
  return (r?.parts || []).find((p) => p.adapter && !p.ip && p.suggest) || null;
}

/**
 * Сразу после подключения в мост предложить адрес из совета владельца:
 * окно подтверждения с правкой адреса, применение — только по «Да».
 * Молчит, когда предлагать нечего: в сети владельца DHCP или адаптер уже
 * настроен (адрес остаётся от прошлого подключения).
 */
function offerBridgeIp(r) {
  const part = bridgeIpPartOf(r);
  if (!part) return;
  const s = part.suggest;
  bridgeIpContext = { attachmentId: r.id, deviceId: part.deviceId, suggest: s };
  $('#bridgeIpNote').textContent = t('app.bridgeIpNote', { adapter: part.adapter });
  $('#bridgeIpInput').value = s.address || '';
  const extra = [
    s.prefixLength != null ? t('app.maskPrefix', { length: s.prefixLength }) : null,
    (s.gateways || []).length ? `${t('app.gatewaysList', { list: s.gateways.join(', ') })}` : null,
    (s.dns || []).length ? `DNS ${s.dns.join(', ')}` : null,
  ].filter(Boolean).join(', ');
  $('#bridgeIpExtra').textContent = extra ? t('app.restWillComeFromOwnerNetwork', { extra }) : '';
  $('#bridgeIpDialog').showModal();
}

$('#bridgeIpDialog').addEventListener('close', async () => {
  const dlg = $('#bridgeIpDialog');
  const ctx = bridgeIpContext;
  bridgeIpContext = null;
  if (!ctx || dlg.returnValue !== 'apply') return;
  const address = $('#bridgeIpInput').value.trim();
  // Лёгкая проверка на месте: полный разбор всё равно делает сервер.
  if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(address)) {
    const addrText = address || t('common.empty');
    toast(t('app.notAnIPv4Address', { address: addrText }), 'err');
    return;
  }
  const s = ctx.suggest;
  try {
    const res = await post('/api/v1/net/held/ip', {
      attachmentId: ctx.attachmentId,
      deviceId: ctx.deviceId,
      category: 'Private',
      ip: {
        dhcp: false,
        addresses: [{ address, prefixLength: s.prefixLength }],
        gateways: s.gateways || [],
        dns: s.dns || [],
      },
    });
    toast(t('app.addressSetToAdapter', { address }), 'ok');
    routeWarning(res);
  } catch (e) {
    toast(srv(e), 'err');
  }
});

$('#askDialog').addEventListener('close', async () => {
  if ($('#askDialog').returnValue !== 'send' || !askContext) return;
  const { nodeId, target } = askContext;
  askContext = null;
  try {
    await post('/api/v1/request', { nodeId, target, message: $('#askMessage').value });
    toast(t('common.requestSentToTheHolder'), 'ok');
  } catch (e) {
    toast(srv(e), 'err');
  }
});

// --- диалог группы ---
function openGroupDialog(group) {
  $('#groupDialogTitle').textContent = group ? t('common.editGroup') : t('common.newGroup');
  $('#groupName').value = group ? group.name : '';
  $('#groupDescription').value = group ? group.description : '';
  $('#btnDeleteGroup').hidden = !group;
  $('#groupDialog').dataset.groupId = group ? group.id : '';

  const inOther = new Set();
  for (const g of state.localGroups) {
    if (group && g.id === group.id) continue;
    for (const m of g.members) inOther.add(m);
  }

  $('#groupMembers').innerHTML = state.localDevices
    .filter((d) => !d.unavailableReason && !inOther.has(d.deviceId))
    .map((d) => `
      <label class="member">
        <input type="checkbox" value="${esc(d.deviceId)}" ${group && group.members.includes(d.deviceId) ? 'checked' : ''}>
        <span>${esc(d.icon)} ${esc(d.description)} <span class="mono">${esc(d.title)}</span></span>
      </label>`).join('') || '<div class="empty">' + t('common.noFreeDevicesAllAlready') + '</div>';

  $('#groupDialog').showModal();
}

$('#groupDialog').addEventListener('close', async () => {
  const dlg = $('#groupDialog');
  const id = dlg.dataset.groupId || undefined;
  try {
    if (dlg.returnValue === 'delete') {
      if (!id) return;
      await post('/api/v1/group/delete', { groupId: id });
      toast(t('common.groupDeleted'), 'ok');
    } else if (dlg.returnValue === 'save') {
      const members = [...dlg.querySelectorAll('#groupMembers input:checked')].map((i) => i.value);
      await post('/api/v1/group/save', {
        id,
        name: $('#groupName').value,
        description: $('#groupDescription').value,
        members,
      });
      toast(t('common.groupSaved'), 'ok');
    }
  } catch (e) {
    toast(srv(e), 'err');
  }
});

// --- вход ---
$('#loginDialog form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#loginDialog').close('login');
});
$('#loginDialog').addEventListener('close', async () => {
  if ($('#loginDialog').returnValue !== 'login') return;
  try {
    await post('/api/v1/login', { password: $('#loginPassword').value });
    toast(t('common.fullAccessGranted'), 'ok');
    location.reload();
  } catch (e) {
    $('#loginError').textContent = e.message;
    $('#loginDialog').showModal();
  }
});

// --- настройки ---
$('#btnSettings').addEventListener('click', () => {
  const c = state.config;
  $('#setName').value = c.name;
  // Черновик собирается заново при каждом открытии: «Отмена» должна
  // возвращать то, что сохранено, а не то, что успели натыкать в прошлый раз.
  netDraft = (c.networks || []).map((n) => ({ ...n, key: '', saved: true }));
  renderNetworks();
  $('#setSeeOpen').checked = c.seeOpen !== false;
  $('#setShowToOpen').checked = c.showToOpen !== false;
  renderRealmNote();
  $('#setMetricsEnabled').checked = Boolean(c.metricsEnabled);
  $('#setMetricsToken').value = '';
  $('#setMetricsToken').placeholder = c.metricsTokenSet ? t('common.tokenSet') : t('common.accessTokenOptional');
  $('#setMetricsTokenClear').checked = false;
  $('#setWebPassword').value = '';
  $('#setWebPassword').placeholder = c.hasWebPassword ? t('common.set_2') : t('common.notSetViewonlyFromOutside');
  $('#setLease').value = Math.round(c.claimLeaseMs / 1000);
  $('#setLogLevel').value = c.logLevel;
  $('#setApiPort').value = c.apiPort;
  $('#setDiscoveryPort').value = c.discoveryPort;
  $('#setUsbipdPath').value = c.usbipdPath || '';
  $('#setUsbipPath').value = c.usbipPath || '';
  $('#setMeterTraffic').checked = Boolean(c.meterTraffic);
  $('#setUpdateMode').value = c.updateMode || 'ask';
  renderUpdateStatusLine();
  $('#setAutoInstall').checked = c.autoInstall !== false;

  $('#setSeeds').value = (c.seeds || []).join('\n');
  $('#setGossip').value = Math.round(c.gossipIntervalMs / 1000);
  $('#setRemotePoll').value = Math.round(c.remotePollIntervalMs / 1000);
  $('#setAnnounce').value = Math.round(c.announceIntervalMs / 1000);
  $('#setAnnounceIdle').value = Math.round(c.announceIdleIntervalMs / 1000);
  $('#setAnnounceBackoff').checked = c.announceBackoff !== false;
  $('#setAnnounceTransport').value = c.announceTransport || 'both';
  renderFederation();
  // Раздел сам раскрывается, когда там есть что показать: и настроенные
  // адреса, и поломки видны без лишнего клика.
  $('#setFederation').open = Boolean((c.seeds || []).length);

  // Автозапуск живёт в системе, а не в конфигурации: галочка отражает то,
  // что показал планировщик, и применяется сразу — «Отмена» его не вернёт.
  const as = state.autostart || {};
  const box = $('#setAutostart');
  box.checked = Boolean(as.enabled);
  box.disabled = !as.supported;
  $('#autostartHint').textContent = as.supported
    ? `${as.method}. ${as.hint} ${t('app.appliedImmediatelyNotBySaveButton')}`
    : (as.hint || t('common.autostartIsNotSupportedOn'));

  $('#settingsNote').textContent = '';

  const sel = $('#setNetwork');
  sel.innerHTML = '<option value="auto">автоматически</option>'
    + state.networks.map((n) => `<option value="${esc(n.cidr)}">${esc(n.cidr)} — ${esc(n.iface)} (${esc(n.address)})</option>`).join('');
  sel.value = c.network;
  // Почему автовыбор не берёт все карты: исключённые видны только здесь,
  // галочки о них живут у карт в «Моих устройствах» и при ручной сети скрыты.
  const excl = state.discoveryExclude || [];
  $('#setNetworkNote').textContent = c.network === 'auto'
    ? `${t('app.searchingInAllNetworks')}${excl.length ? ` ${t('app.excludedCards', { cards: excl.join(', ') })}` : ''}`
    : t('common.searchingForNodesOnThis');

  $('#setTypes').innerHTML = (state.deviceTypes || []).map((t) => `
    <label class="member">
      <input type="checkbox" value="${esc(t.id)}" ${(c.enabledTypes || []).includes(t.id) ? 'checked' : ''}>
      <span>${esc(t.icon)} ${esc(t.plural)}${t.transport === 'none' ? ' <em class="muted">(только бронь)</em>' : ''}</span>
    </label>`).join('');

  $('#settings').showModal();
});

$('#btnCancelSettings').addEventListener('click', () => $('#settings').close('cancel'));

/**
 * Проверка формы перед сохранением.
 *
 * Поле, не прошедшее проверку, браузер пытается показать пользователю — а
 * если оно лежит в свёрнутом разделе, показать его нельзя, и отправка
 * отменяется молча. Со стороны это выглядит как сломанная кнопка: нажимаешь,
 * и ничего не происходит. Поэтому раздел раскрываем сами.
 */
$('#btnSaveSettings').addEventListener('click', (ev) => {
  const form = $('#settings').querySelector('form');
  if (form.checkValidity()) return;

  ev.preventDefault();
  const bad = form.querySelector(':invalid');
  if (!bad) return;
  for (let d = bad.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  bad.scrollIntoView({ block: 'center' });
  bad.reportValidity();
  $('#settingsNote').textContent = t('common.checkTheHighlightedFieldThe');
});

$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'save') return;

  const patch = {
    name: $('#setName').value,
    network: $('#setNetwork').value,
    claimLeaseMs: Number($('#setLease').value) * 1000,
    logLevel: $('#setLogLevel').value,
    apiPort: Number($('#setApiPort').value),
    discoveryPort: Number($('#setDiscoveryPort').value),
    usbipdPath: $('#setUsbipdPath').value.trim(),
    usbipPath: $('#setUsbipPath').value.trim(),
    enabledTypes: [...document.querySelectorAll('#setTypes input:checked')].map((i) => i.value),
    meterTraffic: $('#setMeterTraffic').checked,
    updateMode: $('#setUpdateMode').value,
    autoInstall: $('#setAutoInstall').checked,
    seeds: $('#setSeeds').value.split('\n').map((s) => s.trim()).filter(Boolean),
    gossipIntervalMs: Number($('#setGossip').value) * 1000,
    remotePollIntervalMs: Number($('#setRemotePoll').value) * 1000,
    announceIntervalMs: Number($('#setAnnounce').value) * 1000,
    announceIdleIntervalMs: Number($('#setAnnounceIdle').value) * 1000,
    announceBackoff: $('#setAnnounceBackoff').checked,
    announceTransport: $('#setAnnounceTransport').value,
  };
  // Выбор основной сети вручную: в остальных сетях приложение перестанет работать.
  if (patch.network !== 'auto' && patch.network !== state.config.network) {
    const lostNets = (state.self?.networks || []).filter((n) => n.cidr !== patch.network);
    const lost = lostNets.flatMap((n) => neighborsOnNetwork(n.cidr));
if (lostNets.length && !confirm(t('app.mainNetworkIs', { network: patch.network })
	      + t('app.inOtherNetworks', { networks: lostNets.map((n) => n.cidr).join(', ') })
	      + t('app.willStopSearchingNodes')
	      + (lost.length ? t('app.nodesWillDisappear', { count: lost.length, names: lost.slice(0, 8).map((p) => p.name).join(', ') + (lost.length > 8 ? t('app.andDotMore') : '') }) : '')
	      + t('app.cardsCanBeForwarded'))) {
      return;
    }
  }
  patch.networks = collectNetworks();
  patch.seeOpen = $('#setSeeOpen').checked;
  patch.showToOpen = $('#setShowToOpen').checked;

  patch.metricsEnabled = $('#setMetricsEnabled').checked;
  const tok = $('#setMetricsToken').value.trim();
  if (tok) patch.metricsToken = tok;
  else if ($('#setMetricsTokenClear').checked) patch.metricsToken = '';

  // Пустое поле означает «не менять»: иначе открытие настроек втихую
  // стирало бы заданный пароль.
  const web = $('#setWebPassword').value;
  if (web === '-') patch.webPassword = '';
  else if (web) patch.webPassword = web;

  try {
    const r = await post('/api/v1/settings', patch);
toast(r.needsRestart
	      ? t('common.savedPortAndKeyChanges')
	      : t('common.settingsSaved'), r.needsRestart ? '' : 'ok');
  } catch (e) {
    toast(srv(e), 'err');
    // Диалог уже закрылся формой, но поля в нём остались заполненными.
    // Возвращаем его: иначе отвергнутый адрес пришлось бы набирать заново.
    $('#settingsNote').textContent = e.message;
    $('#setFederation').open = true;
    $('#settings').showModal();
  }
});

/**
 * Алфавит ключа без похожих друг на друга знаков.
 *
 * Ключ переносят на другие компьютеры руками, и нередко — с листка или со
 * слов. O и 0, I и 1 — самые частые источники «ключ тот же, а узлы друг
 * друга не видят»; их здесь нет, а регистр только верхний, поэтому не
 * возникает и пары «строчная l — единица».
 *
 * 32 знака — это ровно 5 бит на символ и ровно 8 значений байта на знак,
 * поэтому 25 символов дают 125 бит без перекоса в вероятностях.
 */
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateKey() {
  const bytes = new Uint8Array(25);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => KEY_ALPHABET[b % 32]);
  // Группами по пять: так его читают вслух и сверяют глазами.
  return [0, 5, 10, 15, 20].map((i) => chars.slice(i, i + 5).join('')).join('-');
}

/**
 * Черновик списка сетей.
 *
 * Правки живут здесь до нажатия «Сохранить», поэтому «Отмена» ничего не
 * меняет. Ключи уже сохранённых сетей сюда не попадают — наружу их не
 * отдают, — и пустое поле ключа означает «оставить прежний».
 */
let netDraft = [];

function renderNetworks() {
  const box = $('#netList');
  if (!netDraft.length) {
    box.innerHTML = '<div class="fed-row muted">' + t('app.noKeyNetworks') + ' '
      + t('common.theNodeWorksOnlyIn') + '</div>';
    return;
  }
  box.innerHTML = netDraft.map((n, i) => `
    <div class="net-row" data-i="${i}">
      <input type="text" class="net-label" maxlength="48" placeholder="${t('common.networkName')}"
             value="${esc(n.label || '')}">
      <input type="password" class="net-key" autocomplete="new-password"
             placeholder="${n.saved ? t('common.keySetLeaveEmpty') : t('common.enterOrCreateAKey')}"
             value="${esc(n.key || '')}">
      <button type="button" class="btn net-gen" title="${t('common.generateARandomKey')}">${t('app.keyLabel')}</button>
      <button type="button" class="btn danger net-del" title="${t('common.removeNetwork')}">✕</button>
      <div class="net-note">${n.realm
        ? t('app.fingerprintSameKey', { realm: `<b>${esc(n.realm)}</b>` })
        : (n.key ? t('common.keyCreatedCopyItNow') : t('common.newNetwork'))}</div>
    </div>`).join('');
}

/** Считать правки из полей в черновик, не теряя несохранённого. */
function collectNetworks() {
  for (const row of document.querySelectorAll('#netList .net-row')) {
    const i = Number(row.dataset.i);
    if (!netDraft[i]) continue;
    netDraft[i].label = row.querySelector('.net-label').value;
    netDraft[i].key = row.querySelector('.net-key').value;
  }
  return netDraft.map((n) => ({ id: n.id, label: n.label, key: n.key }));
}

$('#btnAddNet').addEventListener('click', () => {
  collectNetworks();
  netDraft.push({ id: null, label: '', key: '', realm: null, saved: false });
  renderNetworks();
  const rows = document.querySelectorAll('#netList .net-row');
  rows[rows.length - 1]?.querySelector('.net-label')?.focus();
});

$('#netList').addEventListener('click', (ev) => {
  const row = ev.target.closest('.net-row');
  if (!row) return;
  const i = Number(row.dataset.i);

  if (ev.target.classList.contains('net-del')) {
    collectNetworks();
    netDraft.splice(i, 1);
    renderNetworks();
    return;
  }
  if (ev.target.classList.contains('net-gen')) {
    collectNetworks();
    netDraft[i].key = generateKey();
    // Отпечаток считает узел: он зависит от ключа, и вычислять его здесь
    // значило бы держать две реализации одного правила.
    netDraft[i].realm = null;
    renderNetworks();
    const field = document.querySelectorAll('#netList .net-row')[i]?.querySelector('.net-key');
    if (field) { field.type = 'text'; field.select(); }
  }
});

/** Итог по кругам доверия: в скольких сетях узел и виден ли он без ключа. */
function renderRealmNote() {
  const c = state.config;
  const rows = [];
  if (c.isolated) {
rows.push('<div class="fed-row err">' + t('common.theNodeBelongsToNo') + ' '
	      + t('common.andNoOneSeesIt') + '</div>');
  } else {
    const parts = [];
if (c.networkCount) parts.push(t('app.keyNetworksCount', { count: c.networkCount }));
	    parts.push(c.seeOpen ? t('common.keylessNodesVisible') : t('common.keylessNodesHidden'));
	    parts.push(c.showToOpen ? t('common.weAreVisibleToThem') : t('common.weAreHiddenFromThem'));
	    rows.push(`<div class="fed-row muted">${t('app.currentStatusWithInfo', { info: esc(parts.join('; ')) })}</div>`);
  }
  $('#realmNote').innerHTML = rows.join('');
}

/** Состояние обмена каталогом и темпа анонсов — в самих настройках. */
function renderFederation() {
  const f = state.federation || {};
  const d = f.directory || {};
  const a = f.announce || {};
  const box = $('#federationState');

  const rows = [];
  if (d.blocked) {
    rows.push('<div class="fed-row err">' + t('common.addressesAreSetButThe') + '</div>');
  } else if (!d.enabled) {
    rows.push('<div class="fed-row muted">' + t('common.noAddressesSetWeWork') + '</div>');
  } else {
    for (const s of d.seeds || []) {
      const mark = s.ok === true ? 'ok' : s.ok === false ? 'err' : 'muted';
      const what = s.ok === true
        ? t('app.nodeWithNameAndNetwork', { name: esc(s.name || '?') }) + (s.network ? t('app.commaNetwork', { network: esc(s.network) }) : '')
        : s.ok === false ? esc(s.error || t('common.noLink')) : t('common.notPolledYet');
      rows.push(`<div class="fed-row ${mark}"><b>${esc(s.address)}</b> — ${what}</div>`);
    }
rows.push(`<div class="fed-row muted">${t('app.nodesFromOtherNetworks', { remote: f.remoteCount || 0, local: f.localCount || 0 })}</div>`);
  }
  box.innerHTML = rows.join('');

  const per = a.intervalMs ? Math.round(a.intervalMs / 1000) : null;
  const channels = [a.multicast ? 'multicast' : null, a.broadcast ? 'broadcast' : null].filter(Boolean);
  const legs = (a.interfaces || []).map((l) => {
    const heard = l.lastHeardAt ? `${t('app.seenAgo', { duration: esc(duration(Date.now() - l.lastHeardAt)) })}` : '<b class="err">' + t('common.silent') + '</b>';
    return `${esc(l.iface)} (${esc(l.address)}) — ${heard}`;
  });
const twins = []
	    .concat((a.clones || []).length ? [t('app.cloneNodeId', { clones: a.clones.join(', ') })] : [])
.concat((a.selfMachine || []).length
	      ? [t('app.selfMachineReflection', { nodes: a.selfMachine.map((n) => `«${n.name || n.nodeId.slice(0, 8)}» (${n.address})`).join(', ') })]
      : []);
$('#announceState').innerHTML = per
	    ? `<div class="fed-row muted">${t('app.nowEverySec', { interval: per, sent: a.sent || 0, channels: channels.length ? esc(channels.join(' + ')) : '<b class="err">' + t('common.none') + '</b>' })}</div>`
	    + (legs.length ? `<div class="fed-row muted">${t('app.hearabilityByNetworks', { legs: legs.join('; ') })}</div>` : '')
	    + (twins.length ? `<div class="fed-row err">${t('app.nodeDuplication', { twins: esc(twins.join('; ')) })}</div>` : '')
    : '';
}

// --------------------------------------------------------------- поток данных

function connect() {
  const es = new EventSource('/api/v1/events');
  es.addEventListener('open', () => { $('#connDot').className = 'dot on'; });
  es.addEventListener('state', (ev) => {
    state = JSON.parse(ev.data);
    render();
  });
  es.addEventListener('log', (ev) => {
    logBuffer.push(JSON.parse(ev.data));
    if (logBuffer.length > 500) logBuffer = logBuffer.slice(-500);
    if ($('#tab-log').classList.contains('active')) renderLog();
  });
  es.addEventListener('net', () => net?.onNetEvent());
  es.addEventListener('error', () => { $('#connDot').className = 'dot off'; });
}

fetch('/api/v1/logs?limit=300')
  .then((r) => (r.ok ? r.json() : { records: [] }))
  .then((d) => { logBuffer = d.records || []; renderLog(); })
  .catch(() => {});

fetch('/api/v1/session')
  .then((r) => r.json())
  .then((s) => { sessionLocal = Boolean(s.local); if (state) render(); })
  .catch(() => {});

net = initNet({ $, esc, post, action, toast, canEdit, getState: () => state, routeWarning });
// Язык интерфейса: по умолчанию английский, выбор живёт в этом браузере.
// Смена перезагружает страницу (i18n.setLang) — слушать нужно до startI18n.
const langSelect = $('#langSelect');
langSelect.value = getLang();
langSelect.addEventListener('change', () => setLang(langSelect.value));
startI18n();
connect();
ensureNotificationPermission();

// Длительности считаются от текущего момента — без этого «занято 3 мин назад»
// замирало бы между обновлениями состояния.
setInterval(() => { if (state) render(); }, 10000);
// Обратный отсчёт обновления тикает каждую секунду. Полоса целиком не
// перерисовывается: заменённая кнопка теряла клик между нажатием и отпусканием.
setInterval(() => {
  const u = state?.update;
  if (!u || !(u.trialUntil || u.graceUntil || u.eligibleAt)) return;
  const live = liveUpdateText(u);
  const set = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  set($('#updateBar [data-live="msg"]'), live.message);
  live.waiting.forEach((w, i) => set($(`#updateBar [data-live="w${i}"]`), w));
}, 1000);

// ------------------------------------------------------ копирование драйвера

const SIGNATURE_TEXT = {
	  valid: ['ok', t('common.signatureValid')],
	  invalid: ['err', t('common.signatureFailedVerification')],
	  none: ['err', t('common.unsigned')],
	};

function setDriverDialog({ title, body, install = null }) {
  $('#driverTitle').textContent = title;
  $('#driverBody').innerHTML = body;
  const btn = $('#driverInstall');
  btn.hidden = !install;
  if (install) {
    btn.textContent = install;
    btn.disabled = false;
  }
}

const driverError = (msg) => `<p class="dlg-note" style="white-space:pre-wrap">${esc(msg)}</p>`;

async function openDriverDialog(id, deviceId) {
  driverToken = null;
setDriverDialog({
	    title: t('ui.copyingDriver'),
	    body: '<p class="dlg-note">' + t('common.fetchingTheDriverFromThe') + '</p>',
	  });
  $('#driverDialog').showModal();
  try {
    const r = await post('/api/v1/driver/prepare', { id, deviceId });
    driverToken = r.token;
    const unsigned = r.packages.some((p) => p.signature !== 'valid');
    const items = r.packages.map((p) => {
      const [cls, text] = SIGNATURE_TEXT[p.signature] || ['warn', p.signature];
      return `<div class="card-meta">
<span><b>${esc(p.name)}</b>${p.provider ? `, ${esc(p.provider)}` : ''}${p.version ? t('app.commaVersion', { version: esc(p.version) }) : ''}</span>
	        <span>${t('app.filesCountAndSize', { count: esc(p.fileCount), size: esc(formatVolume(p.size)) })}</span>
        <span class="pill ${cls}">${esc(text)}</span>
        ${p.signer ? `<span>${t('app.publisherColon', { signer: esc(p.signer) })}</span>` : ''}
      </div>${p.signatureNote ? `<p class="hint">${esc(p.signatureNote)}</p>` : ''}`;
    }).join('');
const warning = unsigned
	      ? `<p class="hint"><b>${t('common.warningTheDriverSignatureIs')}</b>
	        ${t('common.64bitWindowsWillMostLikely')}
	        ${t('common.youWillRunKernellevelCode')} ${t('common.ofDevice')}${esc(r.ownerName)}».</p>`
	      : '';
setDriverDialog({
	      title: t('ui.copyingDriver'),
	      body: `<p class="dlg-note">${t('app.deviceDriverFrom', { device: `<b>${esc(r.deviceTitle)}</b>`, owner: esc(r.ownerName) })}
	        ${t('app.willBeAddedToStore')}</p>${items}${warning}`,
	      install: unsigned ? t('common.installAnyway') : t('common.install'),
	    });
  } catch (e) {
    setDriverDialog({ title: t('common.couldNotCopyTheDriver'), body: driverError(e.message) });
  }
}

$('#driverInstall').addEventListener('click', async () => {
  if (!driverToken) return;
  const btn = $('#driverInstall');
  btn.disabled = true;
  btn.textContent = t('common.installing');
  const token = driverToken;
  driverToken = null;
  try {
    const r = await post('/api/v1/driver/install', { token });
    const rows = r.results.map((x) => `<div class="card-meta">
      <span class="pill ${x.ok ? 'ok' : 'err'}">${x.ok ? t('common.installed') : t('common.notInstalled')}</span>
      <b>${esc(x.infName)}</b></div>
      <pre class="hint" style="white-space:pre-wrap">${esc(x.output)}</pre>`).join('');
setDriverDialog({
	      title: r.ok ? t('common.driverInstalled') : t('common.failedToInstallTheDriver'),
	      body: rows + (r.ok
	        ? '<p class="dlg-note">' + t('common.ifTheDeviceIsAlready') + '</p>'
	        : ''),
	    });
	  } catch (e) {
	    setDriverDialog({ title: t('common.failedToInstallTheDriver'), body: driverError(e.message) });
  }
});

$('#driverClose').addEventListener('click', () => $('#driverDialog').close());
$('#driverDialog').addEventListener('close', () => {
  // Не установили — пакет во временной папке больше не нужен.
  if (driverToken) post('/api/v1/driver/cancel', { token: driverToken }).catch(() => {});
  driverToken = null;
});


// ------------------------------------------------------------- обновление

const UPDATE_PHASES = {
	  checking: [t('common.checkingForUpdates'), ''],
	  downloading: [t('common.downloadingTheUpdate'), ''],
	  queued: [t('common.updateQueued'), ''],
	  waiting: [t('common.updateReadyToInstall'), ''],
	  'awaiting-approval': [t('common.updateAvailable'), ''],
	  restarting: [t('common.restartingToUpdate'), ''],
	  trial: [t('common.checkingANewVersion'), ''],
	  'needs-installer': [t('common.installerNeeded'), ''],
	  error: [t('common.updateFailed'), 'err'],
	};

/**
 * Тексты полосы с живым обратным отсчётом. Сервер собирает строки один раз,
 * поэтому число секунд в них пересчитывается здесь по меткам времени.
 */
function liveUpdateText(u) {
  const left = (at) => Math.max(0, Math.ceil((at - Date.now()) / 1000));
  const fix = (s) => String(s)
    .replace(/перезапуск через \d+ с/, (m) => (u.graceUntil ? `перезапуск через ${left(u.graceUntil)} с` : m))
    .replace(/(очередь: \d+-й, перезапуск примерно через) \d+ с/, (m, head) => (u.eligibleAt ? `${head} ${left(u.eligibleAt)} с` : m));
  let message = u.messageCode ? t('srv.' + u.messageCode, u.messageParams) : u.message ? fix(u.message) : '';
  if (u.phase === 'trial' && u.trialUntil) {
    message = t('app.trialRunVersion', { running: u.running, left: left(u.trialUntil) });
  }
  const waiting = (u.waiting || []).map((w) => {
    if (w.code) return t('srv.' + w.code, w.params);
    return fix(w);
  });
  return { message, waiting };
}

/** Полоса над вкладками: что с обновлением и что с ним можно сделать. */
function renderUpdate() {
  const bar = $('#updateBar');
  const u = state.update;
  const warnRunning = u && u.reportedRunning;
  const info = (u && UPDATE_PHASES[u.phase]) || (warnRunning ? [t('common.versionReportedAsCorrupted'), 'err'] : null);
  if (!u || !info) { bar.hidden = true; return; }

  const ver = u.installer?.version || u.candidate?.version || u.staged?.version || '';
  const btns = [];
  if (canEdit()) {
    if (u.awaitingApproval) {
      btns.push(`<button class="btn small primary" data-update="approve" data-version="${esc(u.staged?.version || '')}">Разрешить установку</button>`);
    }
    // «Обновить сейчас» — пока версия скачивается, ждёт очереди или разрешения: сервер сам
    // решит, перезапускаться ли сразу или сперва взять версию у соседей.
    if (u.canUpdateNow && ['checking', 'downloading', 'queued', 'waiting', 'awaiting-approval'].includes(u.phase)) {
      btns.push('<button class="btn small danger" data-update="now">Обновить сейчас</button>');
    }
    if (u.phase === 'error') btns.push('<button class="btn small" data-update="retry">Повторить</button>');
    // Соседи сообщают, что работающая у нас версия испорчена: откатить можно вручную.
    if (warnRunning && u.canRollback) {
      btns.push(`<button class="btn small danger" data-update="rollback">Откатить на ${esc(u.previous)}</button>`);
    }
  }
  // Ссылка открыта и без права правки: скачать файл может любой, ставить — тот, кто за машиной.
  if (u.phase === 'needs-installer') {
    btns.push(u.installer?.url
      ? `<a class="btn small primary" href="${esc(u.installer.url)}" target="_blank" rel="noopener">Скачать установщик у «${esc(u.installer.from)}»</a>`
      : '<span class="banner-hint">Ни у одного из соседей нет установщика для раздачи — возьмите его у администратора.</span>');
  }
const running = warnRunning
	    ? `<p class="banner-hint"><b>${t('app.warningReportedRunning')}</b> ${t('app.nodesReportCorrupted', { nodes: warnRunning.nodes.map((n) => `«${esc(n)}»`).join(', '), version: esc(warnRunning.version) })}${warnRunning.reasons.length ? `: ${esc(warnRunning.reasons.join('; '))}` : ''}. ${t('app.ifEverythingWorksDoNothing')}</p>`
	    : '';
	  const failed = (u.failed || []).length
	    ? `<p class="banner-hint">${t('app.notPassedVerification', { details: u.failed.map((f) => `${esc(f.version)} (${esc(f.reason)})`).join('; ') })}</p>` : '';

  const live = liveUpdateText(u);
  bar.className = `banner ${info[1]}`;
  bar.innerHTML = `<b>${esc(info[0])}${ver ? t('app.dashVersion', { version: esc(ver) }) : ''}</b>
    ${live.message ? `<p class="banner-hint" data-live="msg">${esc(live.message)}</p>` : ''}
    ${u.phase === 'waiting' && live.waiting.length ? `<ul>${live.waiting.map((w, i) => `<li data-live="w${i}">${esc(w)}</li>`).join('')}</ul>` : ''}
    ${running}
    ${btns.length ? `<div class="banner-actions">${btns.join('')}</div>` : ''}${failed}`;
  bar.hidden = false;
}

/** Строка состояния под выбором режима в настройках. */
function renderUpdateStatusLine() {
  const u = state?.update;
  const line = $('#updateStatusLine');
  if (!u) return;
const parts = [t('app.runningVersion', { running: u.running })];
	  if (!u.supported) parts.push(t('app.updateNotAvailable', { reason: u.unsupportedReason }));
	  else if (u.sharing) parts.push(t('app.versionReadyToShare'));
	  if (u.previous) parts.push(t('app.previousVersionSaved', { previous: u.previous }));
	  line.textContent = parts.join(' ');
	  $('#setUpdateMode').disabled = !u.supported;
	  const rb = $('#btnRollback');
	  if (rb) {
	    rb.hidden = !(u.supported && u.canRollback && canEdit());
	    rb.textContent = t('app.rollbackToVersion', { version: u.previous || '' });
	  }
}

/**
 * Держатель устройства перестал отвечать (выключили, пропала сеть). Владелец
 * видит, что устройство вот-вот освободится само, а не «занято навсегда».
 */
function silentHolderPill(claim) {
  if (!claim || !claim.holderSilentMs || !claim.leaseMs) return '';
  if (claim.holderSilentMs < claim.leaseMs / 2) return '';
  const left = Math.max(0, Math.round((claim.expiresAt - Date.now()) / 1000));
  return ` <span class="pill warn" title="${t('common.theHolderSendsNoHeartbeat')}">${t('app.holderNotResponding', { seconds: Math.round(claim.holderSilentMs / 1000) })}${t('app.willFreeIn', { seconds: left })}</span>`;
}


/**
 * Разбор «идентификатор занятия|устройство». Сам идентификатор занятия — это
 * «узел|цель», то есть уже содержит «|», поэтому делить по первому или по всем
 * разделителям нельзя: устройство — только последний кусок. (Раньше деление по
 * всем давало вместо занятия один идентификатор узла: «занятие не найдено».)
 */
/**
 * Windows шлёт пакеты к соседям сети владельца не через мост — например, из-за
 * совпадающих адресов в офисной сети. Молча это не оставляем: «мост собран, а до
 * прибора не дойти» выглядит как поломка приложения.
 */
function routeWarning(res) {
  const bad = res?.routeWarn || [];
  if (!bad.length) return;
  const list = bad.slice(0, 5).map((b) => `${b.ip} → «${b.via}»`).join(', ');
toast(t('app.warningRouteToAddresses', { count: bad.length, list: list + (bad.length > 5 ? '…' : '') }) + t('app.openBridgeDiagnostics'), 'err');
}

/** Запись каталога по владельцу и цели — и устройство, и группа, и участник группы. */
function findEntry(nodeId, target) {
  for (const e of state?.catalog || []) {
    if (e.ownerId === nodeId && e.target === target) return e;
    for (const m of e.members || []) if (m.ownerId === nodeId && m.target === target) return m;
  }
  return null;
}

/**
 * Узел виден из нескольких сетей — спрашиваем, через какую подключаться.
 * Если сеть одна, действие выполняется сразу.
 *
 * @param {(routeKey: string|null) => void} go
 */
function chooseRoute(nodeId, target, go) {
  const entry = findEntry(nodeId, target);
  const routes = entry?.ownerRoutes || [];
  if (routes.length < 2) { go(null); return; }

  $('#routeTarget').textContent = t('app.nodeSeenFromSeveralNetworks', { name: entry.ownerName });
  $('#routeList').innerHTML = routes.map((r, i) => {
const how = r.via
	      ? (r.mode === 'tunnel' ? t('app.viaGatewayTunnel', { name: esc(r.via.name || '?') })
	         : r.mode === 'direct' ? t('app.viaGatewayDirect', { name: esc(r.via.name || '?') })
	         : t('app.viaGatewayChecking', { name: esc(r.via.name || '?') }))
	      : t('common.directlyOnYourNetwork');
    return `<label class="route-opt"><input type="radio" name="route" value="${esc(r.key)}" ${i === 0 ? 'checked' : ''}>
      <span><b class="mono">${esc(r.address)}</b> <span class="muted">${esc(r.network || '')}</span><br><span class="muted">${how}</span></span></label>`;
  }).join('');
  routeContext = go;
  $('#routeDialog').showModal();
}

function splitLast(value) {
  const cut = String(value).lastIndexOf('|');
  return [String(value).slice(0, cut), String(value).slice(cut + 1)];
}

// Метрики: случайный токен создаётся здесь и показывается один раз — на сервере остаётся только хеш.
$('#btnMetricsGen').addEventListener('click', () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  $('#setMetricsToken').value = token;
  $('#setMetricsTokenClear').checked = false;
  $('#setMetricsEnabled').checked = true;
  toast(t('common.tokenCreatedCopyItNow'), 'ok');
});
