// Работа с сетевыми интерфейсами и CIDR: приложение работает строго в одной
// выбранной пользователем сети, всё вне неё игнорируется.

import os from 'node:os';

/** Список пригодных IPv4-интерфейсов с посчитанным CIDR подсети. */
export function listNetworks() {
  const out = [];
  const ifaces = os.networkInterfaces();

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const prefix = maskToPrefix(a.netmask);
      if (prefix === null) continue;
      out.push({
        iface: name,
        address: a.address,
        netmask: a.netmask,
        prefix,
        cidr: `${networkAddress(a.address, prefix)}/${prefix}`,
        mac: a.mac,
      });
    }
  }
  return out;
}

/**
 * Выбирает интерфейс под заданный CIDR.
 * @param {string|null} cidr — например "192.168.1.0/24"; null → автовыбор.
 */
export function resolveNetwork(cidr) {
  const nets = listNetworks();
  if (!nets.length) return null;

  if (!cidr || cidr === 'auto') {
    // Приоритет приватным диапазонам — так автовыбор попадает в LAN,
    // а не в туннель провайдера или адрес виртуального адаптера.
    const priv = nets.filter((n) => isPrivate(n.address));
    return (priv[0] || nets[0]);
  }
  return nets.find((n) => n.cidr === cidr)
      || nets.find((n) => ipInCidr(n.address, cidr))
      || null;
}

export function maskToPrefix(mask) {
  const parts = String(mask).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return null;
  let bits = 0;
  let seenZero = false;
  for (const p of parts) {
    for (let i = 7; i >= 0; i--) {
      if ((p >> i) & 1) {
        if (seenZero) return null; // немонотонная маска
        bits++;
      } else {
        seenZero = true;
      }
    }
  }
  return bits;
}

export function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function networkAddress(ip, prefix) {
  const n = ipToInt(ip);
  if (n === null) return ip;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return intToIp((n & mask) >>> 0);
}

export function broadcastAddress(ip, prefix) {
  const n = ipToInt(ip);
  if (n === null) return '255.255.255.255';
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return intToIp(((n & mask) | (~mask >>> 0)) >>> 0);
}

/** Принадлежит ли адрес подсети. Пустой cidr → true (фильтр выключен). */
export function ipInCidr(ip, cidr) {
  if (!cidr || cidr === 'auto') return true;
  const [base, prefixStr] = String(cidr).split('/');
  const prefix = Number(prefixStr);
  const a = ipToInt(normalizeIp(ip));
  const b = ipToInt(base);
  if (a === null || b === null || !Number.isInteger(prefix)) return false;
  if (prefix <= 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** ::ffff:192.168.1.5 → 192.168.1.5 (Node отдаёт такие адреса на dual-stack сокетах). */
export function normalizeIp(ip) {
  if (typeof ip !== 'string') return ip;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function isPrivate(ip) {
  const n = ipToInt(ip);
  if (n === null) return false;
  return (
    ipInCidr(ip, '10.0.0.0/8') ||
    ipInCidr(ip, '172.16.0.0/12') ||
    ipInCidr(ip, '192.168.0.0/16')
  );
}
