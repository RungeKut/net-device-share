// Интерфейс пользователя.
//
// Состояние приходит целиком одним объектом по SSE — так экран не может
// разойтись с реальностью: нет частичных обновлений, которые пришлось бы
// сшивать на клиенте.

const $ = (sel) => document.querySelector(sel);
let state = null;
let logBuffer = [];
let bannerDismissed = false;

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

function since(ts) {
  if (!ts) return '—';
  return duration(Date.now() - ts);
}

function at(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 8000 : 4000);
}

// ------------------------------------------------------------------- запросы

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

// --------------------------------------------------------------- отрисовка

function render() {
  if (!state) return;
  renderHeader();
  renderCatalog();
  renderMine();
  renderAttached();
  renderPeers();
}

function renderHeader() {
  const s = state.self;
  $('#selfLine').textContent = `${s.name} · ${s.address} · сеть ${s.network} (${s.iface})`;
  document.title = `${s.name} — Net Device Share`;

  const server = $('#capServer');
  server.className = `cap ${state.backend.server ? 'on' : 'off'}`;
  server.title = state.backend.server
    ? 'Свои устройства можно публиковать'
    : 'Серверная часть USB/IP не найдена — публикация недоступна';

  const client = $('#capClient');
  client.className = `cap ${state.backend.client ? 'on' : 'off'}`;
  client.title = state.backend.client
    ? 'Чужие устройства можно подключать'
    : 'Клиентская часть USB/IP не найдена — подключение недоступно';

  renderBanner();

  $('#cntCatalog').textContent = state.catalog.length;
  $('#cntMine').textContent = state.localDevices.filter((d) => d.busid).length;
  $('#cntAttached').textContent = state.attachments.length;
  $('#cntPeers').textContent = state.peers.filter((p) => p.online).length;
  $('#autoShare').checked = Boolean(state.config.autoShareNew);
}

/**
 * Баннер состояния окружения USB/IP.
 *
 * Он же — место, откуда ставятся недостающие компоненты: сообщение о проблеме
 * и средство её решить должны быть рядом, иначе пользователь уходит читать
 * документацию ради того, что делается одной кнопкой.
 */
function renderBanner() {
  const banner = $('#banner');
  const issues = state.backend.issues || [];
  const inst = state.install;
  const running = inst && inst.state === 'running';
  const failed = inst && inst.state === 'error';
  // Успешный итог показываем недолго: дальше баннер только мешает.
  const justDone = inst && inst.state === 'done' && Date.now() - (inst.finishedAt || 0) < 90000;

  if ((!issues.length && !running && !failed && !justDone) || bannerDismissed) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  banner.className = `banner${justDone && !issues.length ? ' ok' : failed ? ' err' : ''}`;

  // --- идёт установка ---
  if (running) {
    const tail = (inst.steps || []).slice(-6);
    banner.innerHTML = `
      <b>Идёт установка компонентов USB/IP…</b>
      <p class="banner-hint">Если Windows запросит права администратора — подтвердите. Это может занять около минуты.</p>
      <pre class="banner-log">${tail.map((s) => esc(s.text)).join('\n') || 'подготовка…'}</pre>`;
    return;
  }

  // --- установка только что завершилась ---
  if (justDone && !issues.length) {
    banner.innerHTML = `
      <b>Готово: всё необходимое установлено.</b>
      <p class="banner-hint">Окружение перепроверено, ограничения сняты.</p>
      <div class="banner-actions"><button class="btn small" data-dismiss="1">Скрыть</button></div>`;
    return;
  }

  // --- есть проблемы ---
  const parts = [`<b>Окружение USB/IP настроено не полностью</b>`];
  if (issues.length) {
    parts.push(`<ul>${issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`);
  }
  if (failed && inst.error) {
    parts.push(`<p class="banner-error">Установка не удалась: ${esc(inst.error)}</p>`);
  }

  if (inst && inst.canInstall) {
    const todo = inst.components.filter((c) => c.needed);
    const size = todo.reduce((s, c) => s + (c.sizeMb || 0), 0);
    parts.push(`
      <div class="banner-actions">
        <button class="btn primary" id="btnInstall">${failed ? 'Повторить установку' : 'Установить'}</button>
        <span class="banner-hint">${esc(todo.map((c) => `${c.title.split('—')[0].trim()} ${c.version}`).join(', '))}
          — ${size ? esc(size.toFixed(1)) : '?'} МБ из папки <code>installers</code>, интернет не нужен.
          Потребуются права администратора.</span>
      </div>`);
    const note = todo.find((c) => c.signerNote);
    if (note) parts.push(`<p class="banner-hint">${esc(note.signerNote)}</p>`);
  } else if (inst && !inst.supported && (inst.hints || []).length) {
    parts.push(`<p class="banner-hint">Установка вручную:</p><ul>${
      inst.hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`);
  } else if (inst && inst.components.some((c) => c.needed === false && !c.fileAvailable)) {
    parts.push(`<p class="banner-hint">Файлы установщиков в папке <code>installers</code> не найдены —
      см. <code>installers/README.md</code>.</p>`);
  }

  banner.innerHTML = parts.join('');
}

