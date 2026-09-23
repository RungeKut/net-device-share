// Посредник TAP, который держится поднятым: открывается с повторами и
// поднимается заново, если упал. Им пользуются и проброс карт, и
// коммутаторы — у тех и у других адаптер должен жить, пока он нужен.
//
// Сам по себе посредник падает, только если адаптер пропал, его отключили
// руками или перезапустили (смена MAC, переустановка драйвера). Бывает и
// случайность — тогда повтор помогает.

import { EventEmitter } from 'node:events';
import { TapRelay } from './tapRelay.js';
import { logger } from '../log.js';

const log = logger('tap');

/** Сколько раз подряд поднимать упавшего посредника, прежде чем сдаться. */
const MAX_RELAY_RESTARTS = 5;

/**
 * Открыть адаптер с повторами.
 *
 * Только что созданный или перезапущенный адаптер открывается не сразу:
 * драйвер ещё поднимает устройство, и первая попытка отвечает «не найден».
 * Через секунду-другую открывается. Сколько ждать — зависит от машины,
 * поэтому несколько попыток, а не одна пауза наугад.
 */
export async function openRelay(guid, label, attempts = 5) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    const relay = new TapRelay(guid);
    try {
      await relay.start();
      if (i > 1) log.info(`${label}: адаптер открылся с ${i}-й попытки`);
      return relay;
    } catch (e) {
      last = e;
      log.debug(`${label}: адаптер не открылся (${e.message}), попытка ${i} из ${attempts}`);
      await relay.stop().catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`${label}: адаптер не открылся за ${attempts} попыток — ${last?.message}`);
}

/**
 * Поднять посредника и держать его поднятым.
 *
 * @param {{ stopped?: boolean, relay?: object, restarts?: number, failed?: string|null }} holder —
 *   запись владельца посредника; stopped = true прекращает подъём
 * @param {string} guid
 * @param {string} label — как называть в журнале
 * @param {(relay: TapRelay) => void} onRelay — вызывается при каждом (пере)запуске
 * @param {(why: string) => void} [onGiveUp] — посредник падает раз за разом
 */
export async function keepRelay(holder, guid, label, onRelay, onGiveUp = () => {}) {
  const relay = await openRelay(guid, label);
  if (holder.stopped) { await relay.stop(); return relay; }
  relay.once('closed', (why) => {
    if (holder.stopped) return;
    holder.restarts = (holder.restarts || 0) + 1;
    if (holder.restarts > MAX_RELAY_RESTARTS) {
      log.error(`${label}: посредник падает раз за разом (${why}) — остановлен`);
      holder.failed = why;
      onGiveUp(why);
      return;
    }
    log.warn(`${label}: посредник упал (${why}) — поднимаем заново`);
    setTimeout(() => {
      if (holder.stopped) return;
      keepRelay(holder, guid, label, onRelay, onGiveUp)
        .catch((e) => { holder.failed = e.message; log.error(`${label}: посредник не поднялся: ${e.message}`); onGiveUp(e.message); });
    }, 1000);
  });
  holder.relay = relay;
  holder.failed = null;
  onRelay(relay);
  // Проработал минуту — счёт падений начинается заново.
  setTimeout(() => { if (holder.relay === relay) holder.restarts = 0; }, 60000).unref?.();
  return relay;
}

/**
 * Включить посредника портом в программный коммутатор.
 *
 * Посредник отдаёт кадры «получателю» с методом write; коммутатор сам решает,
 * куда их деть, и никогда не просит подождать — отстающий порт у него
 * теряет кадры, а не тормозит остальных.
 *
 * @param {import('./vswitch.js').VSwitch} sw
 * @param {string} portId
 * @param {TapRelay} relay
 * @param {string} label
 */
export function plugRelay(sw, portId, relay, label) {
  const handle = sw.attach(portId, {
    send: (frames) => relay.writeFrames(frames),
    backlog: () => relay.backlog(),
    label,
  });
  const sink = new EventEmitter();
  sink.write = (frames) => { handle.input(frames); return true; };
  relay.setSink(sink);
  return handle;
}
