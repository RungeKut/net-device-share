// HTTP-сервер: он же интерфейс пользователя, он же транспорт RPC между узлами.
//
// Порт один, уровней доступа три:
//
//   peer   — вызовы других узлов (/api/v1/peer/*): проверяются подпись
//            и принадлежность к рабочей сети;
//   full   — полное управление: с локального адреса всегда, с чужого —
//            после ввода пароля;
//   readonly — просмотр каталога с чужого компьютера без пароля.
//
// Разделение «локально всё, извне по паролю» отражает простой факт:
// у того, кто сидит за этой машиной, и так есть все возможности — он может
// выдернуть устройство из разъёма. Требовать с него пароль бессмысленно.
//
// ЧУЖИЕ СТРАНИЦЫ. «Локально всё» означает: любой запрос с этой машины. Его
// может отправить и посторонняя страница, открытая в браузере здесь же, —
// браузер пошлёт простой POST на 127.0.0.1 куда угодно. Раньше это давало
// ей публикацию и занятие устройств, с настройкой сети — ещё и мосты и
// адреса. Поэтому каждый изменяющий запрос интерфейса несёт заголовок
// X-NDS-UI: свой заголовок браузер со сторонней страницы без
// предварительного запроса CORS не пошлёт, а на него мы не отвечаем.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { logger, recentLogs, onLogRecord } from '../log.js';
import { AUTH_HEADER, NODE_HEADER } from '../net/rpc.js';
import { ipInCidr, normalizeIp, listNetworks } from '../net/interfaces.js';

const log = logger('http');
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const SESSION_COOKIE = 'nds_session';
const SESSION_TTL_MS = 12 * 3600 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** Операции, меняющие состояние: доступны только при полном доступе. */
const MUTATING = new Set([
  '/api/v1/settings', '/api/v1/share', '/api/v1/purpose', '/api/v1/force-release',
  '/api/v1/attach', '/api/v1/detach', '/api/v1/refresh', '/api/v1/install',
  '/api/v1/group/save', '/api/v1/group/delete', '/api/v1/group/share',
  '/api/v1/request', '/api/v1/request/answer', '/api/v1/request/cancel',
  '/api/v1/autostart',
  '/api/v1/net/switch/create', '/api/v1/net/switch/delete', '/api/v1/net/switch/rename',
  '/api/v1/net/switch/nic', '/api/v1/net/switch/host',
  '/api/v1/net/vnic/create', '/api/v1/net/vnic/delete', '/api/v1/net/vnic/update',
  '/api/v1/net/adapter/ip', '/api/v1/net/adapter/category', '/api/v1/net/bridge/ip',
  '/api/v1/net/held/ip',
]);

/** Заголовок, по которому видно, что запрос отправил наш интерфейс. */
export const UI_HEADER = 'x-nds-ui';

export class ApiServer {
  /** @param {object} app — объект приложения (см. core/app.js) */
  constructor(app) {
    this.app = app;
    this.server = null;
    /** @type {Map<import('node:http').ServerResponse, string>} поток → уровень доступа */
    this.sseClients = new Map();
    this.pushTimer = null;
    this.netTimer = null;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((e) => {
        log.error('необработанная ошибка запроса:', e.message);
        sendJson(res, 500, { error: 'internal', message: e.message });
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      // Слушаем все интерфейсы: сюда стучатся и соседние узлы, и люди
      // с других компьютеров. Разграничение — на уровне маршрутов.
      this.server.listen(this.app.config.get('apiPort'), '0.0.0.0', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });

    onLogRecord((rec) => this._broadcast('log', rec, 'full'));
    log.info(`HTTP API на порту ${this.app.config.get('apiPort')}; интерфейс: http://${this.app.config.get('uiHost')}:${this.app.config.get('apiPort')}/`);
    return this;
  }

  async stop() {
    for (const res of this.sseClients.keys()) {
      try { res.end(); } catch { /* клиент уже отвалился */ }
    }
    this.sseClients.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  pushState() {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      // Снимок строится под каждый уровень доступа отдельно: это дешевле,
      // чем фильтровать на клиенте, и надёжнее — лишнее просто не уходит.
      const byAccess = new Map();
      for (const [res, access] of this.sseClients) {
        if (!byAccess.has(access)) byAccess.set(access, JSON.stringify(this.app.snapshot(access)));
        try {
          res.write(`event: state\ndata: ${byAccess.get(access)}\n\n`);
        } catch {
          this.sseClients.delete(res);
        }
      }
    }, 150);
    this.pushTimer.unref?.();
  }