function deviceIds(d) {
  const ids = d.vendorId && d.productId ? `${d.vendorId}:${d.productId}` : '';
  return ids ? `<span class="mono">${esc(ids)}</span>` : '';
}

function renderCatalog() {
  const onlyFree = $('#onlyFree').checked;
  const items = state.catalog.filter((d) => !onlyFree || !d.busy);
  const box = $('#catalogList');

  if (!items.length) {
    box.innerHTML = `<div class="empty">${state.catalog.length
      ? 'Все устройства сейчас заняты.'
      : 'Опубликованных устройств в сети пока нет.<br>Опубликуйте своё на вкладке «Мои устройства» или дождитесь других узлов.'}</div>`;
    return;
  }

  box.innerHTML = items.map((d) => {
    const cls = !d.ownerOnline ? 'offline' : d.busyByMe ? 'mine' : d.busy ? 'busy' : 'free';
    const status = d.busyByMe
      ? `<span class="pill mine">занято вами · ${esc(since(d.claim.since))}</span>`
      : d.busy
        ? `<span class="pill busy">занято: ${esc(d.claim.holderName)} · ${esc(since(d.claim.since))}</span>`
        : `<span class="pill free">свободно</span>`;

    const ownerTag = d.ownerSelf ? '<span class="pill plain">моё устройство</span>' : '';
    const offline = d.ownerOnline ? '' : '<span class="pill err">владелец офлайн</span>';

    // Занять можно свободное устройство у доступного узла; отключить —
    // только то, что занято лично нами.
    const canAttach = !d.busy && d.ownerOnline && state.backend.client;
    const actions = [];
    if (d.busyByMe && d.attachmentId) {
      actions.push(`<button class="btn small danger" data-detach="${esc(d.attachmentId)}">Освободить</button>`);
    } else if (canAttach) {
      actions.push(`<button class="btn small primary" data-attach="${esc(d.ownerId)}|${esc(d.busid)}">Занять</button>`);
    } else if (d.busy && d.ownerSelf) {
      actions.push(`<button class="btn small danger" data-force="${esc(d.busid)}">Отобрать</button>`);
    }

    return `
      <article class="card ${cls}">
        <div class="card-main">
          <div class="card-title">
            ${esc(d.description)} ${status} ${ownerTag} ${offline}
          </div>
          <div class="card-meta">
            <span>владелец: <b>${esc(d.ownerName)}</b> (${esc(d.ownerAddress)})</span>
            <span>шина: <span class="mono">${esc(d.busid)}</span></span>
            ${deviceIds(d) ? `<span>ид: ${deviceIds(d)}</span>` : ''}
            ${d.serial ? `<span>с/н: <span class="mono">${esc(d.serial)}</span></span>` : ''}
            <span>подключено к владельцу: ${esc(since(d.connectedSince))}${d.connectedSince ? ` (${esc(at(d.connectedSince))})` : ''}</span>
            ${d.sharedSince ? `<span>опубликовано: ${esc(since(d.sharedSince))}</span>` : ''}
            ${d.vhciPort !== null && d.vhciPort !== undefined ? `<span>порт VHCI: ${esc(d.vhciPort)}</span>` : ''}
            ${d.note ? `<span>заметка: ${esc(d.note)}</span>` : ''}
            ${d.lastError ? `<span class="pill err">${esc(d.lastError)}</span>` : ''}
          </div>
        </div>
        <div class="card-actions">${actions.join('')}</div>
      </article>`;
  }).join('');
}

