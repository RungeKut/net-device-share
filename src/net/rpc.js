// HTTP-клиент для вызовов между узлами. Без зависимостей, с той же
// HMAC-подписью, что и у UDP-канала, и с обязательным таймаутом:
// зависший узел не должен блокировать работу всей сети.

import http from 'node:http';
import { sign } from './protocol.js';

export const AUTH_HEADER = 'x-nds-auth';
export const NODE_HEADER = 'x-nds-node';

export class RpcError extends Error {
  constructor(message, { status = 0, code = 'rpc_error', body = null } = {}) {
    super(message);
    this.name = 'RpcError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * @param {object} o
 * @param {string} o.host  адрес узла
 * @param {number} o.port  порт HTTP API узла
 * @param {string} o.path
 * @param {'GET'|'POST'} [o.method]
 * @param {object} [o.body]
 * @param {string} [o.key]      общий ключ (может быть пустым)
 * @param {string} [o.nodeId]   кто звонит
 * @param {number} [o.timeoutMs]
 */
export function rpc({ host, port, path, method = 'GET', body = null, key = '', nodeId = '', timeoutMs = 5000 }) {
  const payload = body === null ? '' : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          [AUTH_HEADER]: sign(payload, key),
          [NODE_HEADER]: nodeId,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = { raw: text };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new RpcError(parsed?.message || `HTTP ${res.statusCode}`, {
              status: res.statusCode,
              code: parsed?.error || 'http_error',
              body: parsed,
            }));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new RpcError(`нет ответа от ${host}:${port} за ${timeoutMs} мс`, { code: 'timeout' }));
    });
    req.on('error', (err) => {
      reject(err instanceof RpcError ? err : new RpcError(err.message, { code: 'network' }));
    });

    if (payload) req.write(payload);
    req.end();
  });
}
