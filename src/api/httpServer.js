// HTTP-сервер: он же интерфейс пользователя, он же транспорт RPC между узлами.
//
// Порт один, но доступ разный:
//   /api/v1/peer/*  — вызовы других узлов: проверяются подпись и принадлежность
//                     к рабочей сети;
//   всё остальное   — UI и управление: принимается только с локального адреса,
//                     чтобы сосед по сети не мог менять настройки этого узла.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, recentLogs, onLogRecord } from '../log.js';
import { verify } from '../net/protocol.js';
import { AUTH_HEADER, NODE_HEADER } from '../net/rpc.js';
import { ipInCidr, normalizeIp, listNetworks } from '../net/interfaces.js';

const log = logger('http');
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

export class ApiServer {
  /** @param {object} app — объект приложения (см. core/app.js) */
  constructor(app) {
    this.app = app;
    this.server = null;
    this.sseClients = new Set();
    this.pushTimer = null;
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
      // Слушаем все интерфейсы: сюда стучатся соседние узлы.
      // Разграничение доступа — на уровне маршрутов, не сокета.
      this.server.listen(this.app.config.get('apiPort'), '0.0.0.0', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });

    onLogRecord((rec) => this._broadcast('log', rec));
    log.info(`HTTP API на порту ${this.app.config.get('apiPort')}; интерфейс: http://${this.app.config.get('uiHost')}:${this.app.config.get('apiPort')}/`);
    return this;
  }

  async stop() {
    for (const res of this.sseClients) {
      try { res.end(); } catch { /* клиент уже отвалился */ }
    }
    this.sseClients.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  /** Рассылка обновлений в UI. Склеиваем всплески, чтобы не залить SSE. */
  pushState() {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this._broadcast('state', this.app.snapshot());
    }, 150);
    this.pushTimer.unref?.();
  }

  _broadcast(event, data) {
    if (!this.sseClients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const remote = normalizeIp(req.socket.remoteAddress || '');

    if (route.startsWith('/api/v1/peer/')) {
      return this._handlePeer(req, res, route, remote);
    }
    if (!isLoopback(remote)) {
      log.warn(`отклонён запрос к ${route} с внешнего адреса ${remote}`);
      return sendJson(res, 403, { error: 'forbidden', message: 'управление доступно только с этого компьютера' });
    }
    if (route.startsWith('/api/')) {
      return this._handleUiApi(req, res, route, url);
    }
    return this._serveStatic(res, route);
  }

  // ---------------------------------------------------------------- RPC узлов

  async _handlePeer(req, res, route, remote) {
    const cidr = this.app.network?.cidr;
    if (cidr && !ipInCidr(remote, cidr) && !isLoopback(remote)) {
      log.warn(`отклонён вызов ${route} вне рабочей сети (${remote})`);
      return sendJson(res, 403, { error: 'out_of_network', message: 'адрес вне рабочей сети' });
    }

    const raw = await readBody(req);
    const key = this.app.config.get('preSharedKey');
    if (!verify(raw, req.headers[AUTH_HEADER] || '', key)) {
      log.warn(`отклонён вызов ${route} с неверной подписью (${remote})`);
      return sendJson(res, 401, { error: 'bad_signature', message: 'неверная подпись — не совпадает общий ключ' });
    }

    const body = parseJson(raw);
    const callerId = req.headers[NODE_HEADER] || body?.holderId || null;

    switch (`${req.method} ${route}`) {
      case 'GET /api/v1/peer/ping':
        return sendJson(res, 200, { ok: true, nodeId: this.app.config.get('nodeId'), name: this.app.config.get('name') });

      case 'GET /api/v1/peer/state':
        return sendJson(res, 200, {
          nodeId: this.app.config.get('nodeId'),
          name: this.app.config.get('name'),
          version: this.app.version,
          startedAt: this.app.startedAt,
          platform: process.platform,
          usbipPort: this.app.config.get('usbipPort'),
          apiPort: this.app.config.get('apiPort'),
          stateHash: this.app.share.hash(),
          devices: this.app.share.listShared(),
        });

      case 'POST /api/v1/peer/claim': {
        if (!body?.busid || !callerId) return sendJson(res, 400, { error: 'bad_request', message: 'нужны busid и holderId' });
        try {
          const result = await this.app.share.claim(body.busid, {
            holderId: callerId,
            holderName: body.holderName || callerId.slice(0, 8),
          });
          this.app.onStateChanged();
          return sendJson(res, 200, result);
        } catch (e) {
          const status = e.code === 'busy' ? 409 : e.code === 'device_not_found' ? 404 : 400;
          return sendJson(res, status, { error: e.code || 'claim_failed', message: e.message, claim: e.claim || null });
        }
      }

      case 'POST /api/v1/peer/release': {
        if (!body?.busid || !callerId) return sendJson(res, 400, { error: 'bad_request', message: 'нужны busid и holderId' });
        try {
          const result = await this.app.share.release(body.busid, callerId);
          this.app.onStateChanged();
          return sendJson(res, 200, result);
        } catch (e) {
          return sendJson(res, 403, { error: e.code || 'release_failed', message: e.message });
        }
      }

      case 'POST /api/v1/peer/heartbeat': {
        if (!body?.busid || !callerId) return sendJson(res, 400, { error: 'bad_request', message: 'нужны busid и holderId' });
        try {
          return sendJson(res, 200, this.app.share.renew(body.busid, callerId));
        } catch (e) {
          return sendJson(res, 409, { error: e.code || 'renew_failed', message: e.message });
        }
      }

      default:
        return sendJson(res, 404, { error: 'not_found' });
    }
  }

  // ------------------------------------------------------------------- UI API

  async _handleUiApi(req, res, route, url) {
    if (req.method === 'GET' && route === '/api/v1/events') {
      return this._sse(req, res);
    }
    if (req.method === 'GET' && route === '/api/v1/state') {
      return sendJson(res, 200, this.app.snapshot());
    }
    if (req.method === 'GET' && route === '/api/v1/logs') {
      return sendJson(res, 200, { records: recentLogs(Number(url.searchParams.get('limit')) || 200) });
    }
    if (req.method === 'GET' && route === '/api/v1/networks') {
      return sendJson(res, 200, { networks: listNetworks(), current: this.app.network });
    }

    if (req.method !== 'POST') return sendJson(res, 404, { error: 'not_found' });

    const body = parseJson(await readBody(req)) || {};

    try {
      switch (route) {
        case '/api/v1/settings': {
          const result = await this.app.applySettings(body);
          return sendJson(res, 200, result);
        }
        case '/api/v1/share': {
          const dto = await this.app.share.setShared(body.busid, Boolean(body.shared));
          this.app.onStateChanged();
          return sendJson(res, 200, dto);
        }
        case '/api/v1/note': {
          this.app.share.setNote(body.busid, body.note);
          this.app.onStateChanged();
          return sendJson(res, 200, { ok: true });
        }
        case '/api/v1/force-release': {
          const r = await this.app.share.release(body.busid, this.app.config.get('nodeId'), { force: true });
          this.app.onStateChanged();
          return sendJson(res, 200, r);
        }
        case '/api/v1/attach': {
          const r = await this.app.attachDevice(body.nodeId, body.busid);
          return sendJson(res, 200, r);
        }
        case '/api/v1/detach': {
          const r = await this.app.attach.detach(body.id);
          this.app.onStateChanged();
          return sendJson(res, 200, r);
        }
        case '/api/v1/refresh': {
          await this.app.refreshAll();
          return sendJson(res, 200, { ok: true });
        }
        case '/api/v1/install': {
          // Установка идёт фоном и может занять до минуты: отвечаем сразу,
          // а ход дела UI видит в снимке состояния.
          const r = await this.app.installer.start();
          this.pushState();
          return sendJson(res, 200, r);
        }
        default:
          return sendJson(res, 404, { error: 'not_found' });
      }
    } catch (e) {
      log.warn(`${route}: ${e.message}`);
      return sendJson(res, 400, { error: e.code || 'failed', message: e.message });
    }
  }

  _sse(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 2000\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(this.app.snapshot())}\n\n`);
    this.sseClients.add(res);

    // Периодический комментарий не даёт прокси и самому Node закрыть
    // простаивающее соединение.
    const ka = setInterval(() => {
      try { res.write(': keep-alive\n\n'); } catch { /* закроется по 'close' */ }
    }, 20000);
    ka.unref?.();

    req.on('close', () => {
      clearInterval(ka);
      this.sseClients.delete(res);
    });
  }

  // ------------------------------------------------------------------ статика

  _serveStatic(res, route) {
    const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
    // Защита от выхода за пределы каталога UI.
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