  /**
   * Карта сети поменялась. Самой карты в снимке нет — её опись стоит
   * секунду PowerShell, — поэтому интерфейсу уходит только знак «перечитай».
   */
  notifyNet() {
    clearTimeout(this.netTimer);
    this.netTimer = setTimeout(() => this._broadcast('net', { ts: Date.now(), busy: this.app.netManager?.busy || null }, 'full'), 200);
    this.netTimer.unref?.();
  }

  _broadcast(event, data, minAccess = 'readonly') {
    if (!this.sseClients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [res, access] of this.sseClients) {
      if (minAccess === 'full' && access !== 'full') continue;
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  // ------------------------------------------------------------------ доступ

  /** Уровень доступа запроса: 'full' с локальной машины либо по сессии. */
  _accessOf(req) {
    const remote = normalizeIp(req.socket.remoteAddress || '');
    if (isLoopback(remote)) return 'full';
    if (this._validSession(req)) return 'full';
    return 'readonly';
  }

  _sessionSecret() {
    return this.app.config.get('sessionSecret') || '';
  }

  /**
   * Сессия — это «срок годности + подпись». Хранить список выданных сессий
   * не нужно: подпись проверяется вычислением, а срок ограничивает ущерб
   * от утёкшей cookie.
   */
  _makeSession() {
    const expires = Date.now() + SESSION_TTL_MS;
    const sig = crypto.createHmac('sha256', this._sessionSecret())
      .update(String(expires)).digest('hex');
    return `${expires}.${sig}`;
  }

  _validSession(req) {
    const raw = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
    if (!raw) return false;
    const [expiresStr, sig] = String(raw).split('.');
    const expires = Number(expiresStr);
    if (!Number.isFinite(expires) || expires < Date.now()) return false;

    const expected = crypto.createHmac('sha256', this._sessionSecret())
      .update(String(expires)).digest('hex');
    if (!sig || sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  // ---------------------------------------------------------------- маршруты

  async _handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const remote = normalizeIp(req.socket.remoteAddress || '');

    if (route.startsWith('/api/v1/peer/')) {
      return this._handlePeer(req, res, route, remote);
    }
    if (route.startsWith('/api/')) {
      return this._handleUiApi(req, res, route, url);
    }
    return this._serveStatic(res, route);
  }

  async _handlePeer(req, res, route, remote) {
    const cidr = this.app.network?.cidr;
    const realms = this.app.realms;
    const local = isLoopback(remote) || !cidr || ipInCidr(remote, cidr);

    // Вызов из другой сети принимается, только если есть хоть один ключ.
    //
    // Внутри своей подсети границу доверия держит адрес: чужому надо сперва
    // в неё попасть. За её пределами такой границы нет, и единственной
    // остаётся подпись — а в открытом круге подпись не проверяется вовсе.
    // Пускать в этом случае значит открыть управление устройствами всем, до
    // кого дотянется маршрут.
    if (!local && !realms.keyed().length) {
      log.warn(`отклонён вызов ${route} вне рабочей сети (${remote}): ни одной ключевой сети`);
      return sendJson(res, 403, {
        error: 'out_of_network',
        message: 'адрес вне рабочей сети, а ключевых сетей не задано — межсетевая работа отключена',
      });
    }
    if (!local) log.trace(`вызов ${route} из другой сети (${remote}) — проверяем подпись`);

    const raw = await readBody(req);

    // Какому нашему кругу принадлежит вызывающий. Ключевые круги пробуются
    // первыми: открытый принимает любую подпись и иначе перехватывал бы
    // вызовы из всех чужих ключевых сетей.
    const circle = realms.match(raw, req.headers[AUTH_HEADER] || '');
    if (!circle) {
      log.warn(`отклонён вызов ${route} с неверной подписью (${remote})`);
      return sendJson(res, 401, { error: 'bad_signature', message: 'неверная подпись — не совпадает общий ключ' });
    }
    // Вызов без подписи из открытого круга — только если мы в нём состоим.
    if (circle.open && !local && !realms.keyed().length) {
      return sendJson(res, 403, { error: 'out_of_network', message: 'открытый круг не выходит за пределы своей подсети' });
    }

    const body = parseJson(raw);
    const callerId = req.headers[NODE_HEADER] || null;
    const share = this.app.share;

    try {
      switch (`${req.method} ${route}`) {
        case 'GET /api/v1/peer/ping':
          return sendJson(res, 200, {
            ok: true,
            nodeId: this.app.config.get('nodeId'),
            name: this.app.config.get('name'),
            // Хеш состояния здесь затем, чтобы узлы из других сетей могли
            // дёшево проверять, не изменилось ли что-нибудь: анонсов по UDP
            // они от нас не слышат, а тянуть полный список устройств ради
            // ответа «всё по-прежнему» — лишний трафик через маршрутизатор.
            stateHash: share.hash(),
            // Круг доверия. По нему спрашивающий решает, отдавать ли нам
            // каталог. Ничего не раскрывает: тот же отпечаток уходит в
            // каждом анонсе открытым текстом.
            realm: circle.realm,
          });

        case 'GET /api/v1/peer/state':
          return sendJson(res, 200, {
            nodeId: this.app.config.get('nodeId'),
            name: this.app.config.get('name'),
            version: this.app.version,
            startedAt: this.app.startedAt,
            platform: process.platform,
            usbipPort: this.app.config.get('usbipPort'),
            apiPort: this.app.config.get('apiPort'),
            stateHash: share.hash(),
            devices: share.listShared(),
            // Неопубликованная группа — внутренняя заготовка владельца,
            // соседям её знать незачем.
            groups: share.listGroups().filter((g) => g.shared),
            // Запросы отдаём только те, что касаются спрашивающего.
            requests: callerId ? share.requestsFor(callerId) : [],
          });

        // Каталог узлов. Только «кто есть и по какому адресу» — ни списков
        // устройств, ни занятости здесь нет: их каждый спрашивает у
        // владельца напрямую, чтобы мост не оказался в тракте данных.
        case 'GET /api/v1/peer/directory':
          return sendJson(res, 200, this.app.directory.payload(circle.realm));

        case 'POST /api/v1/peer/directory': {
          // Круг доверия сверяем и здесь. Узел БЕЗ ключа принимает любую
          // подпись, поэтому без этой проверки достаточно было бы вписать
          // его адрес — и он получил бы карту чужой сети целиком, включая
          // узлы, которых по обычному обнаружению не видит.
          if (body?.realm !== circle.realm) {
            log.warn(`каталог от ${remote} отклонён: другой круг доверия (${body?.realm || 'не указан'})`);
            return sendJson(res, 403, {
              error: 'other_realm',
              message: 'другой круг доверия — общие ключи не совпадают',
            });
          }
          // Кто принёс каталог, тем и определяется, рассказывать ли о нём
          // дальше. От соседа по подсети — это пересказ, и он на нас
          // заканчивается. Из другой сети — мы становимся мостом для своей.
          const origin = local ? 'relay' : 'seed';
          const added = this.app.peers.onDirectory(body?.peers, {
            origin,
            realm: circle.realm,
            viaNodeId: body?.nodeId || callerId,
            viaName: body?.name || null,
          });
          if (added && origin === 'seed') {
            log.info(`каталог от "${body?.name || remote}": узлов принято ${added} — рассказываем своей подсети`);
            // Анонс уйдёт с новым отпечатком каталога, и соседи заберут
            // его сами, не дожидаясь своего круга обмена.
            this.app.onStateChanged();
          }
          return sendJson(res, 200, this.app.directory.payload(circle.realm));
        }

        case 'POST /api/v1/peer/claim': {
          if (!body?.target || !callerId) return sendJson(res, 400, { error: 'bad_request', message: 'нужны target и идентификатор узла' });
          const result = await share.claim(body.target, {
            holderId: callerId,
            holderName: body.holderName || callerId.slice(0, 8),
            // Чужой узел не может «забрать без спроса»: право владельца
            // действует только на своём узле.
            force: false,
            // Канал сетевой карты пускает только с адреса, с которого заняли.
            holderAddress: remote,
          });
          this.app.onStateChanged();
          return sendJson(res, 200, result);
        }

        case 'POST /api/v1/peer/release': {
          if (!body?.target || !callerId) return sendJson(res, 400, { error: 'bad_request', message: 'нужны target и идентификатор узла' });
          const result = await share.release(body.target, callerId);
          this.app.onStateChanged();
          return sendJson(res, 200, result);
        }

        case 'POST /api/v1/peer/heartbeat': {
          if (!body?.target || !callerId) return sendJson(res, 400, { error: 'bad_request', message: 'нужны target и идентификатор узла' });
          return sendJson(res, 200, share.renew(body.target, callerId));
        }

        case 'POST /api/v1/peer/request': {
          if (!body?.target || !callerId) return sendJson(res, 400, { error: 'bad_request', message: 'нужны target и идентификатор узла' });
          const r = share.createRequest({
            target: body.target,
            requesterId: callerId,
            requesterName: body.requesterName || callerId.slice(0, 8),
            message: body.message,
          });
          this.app.onStateChanged();
          return sendJson(res, 200, r);
        }

        case 'POST /api/v1/peer/request-answer': {
          if (!body?.requestId || !callerId) return sendJson(res, 400, { error: 'bad_request', message: 'нужен requestId' });
          const r = await share.answerRequest(body.requestId, callerId, Boolean(body.accept));
          this.app.onStateChanged();
          return sendJson(res, 200, r);
        }

        case 'POST /api/v1/peer/net-ip': {
          // Держатель брони меняет настройки карты под себя. Право — только
          // у того, кто её держит; вернутся настройки при освобождении.
          if (!body?.target || !callerId) return sendJson(res, 400, { error: 'bad_request', message: 'нужны target и идентификатор узла' });
          const claim = share.claims.get(body.target);
          if (!claim || claim.holderId !== callerId) {
            return sendJson(res, 403, { error: 'forbidden', message: 'карта занята не вами — менять её настройки нельзя' });
          }
          const dev = share.get(body.target);
          if (!dev) return sendJson(res, 404, { error: 'not_found', message: 'карта не найдена' });
          const r = await this.app.net.holderSetIp(dev, body.ip);
          this.app.hub.invalidateSlow();
          await share.refresh();
          this.app.onStateChanged();
          return sendJson(res, 200, r);
        }

        case 'POST /api/v1/peer/revoked': {
          // Владелец отозвал наше право. Проверять, что вызывающий —
          // действительно владелец, не нужно: занятие ищется по паре
          // «узел + цель», и чужой узел просто ничего не найдёт.
          if (!body?.target || !callerId) return sendJson(res, 400, { error: 'bad_request' });
          const done = await this.app.attach.revokedByOwner(callerId, body.target, body.reason);
          this.app.onStateChanged();
          return sendJson(res, 200, { ok: true, detached: done });
        }

        case 'POST /api/v1/peer/notify-request': {
          // Владелец сообщает нам, что кто-то просит цель, которую мы держим.
          if (!body?.request) return sendJson(res, 400, { error: 'bad_request' });
          const taken = this.app.attach.acceptPush(body.request, body.owner || {});
          return sendJson(res, 200, { ok: true, accepted: taken });
        }

        default:
          return sendJson(res, 404, { error: 'not_found' });
      }
    } catch (e) {
      const status = e.code === 'busy' ? 409
        : e.code === 'device_not_found' || e.code === 'not_found' ? 404
        : e.code === 'forbidden' ? 403 : 400;
      return sendJson(res, status, { error: e.code || 'failed', message: e.message, claim: e.claim || null });
    }
  }

  // ------------------------------------------------------------------- UI API

  async _handleUiApi(req, res, route, url) {
    const access = this._accessOf(req);

    if (req.method === 'GET' && route === '/api/v1/events') {
      return this._sse(req, res, access);
    }
    if (req.method === 'GET' && route === '/api/v1/state') {
      return sendJson(res, 200, this.app.snapshot(access));
    }
    if (req.method === 'GET' && route === '/api/v1/session') {
      return sendJson(res, 200, {
        access,
        passwordRequired: this.app.config.hasWebPassword(),
        local: isLoopback(normalizeIp(req.socket.remoteAddress || '')),
      });
    }
    if (req.method === 'GET' && route === '/api/v1/logs') {
      if (access !== 'full') return sendJson(res, 403, { error: 'forbidden', message: 'журнал доступен только при полном доступе' });
      return sendJson(res, 200, { records: recentLogs(Number(url.searchParams.get('limit')) || 200) });
    }
    if (req.method === 'GET' && route === '/api/v1/net/map') {
      if (access !== 'full') {
        return sendJson(res, 403, { error: 'forbidden', message: 'карта сети доступна только при полном доступе — войдите по паролю' });
      }
      try {
        return sendJson(res, 200, await this.app.netManager.map());
      } catch (e) {
        return sendJson(res, 500, { error: 'failed', message: e.message });
      }
    }
    if (req.method === 'GET' && route === '/api/v1/networks') {
      if (access !== 'full') return sendJson(res, 403, { error: 'forbidden' });
      return sendJson(res, 200, { networks: listNetworks(), current: this.app.network });
    }

    if (req.method !== 'POST') return sendJson(res, 404, { error: 'not_found' });

    if (req.headers[UI_HEADER] !== '1') {
      log.warn(`отклонён ${route} без заголовка интерфейса (${normalizeIp(req.socket.remoteAddress || '')}, origin ${req.headers.origin || '—'})`);
      return sendJson(res, 403, { error: 'foreign_page', message: 'запрос пришёл не из интерфейса приложения' });
    }

    const body = parseJson(await readBody(req)) || {};

    // Вход и выход доступны всем: иначе в режиме только-чтения нельзя было бы
    // получить полный доступ.
    if (route === '/api/v1/login') {
      if (!this.app.config.hasWebPassword()) {
        return sendJson(res, 400, { error: 'no_password', message: 'пароль удалённого доступа не задан — управление возможно только с этого компьютера' });
      }
      if (!this.app.config.checkWebPassword(body.password)) {
        log.warn(`неудачная попытка входа с ${normalizeIp(req.socket.remoteAddress || '')}`);
        // Задержка гасит перебор: сто попыток в секунду превращаются в две.
        await new Promise((r) => setTimeout(r, 500));
        return sendJson(res, 401, { error: 'bad_password', message: 'неверный пароль' });
      }
      log.info(`вход с ${normalizeIp(req.socket.remoteAddress || '')} — выдан полный доступ`);
      res.setHeader('set-cookie',
        `${SESSION_COOKIE}=${this._makeSession()}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Strict`);
      return sendJson(res, 200, { ok: true, access: 'full' });
    }
    if (route === '/api/v1/logout') {
      res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
      return sendJson(res, 200, { ok: true, access: 'readonly' });
    }

    if (MUTATING.has(route) && access !== 'full') {
      return sendJson(res, 403, {
        error: 'readonly',
        message: this.app.config.hasWebPassword()
          ? 'нужен вход по паролю'
          : 'управление доступно только с компьютера, где запущено приложение',
      });
    }

    try {
      switch (route) {
        case '/api/v1/settings':
          return sendJson(res, 200, await this.app.applySettings(body));

        case '/api/v1/share': {
          const dto = await this.app.share.setShared(body.deviceId, Boolean(body.shared));
          this.app.onStateChanged();
          return sendJson(res, 200, dto);
        }
        case '/api/v1/purpose': {
          const r = this.app.share.setPurpose(body.deviceId, body.purpose);
          this.app.onStateChanged();
          return sendJson(res, 200, r);
        }
        case '/api/v1/group/save': {
          const g = this.app.share.saveGroup(body);
          this.app.onStateChanged();
          return sendJson(res, 200, g);
        }
        case '/api/v1/group/share': {
          const g = this.app.share.setGroupShared(body.groupId, Boolean(body.shared));
          this.app.onStateChanged();
          return sendJson(res, 200, g);
        }
        case '/api/v1/group/delete': {
          const r = this.app.share.deleteGroup(body.groupId);
          this.app.onStateChanged();
          return sendJson(res, 200, r);
        }
        case '/api/v1/force-release': {
          const r = await this.app.share.release(body.target, this.app.config.get('nodeId'), { force: true });
          this.app.onStateChanged();
          return sendJson(res, 200, r);
        }
        case '/api/v1/attach':
          return sendJson(res, 200, await this.app.attachTarget(body.nodeId, body.target, { force: Boolean(body.force) }));
        case '/api/v1/detach': {
          const r = await this.app.attach.detach(body.id);
          this.app.onStateChanged();
          return sendJson(res, 200, r);
        }
        case '/api/v1/request':
          return sendJson(res, 200, await this.app.requestTarget(body.nodeId, body.target, body.message));
        case '/api/v1/request/answer':
          return sendJson(res, 200, await this.app.answerRequest(body.requestId, Boolean(body.accept)));
        case '/api/v1/request/cancel': {
          const r = this.app.share.cancelRequest(body.requestId, this.app.config.get('nodeId'));
          this.app.onStateChanged();
          return sendJson(res, 200, r);
        }
        case '/api/v1/autostart':
          return sendJson(res, 200, await this.app.setAutostart(Boolean(body.enabled)));
        case '/api/v1/refresh':
          await this.app.refreshAll();
          return sendJson(res, 200, { ok: true });
        // ------------------------------------------------ сеть компьютера
        case '/api/v1/net/switch/create':
          return sendJson(res, 200, await this.app.netManager.createSwitch({
            name: body.name, nics: Array.isArray(body.nics) ? body.nics : [], hostAccess: body.hostAccess !== false,
          }));
        case '/api/v1/net/switch/delete':
          return sendJson(res, 200, await this.app.netManager.deleteSwitch(body.id));
        case '/api/v1/net/switch/rename':
          return sendJson(res, 200, await this.app.netManager.renameSwitch(body.id, body.name));
        case '/api/v1/net/switch/nic':
          return sendJson(res, 200, await this.app.netManager.setSwitchNic(body.id, body.guid, Boolean(body.add)));
        case '/api/v1/net/switch/host':
          return sendJson(res, 200, await this.app.netManager.setHostAccess(body.id, Boolean(body.enabled)));
        case '/api/v1/net/vnic/create':
          return sendJson(res, 200, await this.app.netManager.createVnic({
            name: body.name, switchId: body.switchId || null, mac: body.mac || null, ip: body.ip || null, category: body.category,
          }));
        case '/api/v1/net/vnic/delete':
          return sendJson(res, 200, await this.app.netManager.deleteVnic(body.guid));
        case '/api/v1/net/vnic/update': {
          const patch = {};
          for (const k of ['name', 'mac', 'switchId']) if (body[k] !== undefined) patch[k] = body[k];
          return sendJson(res, 200, await this.app.netManager.updateVnic(body.guid, patch));
        }
        case '/api/v1/net/adapter/ip':
          return sendJson(res, 200, await this.app.netManager.setAdapterIp(body.guid, body.ip, { category: body.category }));
        case '/api/v1/net/adapter/category':
          return sendJson(res, 200, await this.app.netManager.setAdapterCategory(body.guid, body.category));
        case '/api/v1/net/bridge/ip':
          return sendJson(res, 200, await this.app.netManager.setBridgeHostIp(Boolean(body.enabled)));
        case '/api/v1/net/held/ip':
          return sendJson(res, 200, await this.app.setHeldIp(body.attachmentId, body.deviceId, body.ip, { category: body.category }));

        case '/api/v1/install': {
          const r = await this.app.installer.start();
          this.pushState();
          return sendJson(res, 200, r);
        }
        default:
          return sendJson(res, 404, { error: 'not_found' });
      }
    } catch (e) {
      log.warn(`${route}: ${e.message}`);
      const status = e.code === 'busy' ? 409 : e.code === 'forbidden' ? 403 : e.code === 'not_found' ? 404 : 400;
      return sendJson(res, status, { error: e.code || 'failed', message: e.message, claim: e.claim || null });
    }
  }

  _sse(req, res, access) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(this.app.snapshot(access))}\n\n`);
    this.sseClients.set(res, access);

    const ka = setInterval(() => {
      try { res.write(': keep-alive\n\n'); } catch { /* закроется по 'close' */ }
    }, 20000);
    ka.unref?.();

    req.on('close', () => {
      clearInterval(ka);
      this.sseClients.delete(res);
    });
  }

  _serveStatic(res, route) {
    const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
    const target = path.resolve(UI_DIR, rel);
    if (!target.startsWith(path.resolve(UI_DIR))) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    fs.readFile(target, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'not_found' });
      res.writeHead(200, {
        'content-type': MIME[path.extname(target)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
  }
}

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || String(ip).startsWith('127.');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('тело запроса слишком велико'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