function renderMine() {
  const items = state.localDevices;
  const box = $('#mineList');

  if (!items.length) {
    box.innerHTML = '<div class="empty">USB-устройства не обнаружены.</div>';
    return;
  }

  box.innerHTML = items.map((d) => {
    const blocked = !d.busid;
    const cls = blocked ? 'offline' : d.claim ? 'busy' : d.shared ? 'free' : '';
    const status = d.claim
      ? `<span class="pill busy">занято: ${esc(d.claim.holderName)} · ${esc(since(d.claim.since))}</span>`
      : d.shared
        ? '<span class="pill free">опубликовано, свободно</span>'
        : '<span class="pill plain">не опубликовано</span>';

    const actions = [];
    if (!blocked) {
      actions.push(`<button class="btn small ${d.shared ? '' : 'primary'}" data-share="${esc(d.busid)}|${d.shared ? '0' : '1'}">${
        d.shared ? 'Снять с публикации' : 'Опубликовать'}</button>`);
      if (d.claim) {
        actions.push(`<button class="btn small danger" data-force="${esc(d.busid)}">Отобрать</button>`);
      }
    }

    return `
      <article class="card ${cls}">
        <div class="card-main">
          <div class="card-title">${esc(d.description)} ${blocked ? '' : status}</div>
          <div class="card-meta">
            <span>шина: <span class="mono">${esc(d.busid || '—')}</span></span>
            ${deviceIds(d) ? `<span>ид: ${deviceIds(d)}</span>` : ''}
            ${d.serial ? `<span>с/н: <span class="mono">${esc(d.serial)}</span></span>` : ''}
            <span>подключено: ${esc(since(d.connectedSince))}</span>
            <span>состояние драйвера: <b>${esc(d.bindState)}</b></span>
            ${d.lastError ? `<span class="pill err">${esc(d.lastError)}</span>` : ''}
            ${blocked ? `<span class="pill err">${esc(d.unavailableReason || 'публикация недоступна')}</span>` : ''}
          </div>
          ${blocked ? '' : `<input class="note-input" data-note="${esc(d.busid)}" value="${esc(d.note || '')}" placeholder="заметка: что это за устройство (видна другим)">`}
        </div>
        <div class="card-actions">${actions.join('')}</div>
      </article>`;
  }).join('');
}

function renderAttached() {
  const items = state.attachments;
  const box = $('#attachedList');

  if (!items.length) {
    box.innerHTML = '<div class="empty">Сейчас к этому компьютеру ничего не подключено по сети.</div>';
    return;
  }

  box.innerHTML = items.map((a) => {
    const cls = a.state === 'error' ? 'error' : a.state === 'attached' ? 'mine' : '';
    const stateLabel = {
      attaching: 'подключается…',
      attached: 'подключено',
      detaching: 'отключается…',
      error: 'ошибка',
    }[a.state] || a.state;

    return `
      <article class="card ${cls}">
        <div class="card-main">
          <div class="card-title">
            ${esc(a.description)}
            <span class="pill ${a.state === 'error' ? 'err' : 'mine'}">${esc(stateLabel)}</span>
            ${a.self ? '<span class="pill plain">своё устройство</span>' : ''}
            ${a.orphan ? '<span class="pill plain">вне приложения</span>' : ''}
          </div>
          <div class="card-meta">
            <span>источник: <b>${esc(a.nodeName)}</b> (${esc(a.host)})</span>
            <span>шина: <span class="mono">${esc(a.busid)}</span></span>
            ${a.vhciPort !== null && a.vhciPort !== undefined ? `<span>порт VHCI: <b>${esc(a.vhciPort)}</b></span>` : ''}
            <span>подключено: ${esc(since(a.attachedAt || a.since))}</span>
            ${a.lastHeartbeat ? `<span>связь с владельцем: ${esc(since(a.lastHeartbeat))} назад</span>` : ''}
            ${a.lastError ? `<span class="pill err">${esc(a.lastError)}</span>` : ''}
          </div>
        </div>
        <div class="card-actions">
          <button class="btn small danger" data-detach="${esc(a.id)}">Отключить</button>
        </div>
      </article>`;
  }).join('');
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
        <div class="card-title">
          ${esc(p.name)}
          <span class="pill ${p.online ? 'free' : 'err'}">${p.online ? 'в сети' : 'не отвечает'}</span>
        </div>
        <div class="card-meta">
          <span>адрес: <b>${esc(p.address)}</b>:${esc(p.apiPort)}</span>
          <span>платформа: ${esc(p.platform || '—')}</span>
          <span>версия: ${esc(p.version || '—')}</span>
          <span>устройств: <b>${esc(p.deviceCount)}</b> (занято ${esc(p.busyCount)})</span>
          <span>работает: ${esc(since(p.startedAt))}</span>
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

  const tab = t.closest('.tab');
  if (tab) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === tab));
    const name = tab.dataset.tab;
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    return;
  }

  if (t.id === 'btnInstall') {
    action(t, () => post('/api/v1/install', {}));
    return;
  }
  if (t.dataset.dismiss) {
    bannerDismissed = true;
    $('#banner').hidden = true;
    return;
  }

  if (t.dataset.attach) {
    const [nodeId, busid] = t.dataset.attach.split('|');
    action(t, () => post('/api/v1/attach', { nodeId, busid }), 'Устройство занято и подключено');
  } else if (t.dataset.detach) {
    action(t, () => post('/api/v1/detach', { id: t.dataset.detach }), 'Устройство освобождено');
  } else if (t.dataset.force) {
    if (confirm('Принудительно освободить устройство? Тот, кто с ним работает, потеряет соединение.')) {
      action(t, () => post('/api/v1/force-release', { busid: t.dataset.force }), 'Устройство освобождено');
    }
  } else if (t.dataset.share) {
    const [busid, flag] = t.dataset.share.split('|');
    action(t, () => post('/api/v1/share', { busid, shared: flag === '1' }));
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.dataset.note) {
    post('/api/v1/note', { busid: t.dataset.note, note: t.value }).catch((e) => toast(e.message, 'err'));
  } else if (t.id === 'autoShare') {
    post('/api/v1/settings', { autoShareNew: t.checked }).catch((e) => toast(e.message, 'err'));
  } else if (t.id === 'onlyFree') {
    renderCatalog();
  }
});

