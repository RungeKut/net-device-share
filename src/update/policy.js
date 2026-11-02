// Когда обновлению можно перезапускать узел.
//
// Перезапуск не бесплатен: занятость живёт в памяти, поэтому владельцу он
// стоит чужих аренд (держатели отцепятся по heartbeat), держателю — всех
// его подключений, а узлу с отданной сетевой картой — этой карты у машины.
// Поэтому узел ждёт, пока освободится, и объясняет, чего именно ждёт.

import crypto from 'node:crypto';

const hash32 = (s) => crypto.createHash('sha256').update(s).digest().readUInt32BE(0);

/**
 * Можно ли перезапускаться прямо сейчас.
 * @returns {{ok: boolean, reasons: {text: string, code: string}[]}}
 */
export function safeToRestart(app, { transfersActive = 0 } = {}) {
  const reasons = [];
  const selfId = app.config.get('nodeId');

  // Чужие аренды наших устройств.
  const foreign = [...(app.share?.claims?.values?.() || [])].filter((c) => c.holderId !== selfId);
  if (foreign.length) {
    reasons.push({ text: `наши устройства заняты другими (${foreign.length}): они потеряют соединение`, code: 'UPDATE_BLOCK_FOREIGN_CLAIMS', params: { count: foreign.length } });
  }

  // Наши подключения к чужим устройствам.
  const held = app.attach?.attachments?.size || 0;
  if (held) reasons.push({ text: `вы занимаете чужие устройства (${held}): подключения оборвутся`, code: 'UPDATE_BLOCK_HELD_DEVICES', params: { count: held } });

  // Чужая сетевая карта у нас в роли адаптера — разбирается при остановке.
  if (app.config.get('netLent')) reasons.push({ text: 'отдана сетевая карта: при перезапуске она вернётся системе', code: 'UPDATE_BLOCK_NET_LENT', params: {} });

  if (app.installer?.state === 'running') reasons.push({ text: 'идёт установка компонентов', code: 'UPDATE_BLOCK_INSTALLING', params: {} });
  if (transfersActive > 0) reasons.push({ text: `соседи скачивают обновление с этого узла (${transfersActive})`, code: 'UPDATE_BLOCK_TRANSFERS', params: { count: transfersActive } });

  return { ok: reasons.length === 0, reasons };
}

/**
 * Когда этому узлу очередь перезапускаться.
 *
 * Без общего координатора: порядок задаётся тем, что считают все одинаково.
 *   1. Первым запускается узел, получивший версию раньше всех (источник).
 *   2. Остальные ждут, пока источник проработает «канареечное» время на новой
 *      версии: если она плохая, откат случится у одного узла, а не у всех.
 *   3. Затем — по очереди, с интервалом: место узла определяется хешем от его
 *      идентификатора и версии, поэтому для каждой версии порядок свой и один и
 *      тот же узел не всегда последний.
 *
 * @param {object} o
 * @param {string} o.selfId
 * @param {string} o.version         целевая версия
 * @param {Array<{nodeId: string, version: string, startedAt: number}>} o.sources  узлы, уже работающие на целевой версии
 * @param {Array<{nodeId: string}>} o.waiting  остальные узлы, которым тоже предстоит обновиться
 * @param {number} o.canaryMs
 * @param {number} o.stepMs
 * @returns {{eligibleAt: number|null, rank: number}}  eligibleAt null — канарейка ещё не показала себя
 */
export function waveSchedule({ selfId, version, sources, waiting, canaryMs, stepMs }) {
  const order = [...waiting.map((w) => w.nodeId), selfId]
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => hash32(`${a}|${version}`) - hash32(`${b}|${version}`));
  const rank = order.indexOf(selfId);

  const startedAts = sources.map((s) => Number(s.startedAt)).filter(Number.isFinite);
  if (!startedAts.length) return { eligibleAt: null, rank };
  // Канарейка — узел, дольше всех работающий на новой версии.
  const canaryReady = Math.min(...startedAts) + canaryMs;
  return { eligibleAt: canaryReady + rank * stepMs, rank };
}

/** Порядок источников для одного узла: у каждого свой, чтобы нагрузка не шла в одно место. */
export function orderSources(selfId, version, peers) {
  return [...peers].sort((a, b) => {
    // Свои (по подсети) раньше узлов из других сетей, затем — по хешу.
    const la = a.origin === 'local' ? 0 : 1;
    const lb = b.origin === 'local' ? 0 : 1;
    if (la !== lb) return la - lb;
    return hash32(`${selfId}|${a.nodeId}|${version}`) - hash32(`${selfId}|${b.nodeId}|${version}`);
  });
}

