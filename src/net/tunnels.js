// Туннели TCP на шлюзе: узел, стоящий в двух сетях, пропускает соединение
// из одной в другую.
//
// Нужен тогда, когда между сетями нет маршрута: узлы друг друга видят (шлюз
// пересказал каталог), а до портов дотянуться нельзя. Клиент просит шлюз
// открыть порт, который ведёт на нужный порт нужного узла, и соединяется с
// шлюзом, как с владельцем. Для владельца источник — адрес шлюза, то есть
// свой сосед по подсети, поэтому ни его проверки адреса, ни канал сетевой
// карты ничего не замечают.
//
// ЧТО ТУННЕЛЬ НЕ ДЕЛАЕТ. Это не прокси «куда угодно»: что открывать, решает
// вызывающий код (httpServer), проверяя узел, адрес и порт по каталогу, а
// каждый туннель пускает только того, кто его запросил, — по адресу.

import net from 'node:net';
import { logger } from '../log.js';

const log = logger('tunnel');

const normalize = (ip) => String(ip || '').replace(/^::ffff:/, '');

export class TunnelServer {
  /**
   * @param {{ maxTunnels?: number, idleMs?: number, host?: string }} [o]
   */
  constructor({ maxTunnels = 64, idleMs = 15 * 60 * 1000, host = '0.0.0.0' } = {}) {
    this.maxTunnels = maxTunnels;
    this.idleMs = idleMs;
    this.host = host;
    /** @type {Map<string, object>} ключ → туннель */
    this.tunnels = new Map();
    this.sweepTimer = setInterval(() => this._sweep(), 30000);
    this.sweepTimer.unref?.();
  }

  /**
   * Открыть (или вспомнить) туннель.
   *
   * @param {{ targetHost: string, targetPort: number, allowAddress: string }} o
   * @returns {Promise<number>} порт на этом компьютере
   */
  async open({ targetHost, targetPort, allowAddress }) {
    const allow = normalize(allowAddress);
    const key = `${allow}>${targetHost}:${targetPort}`;
    const have = this.tunnels.get(key);
    if (have) {
      have.lastUsed = Date.now();
      return have.port;
    }
    if (this.tunnels.size >= this.maxTunnels) {
      this._sweep(true);
      if (this.tunnels.size >= this.maxTunnels) throw new Error('слишком много открытых туннелей');
    }

    const t = { key, targetHost, targetPort, allow, port: 0, server: null, sockets: new Set(), lastUsed: Date.now() };
    t.server = net.createServer((client) => this._accept(t, client));
    t.server.on('error', (e) => log.warn(`туннель ${key}: ${e.message}`));
    await new Promise((resolve, reject) => {
      t.server.once('error', reject);
      t.server.listen(0, this.host, () => { t.server.removeListener('error', reject); resolve(); });
    });
    t.port = t.server.address().port;
    this.tunnels.set(key, t);
    log.info(`туннель ${allow} → ${targetHost}:${targetPort} на порту ${t.port}`);
    return t.port;
  }

  _accept(t, client) {
    if (normalize(client.remoteAddress) !== t.allow) {
      log.warn(`туннель ${t.key}: отказ ${client.remoteAddress} — туннель открыт для ${t.allow}`);
      client.destroy();
      return;
    }
    t.lastUsed = Date.now();
    const upstream = net.connect({ host: t.targetHost, port: t.targetPort });
    t.sockets.add(client);
    t.sockets.add(upstream);
    const end = () => {
      t.sockets.delete(client);
      t.sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
      t.lastUsed = Date.now();
    };
    client.on('error', end);
    upstream.on('error', end);
    client.on('close', end);
    upstream.on('close', end);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.pipe(upstream);
    upstream.pipe(client);
  }

  _sweep(force = false) {
    const now = Date.now();
    for (const t of [...this.tunnels.values()]) {
      if (t.sockets.size) { t.lastUsed = now; continue; }
      if (force ? now - t.lastUsed > 60000 : now - t.lastUsed > this.idleMs) this._close(t);
    }
  }

  _close(t) {
    this.tunnels.delete(t.key);
    for (const s of t.sockets) s.destroy();
    t.server.close();
    log.info(`туннель ${t.key} закрыт`);
  }

  list() {
    return [...this.tunnels.values()].map((t) => ({
      port: t.port, from: t.allow, to: `${t.targetHost}:${t.targetPort}`, connections: t.sockets.size / 2,
    }));
  }

  async stop() {
    clearInterval(this.sweepTimer);
    for (const t of [...this.tunnels.values()]) this._close(t);
  }
}