$('#btnRefresh').addEventListener('click', (ev) => {
  action(ev.target, () => post('/api/v1/refresh', {}));
});

$('#btnSettings').addEventListener('click', () => {
  const c = state.config;
  $('#setName').value = c.name;
  $('#setKey').value = '';
  $('#setKey').placeholder = c.hasKey ? '•••••• (задан) — введите новый или оставьте пустым' : 'оставьте пустым — без проверки';
  $('#setLease').value = Math.round(c.claimLeaseMs / 1000);
  $('#setLogLevel').value = c.logLevel;
  $('#setApiPort').value = c.apiPort;
  $('#setDiscoveryPort').value = c.discoveryPort;
  $('#setUsbipdPath').value = c.usbipdPath || '';
  $('#setUsbipPath').value = c.usbipPath || '';
  $('#settingsNote').textContent = '';

  const sel = $('#setNetwork');
  sel.innerHTML = '<option value="auto">автоматически</option>'
    + state.networks.map((n) => `<option value="${esc(n.cidr)}">${esc(n.cidr)} — ${esc(n.iface)} (${esc(n.address)})</option>`).join('');
  sel.value = c.network;

  $('#settings').showModal();
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
  };
  // Пустое поле ключа означает «не менять»: иначе открытие настроек
  // втихую стирало бы заданный ключ.
  const key = $('#setKey').value;
  if (key) patch.preSharedKey = key;

  try {
    const r = await post('/api/v1/settings', patch);
    toast(r.needsRestart
      ? 'Настройки сохранены. Изменения портов и ключа вступят в силу после перезапуска.'
      : 'Настройки сохранены', r.needsRestart ? '' : 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
});

// --------------------------------------------------------------- поток данных

function connect() {
  const es = new EventSource('/api/v1/events');

  es.addEventListener('open', () => {
    $('#connDot').className = 'dot on';
  });

  es.addEventListener('state', (ev) => {
    state = JSON.parse(ev.data);
    render();
  });

  es.addEventListener('log', (ev) => {
    logBuffer.push(JSON.parse(ev.data));
    if (logBuffer.length > 500) logBuffer = logBuffer.slice(-500);
    if ($('#tab-log').classList.contains('active')) renderLog();
  });

  es.addEventListener('error', () => {
    $('#connDot').className = 'dot off';
    // EventSource переподключается сам; пересоздавать его вручную не нужно.
  });
}

fetch('/api/v1/logs?limit=300')
  .then((r) => r.json())
  .then((d) => { logBuffer = d.records || []; renderLog(); })
  .catch(() => {});

connect();

// Длительности в карточках считаются от текущего момента — без этого
// «занято 3 мин назад» замирало бы между обновлениями состояния.
setInterval(() => { if (state) render(); }, 10000);
