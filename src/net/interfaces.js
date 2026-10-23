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
    // а не в туннель провайдера. Виртуальные адаптеры (VMware, Hyper-V, наш
    // же TAP чужой карты) берутся, только если настоящих нет: адрес TAP чужой
    // карты — это адрес в чужой сети, часто совпадающий с адресом самого
    // владельца, и узел, объявивший его, недостижим для соседей.
    const priv = nets.filter((n) => isPrivate(n.address));
    const real = priv.filter((n) => !isVirtualInterface(n));
    return real[0] || priv[0] || nets.find((n) => !isVirtualInterface(n)) || nets[0];
  }
  return nets.find((n) => n.cidr === cidr)
      || nets.find((n) => ipInCidr(n.address, cidr))
      || null;
}

/** Имена и MAC-префиксы виртуальных адаптеров, которые не годятся в рабочую сеть. */
const VIRTUAL_NAME = /vEthernet|VMware|VirtualBox|Hyper-V|Bluetooth|TAP|OpenVPN|WireGuard|Tailscale|ZeroTier|Docker|WSL|Loopback| на /i;
const VIRTUAL_MAC = /^(00:ff|00:50:56|00:0c:29|00:15:5d|08:00:27|0a:00:27)/i;

export function isVirtualInterface({ iface, mac }) {
  return VIRTUAL_NAME.test(iface || '') || VIRTUAL_MAC.test(mac || '');
}

/**
 * Сети, в которых узел работает.
 *
 * Явный CIDR — одна эта сеть, как и раньше. Автовыбор — все настоящие
 * интерфейсы с адресом (кроме link-local): узел объявляется в каждой, и соседи
 * находятся там, где они есть, а не только в сети «первой карты». Две карты
 * в одной подсети дают одну сеть. Если настоящих нет, берём то, что выберет
 * resolveNetwork, — лучше хоть какая-то сеть, чем никакой.
 *
 * @returns {object[]} первый элемент — основная сеть (её адрес узел показывает о себе)
 */
export function resolveNetworks(cidr, { exclude = [], nets = listNetworks() } = {}) {
  if (cidr && cidr !== 'auto') {
    const one = resolveNetwork(cidr);
    return one ? [one] : [];
  }
  const seen = new Set();
  const skip = new Set(exclude);
  // Не только частные адреса: прямой кабель между двумя компьютерами часто
  // настраивают на любой подсети (200.100.1.0/24), и без неё узел с этой
  // картой не стал бы шлюзом. Автоадрес 169.254 в сеть не берём — это «DHCP не ответил».
  const real = nets
    .filter((n) => !skip.has(n.iface))
    .filter((n) => !isLinkLocal(n.address) && !isVirtualInterface(n))
    .filter((n) => !seen.has(n.cidr) && seen.add(n.cidr))
    // Основной остаётся частная сеть: её адрес узел показывает о себе (sort стабилен).
    .sort((a, b) => Number(isPrivate(b.address)) - Number(isPrivate(a.address)));
  if (real.length) return real;
  // Исключённые карты не возвращаются и запасным путём: иначе исключение было бы пустым.
  const one = resolveNetwork('auto');
  return one && !skip.has(one.iface) ? [one] : [];
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

export function isLinkLocal(ip) {
  return ipInCidr(ip, '169.254.0.0/16') && ipToInt(ip) !== null;
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
