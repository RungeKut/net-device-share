// Байтовый режим канала: пакеты COM-порта поверх того же TCP, что несёт
// кадры L2 сетевых карт (см. tapLink.js). Один порт на все занятия —
// приветствие различает режим: «NDL1» у кадров, «NDS1» у байтов порта.
//
// Дальше каждый пакет — [u16 длина][u8 тип][данные]; длина считается вместе
// с байтом типа.
//
// Типы пакетов:
//   клиент → владелец: DATA — байты в порт; PARAMS — скорость, чётность,
//     биты (u32 + 3 байта); CTRL — линии RTS/DTR (биты); BREAK — Break
//     на мс (u16).
//   владелец → клиенту: DATA — байты из порта; MSR — линии CTS/DSR/DCD;
//     PARAMS_RESULT — применились ли параметры; ERROR — что случилось.
//
// Параметры порта кодируются одинаково и в канале, и во внутреннем протоколе
// насоса (см. core/serialShare.js): u32 скорость, u8 чётность (0 нет, 1 нечёт,
// 2 чёт, 3 mark, 4 space), u8 биты данных, u8 стоповые (0 один, 1 полтора,
// 2 два). Значения чётности повторяют константы Win32, у стоповых своя
// нумерация — короче, чем в DCB.
//
// Пакеты не шифруются — как и кадры L2 и данные USB/IP; для недоверенной
// среды нужен туннель поверх.

export const PKT = {
  DATA: 1,
  PARAMS: 2,
  CTRL: 3,
  BREAK: 4,
  MSR: 5,
  PARAMS_RESULT: 6,
  ERROR: 7,
};

/** CTRL: какую линию выставить. */
export const CTRL_RTS_ON = 1;
export const CTRL_RTS_OFF = 2;
export const CTRL_DTR_ON = 4;
export const CTRL_DTR_OFF = 8;

/** MSR: состояния входов. RI не несём: SerialPort его уровня не отдаёт. */
export const MSR_CTS = 0x10;
export const MSR_DSR = 0x20;
export const MSR_DCD = 0x80;

/** Пакет для потока: [u16 длина][u8 тип][данные]. */
export function packetFrame(type, payload = Buffer.alloc(0)) {
  const buf = Buffer.allocUnsafe(3 + payload.length);
  buf.writeUInt16BE(payload.length + 1, 0);
  buf[2] = type;
  payload.copy(buf, 3);
  return buf;
}

/**
 * Резка потока на пакеты. В отличие от FrameCutter пакеты разбираются на
 * тип и данные: байтов порта немного, и решать, что с ними делать, можно
 * не в горячем пути передачи.
 */
export class PacketCutter {
  constructor() {
    this.tail = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk
   * @returns {{ type: number, payload: Buffer }[]}
   * @throws если в потоке пакет нулевой длины — дальше его читать нельзя
   */
  push(chunk) {
    const buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    const out = [];
    let end = 0;
    while (buf.length - end >= 2) {
      const len = buf.readUInt16BE(end);
      if (len === 0) {
        this.tail = Buffer.alloc(0);
        throw new Error('пакет нулевой длины');
      }
      if (buf.length - end < 2 + len) break;
      out.push({ type: buf[end + 2], payload: buf.subarray(end + 3, end + 2 + len) });
      end += 2 + len;
    }
    this.tail = end < buf.length ? Buffer.from(buf.subarray(end)) : Buffer.alloc(0);
    return out;
  }
}

/** u32 скорость + u8 чётность + u8 биты данных + u8 стоповые. */
export function encodePortParams(p) {
  const b = Buffer.alloc(7);
  b.writeUInt32BE(Math.max(0, Math.min(0xffffffff, Number(p.baud) || 0)), 0);
  b[4] = Number(p.parity) || 0;
  b[5] = Number(p.dataBits) || 8;
  b[6] = Number(p.stopBits) || 0;
  return b;
}

export function parsePortParams(b) {
  if (!b || b.length < 7) throw new Error('пакет параметров короче семи байт');
  return { baud: b.readUInt32BE(0), parity: b[4], dataBits: b[5], stopBits: b[6] };
}
