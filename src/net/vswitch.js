// Программный коммутатор второго уровня: кадры между портами по MAC-адресу.
//
// Зачем он, если есть мост Windows. Мост на компьютере один, и в нём у
// самого компьютера ровно один интерфейс — адаптер моста с одним MAC.
// Виртуальных адаптеров с собственными MAC и адресами, как у коммутатора
// Hyper-V, мост не даёт: TAP, включённый в мост, теряет свой стек IP.
// Поэтому коммутатор собран здесь: каждый виртуальный адаптер — TAP со своим
// стеком IP, а кадры между ними пересылает этот объект. Выход в физическую
// сеть — ещё один TAP («аплинк»), включённый в мост Windows вместе с картой.
//
// Устроен как обычный обучающийся коммутатор: запоминает, за каким портом
// какой MAC-источник, одноадресные кадры шлёт туда, остальные — во все
// порты, кроме входного. Кадры не разбираются глубже заголовка Ethernet.
//
// ФОРМАТ тот же, что у посредника TAP: длина кадра двумя байтами (старший
// первый), затем кадр. Поток приходит уже нарезанным на целые кадры.
//
// НАПОР. Медленный порт не должен тормозить остальные, поэтому коммутатор
// не ждёт отстающих: у порта с полной очередью кадры отбрасываются и
// считаются. Так же поступает настоящий коммутатор.

import { EventEmitter } from 'node:events';

/** Сколько помнить MAC без кадров от него — как у типичного коммутатора. */
const AGE_MS = 300000;

/** Очередь порта, после которой кадры для него отбрасываются. */
const PORT_BACKLOG_LIMIT = 1024 * 1024;

const macKey = (buf, at) => buf.toString('hex', at, at + 6);

export class VSwitch extends EventEmitter {
  /** @param {{ id: string, name?: string, ageMs?: number }} o */
  constructor({ id, name = '', ageMs = AGE_MS }) {
    super();
    this.id = id;
    this.name = name;
    this.ageMs = ageMs;
    /** @type {Map<string, object>} id порта → порт */
    this.ports = new Map();
    /** @type {Map<string, { port: string, seen: number }>} MAC → где видели */
    this.macs = new Map();
    this.floods = 0;
  }

  /**
   * Подключить порт.
   *
   * @param {string} id
   * @param {object} o
   * @param {(frames: Buffer) => void} o.send — отдать порту кадры (формат «длина + кадр»)
   * @param {() => number} [o.backlog] — сколько байт ждут отправки в порту
   * @param {string} [o.label]
   * @returns {{ input: (frames: Buffer) => void, detach: () => void }}
   */
  attach(id, { send, backlog = () => 0, label = id }) {
    this.detach(id);
    const port = { id, send, backlog, label, rx: 0, tx: 0, drops: 0 };
    this.ports.set(id, port);
    return {
      input: (frames) => this._input(port, frames),
      detach: () => this.detach(id),
    };
  }

  detach(id) {
    if (!this.ports.delete(id)) return;
    for (const [mac, at] of this.macs) if (at.port === id) this.macs.delete(mac);
  }

  /**
   * Кадры, пришедшие в порт. Каждый уходит туда, где живёт получатель,
   * или во все порты, если получатель неизвестен или это рассылка.
   */
  _input(port, frames) {
    const now = Date.now();
    /** @type {Map<object, Buffer[]>} порт → кадры для него */
    const out = new Map();
    const push = (p, chunk) => {
      const list = out.get(p);
      if (list) list.push(chunk); else out.set(p, [chunk]);
    };

    for (let i = 0; i + 2 <= frames.length;) {
      const len = frames.readUInt16BE(i);
      const end = i + 2 + len;
      if (len < 14 || end > frames.length) break; // обрывок — дальше читать нечего
      const chunk = frames.subarray(i, end);
      const f = i + 2;
      port.rx += len;

      // Источник: групповой MAC источником не бывает — такие не запоминаем.
      if ((frames[f + 6] & 1) === 0) this.macs.set(macKey(frames, f + 6), { port: port.id, seen: now });

      const group = (frames[f] & 1) === 1;
      const known = group ? null : this.macs.get(macKey(frames, f));
      if (known && now - known.seen < this.ageMs) {
        const target = this.ports.get(known.port);
        if (target && target !== port) push(target, chunk);
      } else {
        if (!group) this.floods++;
        for (const p of this.ports.values()) if (p !== port) push(p, chunk);
      }
      i = end;
    }

    for (const [p, chunks] of out) {
      const size = chunks.reduce((a, c) => a + c.length, 0);
      if (p.backlog() > PORT_BACKLOG_LIMIT) { p.drops += chunks.length; continue; }
      p.tx += size;
      try {
        p.send(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size));
      } catch {
        p.drops += chunks.length;
      }
    }
  }

  /**
   * Послать кадр «от имени» порта: например, объявление адреса (ARP) от
   * виртуального адаптера, которое сама Windows не рассылает.
   */
  inject(fromPortId, frame) {
    const port = this.ports.get(fromPortId);
    if (!port) return;
    const buf = Buffer.allocUnsafe(2 + frame.length);
    buf.writeUInt16BE(frame.length, 0);
    frame.copy(buf, 2);
    this._input(port, buf);
  }

  stats() {
    const now = Date.now();
    return {
      id: this.id,
      ports: [...this.ports.values()].map((p) => ({ id: p.id, label: p.label, rx: p.rx, tx: p.tx, drops: p.drops })),
      macs: [...this.macs.values()].filter((m) => now - m.seen < this.ageMs).length,
      floods: this.floods,
    };
  }
}

/**
 * Объявление адреса (gratuitous ARP): «адрес ip — у MAC mac».
 *
 * Windows, назначив адрес, в сеть его не объявляет (проверено на стенде:
 * ни одного ARP). Устройство, которое помнит этот адрес за другим MAC —
 * например, за картой владельца, — будет слать кадры туда, пока запись не
 * устареет, а у приборов это бывает и двадцать минут. Объявление
 * переписывает запись сразу.
 *
 * @param {Buffer} mac — 6 байт
 * @param {string} ip — IPv4 строкой
 */
export function garpFrame(mac, ip) {
  const addr = Buffer.from(String(ip).split('.').map(Number));
  const f = Buffer.alloc(60);
  f.fill(0xff, 0, 6);
  mac.copy(f, 6);
  f.writeUInt16BE(0x0806, 12);
  f.writeUInt16BE(1, 14);        // Ethernet
  f.writeUInt16BE(0x0800, 16);   // IPv4
  f[18] = 6; f[19] = 4;
  f.writeUInt16BE(1, 20);        // запрос: его принимают все, ответ — не все
  mac.copy(f, 22); addr.copy(f, 28);
  addr.copy(f, 38);              // спрашиваем про самих себя
  return f;
}

/** MAC строкой любого вида → 6 байт, либо null. */
export function macBytes(text) {
  const hex = String(text || '').replace(/[^0-9a-f]/gi, '');
  return hex.length === 12 ? Buffer.from(hex, 'hex') : null;
}
