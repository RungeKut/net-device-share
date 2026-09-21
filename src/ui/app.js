// Интерфейс пользователя.
//
// Состояние приходит целиком одним объектом по SSE — так экран не может
// разойтись с реальностью: нет частичных обновлений, которые пришлось бы
// сшивать на клиенте.
//
// Уровень доступа приходит в том же снимке (`access`). В режиме только для
// чтения интерфейс не рисует действий, но полагаться на это нельзя —
// права проверяет сервер, здесь лишь убираем заведомо бесполезные кнопки.

const $ = (sel) => document.querySelector(sel);
let state = null;
let logBuffer = [];
let bannerDismissed = false;
let shownRequestIds = new Set();
let currentRequest = null;
let askContext = null;
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
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч${m % 60 ? ` ${m % 60} мин` : ''}`;
  const d = Math.floor(h / 24);
  return `${d} дн${h % 24 ? ` ${h % 24} ч` : ''}`;
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
    headers: { 'content-type': 'application/json' },
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
    .catch((e) => toast(e.message, 'err'))
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
    const n = new Notification('У вас просят устройство', {
      body: `${req.requesterName} просит ${req.title}${req.message ? `\n«${req.message}»` : ''}`,
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
    document.title = flip ? '⚠ У ВАС ПРОСЯТ УСТРОЙСТВО' : base;
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
    <p class="request-line"><b>${esc(req.requesterName)}</b> просит освободить</p>
    <p class="request-target">${esc(req.title)}</p>
    ${req.message ? `<p class="request-message">«${esc(req.message)}»</p>` : ''}
    <p class="dlg-note">Запрос отправлен ${esc(since(req.createdAt))} назад.
      ${incoming.length > 1 ? `Ещё запросов в очереди: ${incoming.length - 1}.` : ''}</p>`;

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

function render() {
  if (!state) return;
  renderHeader();
  renderCatalog();
  renderMine();
  renderGroups();
  renderAttached();
  renderPeers();
  // Пока настройки открыты, состояние обмена в них живое: адрес набирают
  // и тут же смотрят, ответил ли узел, а не переоткрывают окно.
  if ($('#settings').open) { renderFederation(); renderRealmNote(); }
  handleIncomingRequests();
}

