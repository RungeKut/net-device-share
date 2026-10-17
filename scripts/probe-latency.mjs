// Задержка тракта USB/IP на мелких пакетах — без железа.
//
// USB/IP — это «запрос → ответ» маленькими пакетами, поэтому скорость
// прошивки (JTAG и подобное) определяется не пропускной способностью сети,
// а временем одного обмена. Скрипт поднимает фиктивный usbipd (эхо-сервер),
// пускает через него обмены «запрос-ответ» двумя путями и меряет время:
//   напрямую          — клиент → usbipd
//   через счётчик     — клиент → TrafficProxy → usbipd (как в приложении)
//
//   node scripts/probe-latency.mjs                 # текущий код
//   node scripts/probe-latency.mjs --legacy        # как было до исправления
//                                                  # (без TCP_NODELAY в счётчике)
//   node scripts/probe-latency.mjs --count 2000 --size 48
//   (по умолчанию запрос уходит двумя записями — заголовок 48 Б и данные,
//    как у USB/IP; --single посылает его одной записью)
//
// Через настоящую сеть, между двумя компьютерами (loopback Windows быстрый
// путь и задержек Нейгла не показывает):
//   на одном:   node scripts/probe-latency.mjs --serve [--legacy]
//   на другом:  node scripts/probe-latency.mjs --host <адрес первого>
//   Сервер слушает 47820 (эхо напрямую) и 47821 (то же через счётчик);
//   --serve-port N меняет базовый порт. На сервере может понадобиться
//   разрешить эти порты в брандмауэре. --legacy на сервере включает
//   старое поведение счётчика.
//
// Эхо-сервер здесь заменяет usbipd, а первый пакет — настоящий
// OP_REQ_IMPORT, чтобы счётчик опознал устройство, как при боевой работе.
// Размер запроса клиент сообщает в последних 4 байтах этого пакета.

import net from 'node:net';
import { TrafficProxy } from '../src/net/trafficProxy.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const legacy = args.includes('--legacy');
const SINGLE = args.includes('--single');
const HEADER = 48;
const COUNT = Number(opt('count', 1000));
const BASE_PORT = Number(opt('serve-port', 47820));
const SIZES = opt('size', null) ? [Number(opt('size'))] : [1, 48, 512];

const realSetNoDelay = net.Socket.prototype.setNoDelay;
if (legacy) {
  // Воспроизводим старое поведение счётчика: сокеты без TCP_NODELAY.
  // Свои сокеты теста включают его явно через realSetNoDelay.
  net.Socket.prototype.setNoDelay = function () { return this; };
}
const fast = (s) => { realSetNoDelay.call(s, true); return s; };

/** Заголовок OP_REQ_IMPORT: version, code=0x8003, status, busid[32]. */
function importPacket(size) {
  const b = Buffer.alloc(40);
  b.writeUInt32BE(size, 36);
  b.writeUInt16BE(0x0111, 0);
  b.writeUInt16BE(0x8003, 2);
  b.write('1-1', 8, 'ascii');
  return b;
}

const listen = (server, port, host = '127.0.0.1') => new Promise((res, rej) => {
  server.once('error', rej);
  server.listen(port, host, () => res(server.address().port));
});

async function pingPong(host, port, size) {
  const sock = fast(net.connect(port, host));
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });

  let need = 0;
  let wake = null;
  sock.on('data', (c) => {
    need -= c.length;
    if (need <= 0 && wake) { const w = wake; wake = null; w(); }
  });
  const exchange = (buf, split = false) => new Promise((res) => {
    need = buf.length;
    wake = res;
    if (split && buf.length > HEADER) {
      // Заголовок и данные — отдельными сегментами, как пишет драйвер USB/IP.
      sock.write(buf.subarray(0, HEADER));
      setImmediate(() => sock.write(buf.subarray(HEADER)));
    } else {
      sock.write(buf);
    }
  });

  await exchange(importPacket(size));                 // опознание устройства
  const payload = Buffer.alloc(HEADER + size, 0x55);
  const split = !SINGLE;
  for (let i = 0; i < 20; i++) await exchange(payload, split); // прогрев

  const times = [];
  for (let i = 0; i < COUNT; i++) {
    const t = process.hrtime.bigint();
    await exchange(payload, split);
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  sock.destroy();
  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    avg: sum / times.length,
    p50: times[Math.floor(times.length * 0.5)],
    p99: times[Math.floor(times.length * 0.99)],
    bytesPerSec: ((HEADER + size) * 2 * times.length) / (sum / 1000),
  };
}

const fmt = (r) =>
  `${r.avg.toFixed(3).padStart(8)} мс  p50 ${r.p50.toFixed(3).padStart(8)}  p99 ${r.p99.toFixed(3).padStart(8)}  ≈ ${Math.round(r.bytesPerSec).toLocaleString('ru')} Б/с`;

console.log(`режим счётчика: ${legacy ? 'СТАРЫЙ (без TCP_NODELAY)' : 'текущий код'}; обменов на размер: ${COUNT}\n`);

if (opt('host', null)) {
  const host = opt('host');
  console.log(`сервер: ${host}, порты ${BASE_PORT} (напрямую) и ${BASE_PORT + 1} (через счётчик)
`);
  for (const size of SIZES) {
    const direct = await pingPong(host, BASE_PORT, size);
    const viaProxy = await pingPong(host, BASE_PORT + 1, size);
    console.log(`${String(size).padStart(4)} Б`);
    console.log(`   напрямую      ${fmt(direct)}`);
    console.log(`   через счётчик ${fmt(viaProxy)}`);
  }
  process.exit(0);
}

// Фиктивный usbipd: возвращает всё, что получил.
// Отвечает, только когда получен запрос целиком (как настоящий usbipd).
const makeEcho = () => net.createServer((s) => {
  fast(s);
  let need = 40;                 // сначала OP_REQ_IMPORT
  let size = 0;
  let buf = Buffer.alloc(0);
  s.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= need) {
      if (!size) size = buf.readUInt32BE(36);   // размер запроса — от клиента
      s.write(Buffer.alloc(need, 0xaa));
      buf = buf.subarray(need);
      need = HEADER + size;
    }
  });
  s.on('error', () => {});
});

if (args.includes('--serve')) {
  const echo = makeEcho();
  await listen(echo, BASE_PORT, '0.0.0.0');
  const proxy = new TrafficProxy({ listenPort: BASE_PORT + 1, targetPort: BASE_PORT });
  await proxy.start();
  console.log(`эхо слушает ${BASE_PORT}, счётчик — ${BASE_PORT + 1}. Остановка — Ctrl+C.`);
  console.log('На другом компьютере: node scripts/probe-latency.mjs --host <адрес этого>');
  await new Promise(() => {});
}

for (const size of SIZES) {
  const echo = makeEcho();
  const echoPort = await listen(echo, 0);
  const proxy = new TrafficProxy({ listenPort: 0, targetPort: echoPort });
  const tmp = net.createServer();
  const freePort = await listen(tmp, 0);
  await new Promise((r) => tmp.close(r));
  proxy.listenPort = freePort;
  await proxy.start();
  const direct = await pingPong('127.0.0.1', echoPort, size);
  const viaProxy = await pingPong('127.0.0.1', freePort, size);
  console.log(`${String(size).padStart(4)} Б`);
  console.log(`   напрямую      ${fmt(direct)}`);
  console.log(`   через счётчик ${fmt(viaProxy)}`);
  await proxy.stop();
  echo.close();
}
process.exit(0);