function renderHeader() {
  const s = state.self;
  $('#selfLine').textContent = `${s.name} · ${s.address} · сеть ${s.network} (${s.iface})`;
  if (!titleFlashTimer) document.title = `${s.name} — Net Device Share`;

  const server = $('#capServer');
  server.className = `cap ${state.backend.server ? 'on' : 'off'}`;
  server.title = state.backend.server ? 'Свои USB-устройства можно публиковать'
    : 'Серверная часть USB/IP не найдена — публикация USB недоступна';

  const client = $('#capClient');
  client.className = `cap ${state.backend.client ? 'on' : 'off'}`;
  client.title = state.backend.client ? 'Чужие USB-устройства можно подключать'
    : 'Клиентская часть USB/IP не найдена — подключение USB недоступно';

  const ro = !canEdit();
  $('#accessBadge').hidden = !ro;
  $('#btnLogin').hidden = !ro;
  $('#btnLogout').hidden = ro || !state.config.hasWebPassword;
  $('#btnSettings').hidden = ro;

  const bar = $('#readonlyBar');
  bar.hidden = !ro;
  if (ro) {
    bar.innerHTML = state.config.hasWebPassword
      ? '<b>Режим просмотра.</b> Каталог и занятость видны полностью. Чтобы занимать и публиковать устройства, нажмите «Войти» и введите пароль.'
      : '<b>Режим просмотра.</b> Управление с других компьютеров закрыто: пароль не задан. Задайте его в настройках на том компьютере, где запущено приложение.';
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
      <b>Идёт установка компонентов USB/IP…</b>
      <p class="banner-hint">Windows запросит права администратора — подтвердите. Запрос приходит на каждый компонент отдельно; в окне видно издателя установщика. Это может занять около минуты.</p>
      <pre class="banner-log">${tail.map((s) => esc(s.text)).join('\n') || 'подготовка…'}</pre>`;
    return;
  }

  if (justDone && !issues.length) {
    banner.innerHTML = `
      <b>Готово: всё необходимое установлено.</b>
      <p class="banner-hint">Окружение перепроверено, ограничения сняты.</p>
      <div class="banner-actions"><button class="btn small" data-dismiss="1">Скрыть</button></div>`;
    return;
  }

  const parts = ['<b>Окружение USB/IP настроено не полностью</b>'];
  if (issues.length) parts.push(`<ul>${issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`);
  if (failed && inst.error) parts.push(`<p class="banner-error">Установка не удалась: ${esc(inst.error)}</p>`);

  if (inst && inst.canInstall) {
    const todo = inst.components.filter((c) => c.needed);
    const size = todo.reduce((s, c) => s + (c.sizeMb || 0), 0);
    parts.push(`
      <div class="banner-actions">
        <button class="btn primary" id="btnInstall">${failed ? 'Повторить установку' : 'Установить'}</button>
        <span class="banner-hint">${esc(todo.map((c) => `${c.title.split('—')[0].trim()} ${c.version}`).join(', '))}
          — ${size ? esc(size.toFixed(1)) : '?'} МБ из папки <code>installers</code>, интернет не нужен.
          Потребуются права администратора: Windows спросит подтверждение на каждый компонент.</span>
      </div>`);
    const note = todo.find((c) => c.signerNote);
    if (note) parts.push(`<p class="banner-hint">${esc(note.signerNote)}</p>`);
  } else if (inst && !inst.supported && (inst.hints || []).length) {
    parts.push(`<p class="banner-hint">Установка вручную:</p><ul>${
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

// ------------------------------------------------------------------ каталог

function statusPill(entry) {
  if (entry.busyByMe) return `<span class="pill mine">занято вами · ${esc(since(entry.claim.since))}</span>`;
  if (entry.busy) return `<span class="pill busy">занято: ${esc(entry.claim.holderName)} · ${esc(since(entry.claim.since))}</span>`;
  if (entry.reservedFor) return `<span class="pill warn">придержано за ${esc(entry.reservedFor.nodeName)}</span>`;
  return '<span class="pill free">свободно</span>';
}

/**
 * Скорость обмена — «байт в минуту».
 *
 * Показывается объём за последнюю минуту, а не мгновенная скорость: минута
 * сглаживает рывки USB-обмена, и по ней видно, работает устройство или
 * просто числится занятым.
 */
function formatRate(bytesPerMinute) {
  if (!bytesPerMinute) return '0 Б/мин';
  if (bytesPerMinute < 1024) return `${bytesPerMinute} Б/мин`;
  if (bytesPerMinute < 1024 * 1024) return `${(bytesPerMinute / 1024).toFixed(1)} КБ/мин`;
  return `${(bytesPerMinute / 1048576).toFixed(2)} МБ/мин`;
}

function formatVolume(bytes) {
  if (!bytes) return '0 Б';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} МБ`;
  return `${(bytes / 1073741824).toFixed(2)} ГБ`;
}

/** Полоска активности: приём и передача за последнюю минуту. */
function trafficPill(t) {
  if (!t) return '';
  const total = (t.bytesInPerMinute || 0) + (t.bytesOutPerMinute || 0);
  const idle = total === 0;
  const title = `За последнюю минуту принято ${formatRate(t.bytesInPerMinute)}, `
    + `передано ${formatRate(t.bytesOutPerMinute)}. `
    + `Всего за сеанс: ${formatVolume((t.totalIn || 0) + (t.totalOut || 0))}.`;
  return `<span class="pill traffic ${idle ? 'idle' : 'busy-flow'}" title="${esc(title)}">`
    + `${idle ? '⏸' : '⇅'} ${esc(formatRate(total))}</span>`;
}

function transportPill(hasTransport) {
  return hasTransport
    ? ''
    : '<span class="pill plain" title="Учитывается занятость, данные по сети не пробрасываются">только бронь</span>';
}

/** Кнопки для записи каталога — и для устройства, и для группы. */
function entryActions(entry) {
  if (!canEdit()) return '';
  const acts = [];

  if (entry.busyByMe && entry.attachmentId) {
    acts.push(`<button class="btn small danger" data-detach="${esc(entry.attachmentId)}">Освободить</button>`);
  } else if (entry.busy) {
    // Владелец забирает своё без спроса: оборудование стоит у него.
    if (entry.ownerSelf) {
      acts.push(`<button class="btn small danger" data-take="${esc(entry.ownerId)}|${esc(entry.target)}">Забрать себе</button>`);
      acts.push(`<button class="btn small" data-force="${esc(entry.target)}">Просто освободить</button>`);
    } else if (entry.ownerOnline) {
      acts.push(`<button class="btn small" data-ask="${esc(entry.ownerId)}|${esc(entry.target)}|${esc(entry.title)}">Попросить</button>`);
    }
  } else if (entry.ownerOnline && entry.available !== false) {
    acts.push(`<button class="btn small primary" data-attach="${esc(entry.ownerId)}|${esc(entry.target)}">Занять</button>`);
  }
  return acts.join('');
}

function deviceMeta(d) {
  const m = d.meta || {};
  const bits = [];
  if (m.vendorId && m.productId) bits.push(`ид: <span class="mono">${esc(m.vendorId)}:${esc(m.productId)}</span>`);
  if (m.serial) bits.push(`с/н: <span class="mono">${esc(m.serial)}</span>`);
  if (m.viaUsb) bits.push('через USB-переходник');
  if (m.status) bits.push(`состояние: ${esc(m.status)}`);
  if (m.mac) bits.push(`MAC: <span class="mono">${esc(m.mac)}</span>`);
  if (m.linkSpeed) bits.push(`скорость: ${esc(m.linkSpeed)}`);
  if (Array.isArray(m.addresses) && m.addresses.length) {
    bits.push(`адреса: <span class="mono">${esc(m.addresses.map((a) => a.address).join(', '))}</span>`);
  }
  return bits;
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
          ${d.busy ? trafficPill(d.traffic) : ''}
          ${transportPill(d.hasTransport)}
          ${d.ownerSelf ? '<span class="pill plain">моё</span>' : ''}
          ${d.ownerOnline ? '' : '<span class="pill err">владелец офлайн</span>'}
        </div>
        ${d.purpose ? `<div class="purpose">${esc(d.purpose)}</div>` : ''}
        <div class="card-meta">
          ${insideGroup ? '' : `<span>владелец: <b>${esc(d.ownerName)}</b> (${esc(d.ownerAddress)})${remoteMark(d.ownerId)}</span>`}
          <span>${esc(d.typeTitle)}: <span class="mono">${esc(d.subtitle)}</span></span>
          ${meta.map((b) => `<span>${b}</span>`).join('')}
          ${d.connectedSince ? `<span>подключено: ${esc(since(d.connectedSince))} (${esc(at(d.connectedSince))})</span>` : ''}
          ${d.vhciPort !== null && d.vhciPort !== undefined ? `<span>порт VHCI: <b>${esc(d.vhciPort)}</b></span>` : ''}
          ${d.lastError ? `<span class="pill err">${esc(d.lastError)}</span>` : ''}
        </div>
      </div>
      <div class="card-actions">${insideGroup ? '' : entryActions(d)}</div>
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
            <span>владелец: <b>${esc(g.ownerName)}</b> (${esc(g.ownerAddress)})${remoteMark(g.ownerId)}</span>
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
      ? (words.length ? `Ничего не найдено по запросу «${esc($('#search').value.trim())}».` : 'Под фильтр ничего не подходит.')
      : 'Опубликованных устройств в сети пока нет.<br>Опубликуйте своё на вкладке «Мои устройства» или дождитесь других узлов.'}</div>`;
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
    pending: ['warn', 'ждём ответа'],
    accepted: ['ok', 'отдано вам — занимайте'],
    granted: ['ok', 'освободилось'],
    declined: ['err', 'отказано'],
    expired: ['err', 'истёк без ответа'],
    superseded: ['plain', 'владелец забрал себе'],
  };

  box.innerHTML = `<div class="outgoing">${list.map((r) => {
    const [kind, text] = label[r.state] || ['plain', r.state];
    return `<div class="outgoing-row">
      <span class="pill ${kind}">${esc(text)}</span>
      <span>ваш запрос: <b>${esc(r.title)}</b> у «${esc(r.holderName)}»</span>
      ${r.state === 'pending' && canEdit()
        ? `<button class="btn small" data-cancel-request="${esc(r.id)}">Отменить</button>` : ''}
    </div>`;
  }).join('')}</div>`;
}

// ------------------------------------------------------------ мои устройства

function renderMine() {
  const items = state.localDevices;
  const box = $('#mineList');
  if (!items.length) {
    box.innerHTML = '<div class="empty">Устройства не обнаружены. Проверьте, какие типы включены в настройках.</div>';
    return;
  }

  const ro = !canEdit();
  box.innerHTML = items.map((d) => {
    const blocked = Boolean(d.unavailableReason);
    // Ограничения накладывает только ОПУБЛИКОВАННАЯ группа. Пока она
    // не опубликована, устройство публикуется и занимается само по себе.
    const inGroup = Boolean(d.groupPublished);
    const cls = blocked ? 'offline' : d.claim ? 'busy' : d.shared ? 'free' : '';
    const status = d.claim
      ? `<span class="pill busy">занято: ${esc(d.claim.holderName)} · ${esc(since(d.claim.since))}</span>`
      : d.shared ? '<span class="pill free">опубликовано, свободно</span>'
        : '<span class="pill plain">не опубликовано</span>';

    const acts = [];
    if (!blocked && !ro) {
      if (!inGroup) {
        acts.push(`<button class="btn small ${d.shared ? '' : 'primary'}" data-share="${esc(d.deviceId)}|${d.shared ? '0' : '1'}">${
          d.shared ? 'Снять с публикации' : 'Опубликовать'}</button>`);
      }
      if (d.claim) acts.push(`<button class="btn small danger" data-force="${esc(d.deviceId)}">Освободить</button>`);
    }

    return `
      <article class="card ${cls}">
        <div class="card-main">
          <div class="card-title">
            <span class="type-icon" title="${esc(d.typeTitle)}">${esc(d.icon)}</span>
            ${esc(d.description)}
            ${blocked ? '' : status}
            ${d.claim ? trafficPill(d.traffic) : ''}
            ${transportPill(d.hasTransport)}
            ${d.groupId ? `<span class="pill group-pill">${inGroup ? 'отдано группой' : 'в группе (не опубл.)'} «${esc(d.groupName || '')}»</span>` : ''}
          </div>
          <div class="card-meta">
            <span>${esc(d.typeTitle)}: <span class="mono">${esc(d.title)}</span></span>
            ${deviceMeta(d).map((b) => `<span>${b}</span>`).join('')}
            <span>состояние драйвера: <b>${esc(d.bindState)}</b></span>
            ${d.lastError ? `<span class="pill err">${esc(d.lastError)}</span>` : ''}
            ${blocked ? `<span class="pill err">${esc(d.unavailableReason)}</span>` : ''}
          </div>
          ${blocked || ro ? (d.purpose ? `<div class="purpose">${esc(d.purpose)}</div>` : '')
            : `<input class="purpose-input" data-purpose="${esc(d.deviceId)}" value="${esc(d.purpose || '')}"
                 maxlength="500" placeholder="для чего это устройство — текст видят все">`}
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
    box.innerHTML = '<div class="empty">Групп пока нет. Объедините устройства, которые имеет смысл занимать только вместе.</div>';
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
        g.shared ? 'Снять с публикации' : 'Опубликовать'}</button>`,
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
          ? 'Группа опубликована: её устройства занимаются только целиком и не публикуются по отдельности.'
          : 'Группа не опубликована: её устройства ведут себя как обычные — публикуются и занимаются по отдельности.'}</p>
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
    box.innerHTML = '<div class="empty">Сейчас этот компьютер ничего не занимает.</div>';
    return;
  }

  const label = { attaching: 'занимается…', attached: 'занято', detaching: 'освобождается…', error: 'ошибка' };
  box.innerHTML = items.map((a) => `
    <article class="card ${a.state === 'error' ? 'error' : a.state === 'attached' ? 'mine' : ''}">
      <div class="card-main">
        <div class="card-title">
          ${a.kind === 'group' ? '<span class="type-icon">🧩</span>' : ''}
          ${esc(a.title)}
          <span class="pill ${a.state === 'error' ? 'err' : 'mine'}">${esc(label[a.state] || a.state)}</span>
          ${a.self ? '<span class="pill plain">своё устройство</span>' : ''}
          ${a.orphan ? '<span class="pill plain">вне приложения</span>' : ''}
        </div>
        <div class="card-meta">
          <span>источник: <b>${esc(a.nodeName)}</b> (${esc(a.host)})</span>
          <span>занято: ${esc(since(a.attachedAt || a.since))}</span>
          ${a.lastHeartbeat ? `<span>связь с владельцем: ${esc(since(a.lastHeartbeat))} назад</span>` : ''}
          ${a.lastError ? `<span class="pill err">${esc(a.lastError)}</span>` : ''}
        </div>
        <div class="card-meta">
          ${a.parts.map((p) => `<span>${esc(p.description || p.deviceId)}${
            p.hasTransport
              ? (p.vhciPort !== null && p.vhciPort !== undefined ? ` → порт VHCI ${esc(p.vhciPort)}` : ' → подключается')
              : ' → бронь'} ${p.traffic ? trafficPill(p.traffic) : ''}</span>`).join('')}
        </div>
        ${a.parts.some((p) => p.hasTransport) && !a.parts.some((p) => p.traffic)
          ? '<p class="hint">Скорость не показывается: у владельца выключен учёт трафика.</p>' : ''}
      </div>
      <div class="card-actions">
        ${canEdit() ? `<button class="btn small danger" data-detach="${esc(a.id)}">Освободить</button>` : ''}
      </div>
    </article>`).join('');
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
  const via = p.viaName ? `узнан от «${p.viaName}»` : 'узнан из каталога';
  return `${via}. Обмен идёт с ним напрямую, посредник в передаче данных не участвует.`;
}

function renderPeers() {
  const box = $('#peersList');
  const self = state.self;
  const selfCard = `
    <article class="card mine">
      <div class="card-main">
        <div class="card-title">${esc(self.name)} <span class="pill mine">этот компьютер</span></div>
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

  const peers = state.peers.map((p) => `
    <article class="card ${p.online ? 'free' : 'offline'}">
      <div class="card-main">
        <div class="card-title">${esc(p.name)}
          <span class="pill ${p.online ? 'free' : 'err'}">${p.online ? 'в сети' : 'не отвечает'}</span>
          ${p.origin && p.origin !== 'local' ? `<span class="pill remote" title="${esc(remoteHint(p))}">другая сеть</span>` : ''}
          ${p.realmLabel ? `<span class="pill plain" title="круг доверия ${esc(p.realm || '')}">${esc(p.realmLabel)}</span>` : ''}</div>
        <div class="card-meta">
          <span>адрес: <b>${esc(p.address)}</b>:${esc(p.apiPort)}</span>
          ${p.origin !== 'local' && p.network ? `<span>сеть: ${esc(p.network)}</span>` : ''}
          <span>платформа: ${esc(p.platform || '—')}</span>
          <span>версия: ${esc(p.version || '—')}</span>
          <span>устройств: <b>${esc(p.deviceCount)}</b> (занято ${esc(p.busyCount)})</span>
          <span>последний ответ: ${esc(since(p.lastSeen))} назад</span>
          ${p.stateError ? `<span class="pill err">${esc(p.stateError)}</span>` : ''}
        </div>
      </div>
      <div class="card-actions"></div>
    </article>`).join('');

  box.innerHTML = selfCard + (peers || '<div class="empty">Других узлов в сети не найдено.</div>');
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

  const tab = t.closest('.tab');
  if (tab) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === tab));
    const name = tab.dataset.tab;
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'log') renderLog();
    return;
  }

  if (t.id === 'btnInstall') { action(t, () => post('/api/v1/install', {})); return; }
  if (t.dataset.dismiss) { bannerDismissed = true; $('#banner').hidden = true; return; }

  if (t.dataset.attach) {
    const [nodeId, target] = t.dataset.attach.split('|');
    action(t, () => post('/api/v1/attach', { nodeId, target }), 'Занято');
  } else if (t.dataset.take) {
    const [nodeId, target] = t.dataset.take.split('|');
    if (confirm('Забрать устройство себе? Тот, кто с ним работает, потеряет соединение без предупреждения.')) {
      action(t, () => post('/api/v1/attach', { nodeId, target, force: true }), 'Устройство у вас');
    }
  } else if (t.dataset.detach) {
    action(t, () => post('/api/v1/detach', { id: t.dataset.detach }), 'Освобождено');
  } else if (t.dataset.force) {
    if (confirm('Освободить принудительно? Тот, кто с ним работает, потеряет соединение.')) {
      action(t, () => post('/api/v1/force-release', { target: t.dataset.force }), 'Освобождено');
    }
  } else if (t.dataset.share) {
    const [deviceId, flag] = t.dataset.share.split('|');
    action(t, () => post('/api/v1/share', { deviceId, shared: flag === '1' }));
  } else if (t.dataset.ask) {
    const [nodeId, target, title] = t.dataset.ask.split('|');
    askContext = { nodeId, target };
    $('#askTarget').textContent = `Цель: ${title}`;
    $('#askMessage').value = '';
    $('#askDialog').showModal();
  } else if (t.dataset.cancelRequest) {
    action(t, () => post('/api/v1/request/cancel', { requestId: t.dataset.cancelRequest }));
  } else if (t.dataset.groupShare) {
    const [groupId, flag] = t.dataset.groupShare.split('|');
    action(t, () => post('/api/v1/group/share', { groupId, shared: flag === '1' }),
      flag === '1' ? 'Группа опубликована' : 'Группа снята с публикации');
  } else if (t.dataset.editGroup) {
    openGroupDialog(state.localGroups.find((g) => g.id === t.dataset.editGroup));
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.purpose) {
    post('/api/v1/purpose', { deviceId: t.dataset.purpose, purpose: t.value })
      .then(() => toast('Описание сохранено', 'ok'))
      .catch((e) => toast(e.message, 'err'));
  } else if (t.id === 'autoShare') {
    post('/api/v1/settings', { autoShareNew: t.checked }).catch((e) => toast(e.message, 'err'));
  } else if (t.id === 'setAutostart') {
    // Действие над системой, а не правка настройки: применяем сразу и
    // возвращаем галочку на место, если не получилось.
    const wanted = t.checked;
    t.disabled = true;
    post('/api/v1/autostart', { enabled: wanted })
      .then((st) => {
        t.checked = Boolean(st.enabled);
        toast(st.enabled ? 'Автозапуск включён' : 'Автозапуск выключен', 'ok');
      })
      .catch((e) => { t.checked = !wanted; toast(e.message, 'err'); })
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
    toast(accept ? 'Устройство отдано' : 'В запросе отказано', accept ? 'ok' : '');
  } catch (e) {
    toast(e.message, 'err');
  }
});

// --- диалог «попросить» (мы проситель) ---
$('#askDialog').addEventListener('close', async () => {
  if ($('#askDialog').returnValue !== 'send' || !askContext) return;
  const { nodeId, target } = askContext;
  askContext = null;
  try {
    await post('/api/v1/request', { nodeId, target, message: $('#askMessage').value });
    toast('Запрос отправлен держателю', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
});

// --- диалог группы ---
function openGroupDialog(group) {
  $('#groupDialogTitle').textContent = group ? 'Изменение группы' : 'Новая группа';
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
      </label>`).join('') || '<div class="empty">Нет свободных устройств: все уже состоят в других группах.</div>';

  $('#groupDialog').showModal();
}

$('#groupDialog').addEventListener('close', async () => {
  const dlg = $('#groupDialog');
  const id = dlg.dataset.groupId || undefined;
  try {
    if (dlg.returnValue === 'delete') {
      if (!id) return;
      await post('/api/v1/group/delete', { groupId: id });
      toast('Группа удалена', 'ok');
    } else if (dlg.returnValue === 'save') {
      const members = [...dlg.querySelectorAll('#groupMembers input:checked')].map((i) => i.value);
      await post('/api/v1/group/save', {
        id,
        name: $('#groupName').value,
        description: $('#groupDescription').value,
        members,
      });
      toast('Группа сохранена', 'ok');
    }
  } catch (e) {
    toast(e.message, 'err');
  }
});

// --- вход ---
$('#loginDialog').addEventListener('close', async () => {
  if ($('#loginDialog').returnValue !== 'login') return;
  try {
    await post('/api/v1/login', { password: $('#loginPassword').value });
    toast('Полный доступ получен', 'ok');
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
  $('#setWebPassword').value = '';
  $('#setWebPassword').placeholder = c.hasWebPassword ? '•••••• (задан)' : 'не задан — извне только просмотр';
  $('#setLease').value = Math.round(c.claimLeaseMs / 1000);
  $('#setLogLevel').value = c.logLevel;
  $('#setApiPort').value = c.apiPort;
  $('#setDiscoveryPort').value = c.discoveryPort;
  $('#setUsbipdPath').value = c.usbipdPath || '';
  $('#setUsbipPath').value = c.usbipPath || '';
  $('#setMeterTraffic').checked = Boolean(c.meterTraffic);

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
    ? `${as.method}. ${as.hint} Применяется сразу, а не по кнопке «Сохранить».`
    : (as.hint || 'на этой системе автозапуск не поддерживается');

  $('#settingsNote').textContent = '';

  const sel = $('#setNetwork');
  sel.innerHTML = '<option value="auto">автоматически</option>'
    + state.networks.map((n) => `<option value="${esc(n.cidr)}">${esc(n.cidr)} — ${esc(n.iface)} (${esc(n.address)})</option>`).join('');
  sel.value = c.network;

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
  $('#settingsNote').textContent = 'Проверьте выделенное поле — значение вне допустимых пределов.';
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
    seeds: $('#setSeeds').value.split('\n').map((s) => s.trim()).filter(Boolean),
    gossipIntervalMs: Number($('#setGossip').value) * 1000,
    remotePollIntervalMs: Number($('#setRemotePoll').value) * 1000,
    announceIntervalMs: Number($('#setAnnounce').value) * 1000,
    announceIdleIntervalMs: Number($('#setAnnounceIdle').value) * 1000,
    announceBackoff: $('#setAnnounceBackoff').checked,
    announceTransport: $('#setAnnounceTransport').value,
  };
  patch.networks = collectNetworks();
  patch.seeOpen = $('#setSeeOpen').checked;
  patch.showToOpen = $('#setShowToOpen').checked;

  // Пустое поле означает «не менять»: иначе открытие настроек втихую
  // стирало бы заданный пароль.
  const web = $('#setWebPassword').value;
  if (web === '-') patch.webPassword = '';
  else if (web) patch.webPassword = web;

  try {
    const r = await post('/api/v1/settings', patch);
    toast(r.needsRestart
      ? 'Сохранено. Изменения портов и ключа вступят в силу после перезапуска.'
      : 'Настройки сохранены', r.needsRestart ? '' : 'ok');
  } catch (e) {
    toast(e.message, 'err');
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
    box.innerHTML = '<div class="fed-row muted">Ни одной сети с ключом. '
      + 'Узел работает только в открытом круге — там, где ключ не проверяется.</div>';
    return;
  }
  box.innerHTML = netDraft.map((n, i) => `
    <div class="net-row" data-i="${i}">
      <input type="text" class="net-label" maxlength="48" placeholder="название сети"
             value="${esc(n.label || '')}">
      <input type="password" class="net-key" autocomplete="new-password"
             placeholder="${n.saved ? 'ключ задан — оставьте пустым' : 'введите или создайте ключ'}"
             value="${esc(n.key || '')}">
      <button type="button" class="btn net-gen" title="Создать случайный ключ">Ключ</button>
      <button type="button" class="btn danger net-del" title="Удалить сеть">✕</button>
      <div class="net-note">${n.realm
        ? `отпечаток <b>${esc(n.realm)}</b> — на компьютерах с тем же ключом он такой же`
        : (n.key ? 'ключ создан: скопируйте его сейчас, после сохранения он не показывается' : 'новая сеть')}</div>
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
    rows.push('<div class="fed-row err">Узел не состоит ни в одном круге: он никого не видит '
      + 'и никому не виден. Заведите сеть с ключом или включите открытый круг.</div>');
  } else {
    const parts = [];
    if (c.networkCount) parts.push(`сетей с ключом: ${c.networkCount}`);
    parts.push(c.seeOpen ? 'узлы без ключа видим' : 'узлы без ключа не видим');
    parts.push(c.showToOpen ? 'им видны' : 'им не видны');
    rows.push(`<div class="fed-row muted">Сейчас: ${esc(parts.join('; '))}.</div>`);
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
    rows.push('<div class="fed-row err">Адреса указаны, но общий ключ не задан — обмен выключен.</div>');
  } else if (!d.enabled) {
    rows.push('<div class="fed-row muted">Адреса не указаны — работаем только в своей подсети.</div>');
  } else {
    for (const s of d.seeds || []) {
      const mark = s.ok === true ? 'ok' : s.ok === false ? 'err' : 'muted';
      const what = s.ok === true
        ? `узел «${esc(s.name || '?')}»${s.network ? `, сеть ${esc(s.network)}` : ''}`
        : s.ok === false ? esc(s.error || 'нет связи') : 'ещё не опрошен';
      rows.push(`<div class="fed-row ${mark}"><b>${esc(s.address)}</b> — ${what}</div>`);
    }
    rows.push(`<div class="fed-row muted">Узлов из других сетей: ${f.remoteCount || 0};
      в своей подсети: ${f.localCount || 0}.</div>`);
  }
  box.innerHTML = rows.join('');

  const per = a.intervalMs ? Math.round(a.intervalMs / 1000) : null;
  const channels = [a.multicast ? 'multicast' : null, a.broadcast ? 'broadcast' : null].filter(Boolean);
  $('#announceState').innerHTML = per
    ? `<div class="fed-row muted">Сейчас: раз в ${per} с, отправлено ${a.sent || 0};
       каналы: ${channels.length ? esc(channels.join(' + ')) : '<b class="err">ни одного</b>'}.</div>`
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
  es.addEventListener('error', () => { $('#connDot').className = 'dot off'; });
}

fetch('/api/v1/logs?limit=300')
  .then((r) => (r.ok ? r.json() : { records: [] }))
  .then((d) => { logBuffer = d.records || []; renderLog(); })
  .catch(() => {});

connect();
ensureNotificationPermission();

// Длительности считаются от текущего момента — без этого «занято 3 мин назад»
// замирало бы между обновлениями состояния.
setInterval(() => { if (state) render(); }, 10000);
