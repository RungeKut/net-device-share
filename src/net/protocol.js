// Протокол NDS/1 — обмен между узлами.
//
// Два канала:
//   1. UDP multicast — анонсы присутствия. Пакет маленький и содержит только
//      идентичность + хеш состояния. Список устройств по UDP НЕ передаётся,
//      иначе он упёрся бы в MTU при десятке устройств.
//   2. HTTP поверх TCP — всё остальное: выгрузка состояния, занятие,
//      освобождение, heartbeat. Запрос-ответ с понятными кодами ошибок.
//
// Владелец устройства — единственный источник истины о его занятости.
// Это снимает задачу распределённого консенсуса: никакого split-brain,
// потому что решение принимает ровно один узел.

import crypto from 'node:crypto';

export const PROTO = 'nds/1';

/**
 * Совместима ли метка протокола с нашей. Принимаем «nds/1» и «nds/1.N»:
 * дополнительные поля в пакетах всегда только добавляются, а строгое «==»
 * разорвало бы связь между версиями — и старые узлы перестали бы даже видеть,
 * что вышла новая, то есть самообновление не сработало бы именно тогда, когда
 * оно нужнее всего. Несовместимое изменение — это «nds/2», и вводить его
 * можно только в два шага: сначала версия, понимающая оба протокола.
 */
export function protoCompatible(proto) {
  return proto === PROTO || (typeof proto === 'string' && proto.startsWith(PROTO + '.'));
}

export const MSG = {
  ANNOUNCE: 'announce',   // периодический анонс присутствия
  BYE: 'bye',             // корректный уход из сети
  QUERY: 'query',         // просьба ко всем немедленно анонсироваться
};

export const CLAIM_MODE = {
  REMOTE: 'remote',       // устройство занял другой узел
  LOCAL: 'local',         // узел занял собственное устройство
};

export const BIND_STATE = {
  UNBOUND: 'unbound',
  BOUND: 'bound',
  ATTACHED: 'attached',
  ERROR: 'error',
};

/**
 * Хеш состояния: меняется — значит пора перечитать состояние узла по HTTP.
 *
 * В хеш входит всё, что видят соседи: состав и занятость устройств,
 * пользовательские описания, принадлежность к группам. Второй аргумент —
 * состояние групп и запросов: они живут отдельно от списка устройств, но
 * их изменения обязаны доходить до соседей так же быстро.
 */
export function stateHash(devices, extra = '') {
  const shape = devices
    .map((d) => [
      d.deviceId,
      d.shared ? 1 : 0,
      d.bindState,
      d.claim ? `${d.claim.holderId}@${d.claim.since}` : '-',
      (d.joins || []).map((j) => j.holderId).sort().join(',') || '-',
      d.reservedFor ? d.reservedFor.nodeId : '-',
      d.purpose || '',
      d.traffic || '-',
      d.groupId || '-',
    ].join('|'))
    .sort()
    .join(';');
  return crypto.createHash('sha1').update(`${shape}##${extra}`).digest('hex').slice(0, 16);
}

/**
 * Метка «круга доверия» — производная от общего ключа.
 *
 * Одной проверки подписи мало: узел БЕЗ ключа принимает любые пакеты и
 * потому видел бы в списке узлы с ключом, хотя достучаться до них не может.
 * Метка делает разделение симметричным: узлы с разными ключами просто не
 * замечают друг друга. Сам ключ по ней не восстанавливается.
 */
export function realmOf(key) {
  if (!key) return 'open';
  return crypto.createHash('sha256').update(`nds-realm/1:${key}`).digest('hex').slice(0, 16);
}

/** HMAC тела сообщения общим ключом. Пустой ключ → подпись не используется. */
export function sign(payload, key) {
  if (!key) return '';
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

/**
 * Подпись HTTP-вызова между узлами (v2): кроме тела покрывает метод, путь,
 * отправителя и время. Подпись одного тела позволяла взять перехваченный
 * вызов и повторить его с чужим x-nds-node или на другом пути.
 */
export function signRequest({ ts, method, path, nodeId, body }, key) {
  if (!key) return '';
  return sign(`${ts}
${method}
${path}
${nodeId}
${body}`, key);
}

/** Окно свежести подписи: часы узлов расходятся, поэтому запас щедрый. */
export const REQUEST_SKEW_MS = 10 * 60 * 1000;

export function verifyRequest(req, signature, key) {
  if (!key) return true;
  const ts = Number(req.ts);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > REQUEST_SKEW_MS) return false;
  const expected = signRequest(req, key);
  if (!signature || signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Почему вызов с подписью не принят — только для текста ответа и журнала.
 * Решение «принять или нет» остаётся за verifyRequest/matchRequest; здесь
 * лишь разбираем, какая из причин вероятнее, чтобы человек не гадал над
 * одинаковым «неверная подпись» (чаще всего это часы, а не ключ).
 */
export function diagnoseRequest({ ts, signature, signature2, strict = false }) {
  if (!signature2 && !signature) {
    return {
      reason: 'no_signature',
      message: 'вызов без подписи — этот узел принимает только подписанные вызовы (нужен общий ключ сети)',
    };
  }
  if (!signature2) {
    return {
      reason: 'legacy_rejected',
      message: strict
        ? 'старая подпись не принимается: на этом узле включён строгий режим подписей'
        : 'неверная подпись — не совпадает общий ключ или круг доверия',
    };
  }
  const sent = Number(ts);
  if (!Number.isFinite(sent)) {
    return { reason: 'bad_ts', message: 'в вызове нет читаемой метки времени — подпись проверить нельзя' };
  }
  const skewMs = Date.now() - sent;
  if (Math.abs(skewMs) > REQUEST_SKEW_MS) {
    const minutes = Math.round(Math.abs(skewMs) / 60000);
    return {
      reason: 'clock_skew',
      skewMs,
      message: `расхождение часов: часы вызывающего узла ${skewMs > 0 ? 'отстают' : 'спешат'} от часов этого узла на ${minutes} мин (допуск ${REQUEST_SKEW_MS / 60000} мин) — выставьте время на обоих компьютерах`,
    };
  }
  return {
    reason: 'bad_key',
    message: 'неверная подпись — не совпадает общий ключ сети или узел в другом круге доверия',
  };
}

export function verify(payload, signature, key) {
  if (!key) return true; // аутентификация выключена
  const expected = sign(payload, key);
  if (!signature || signature.length !== expected.length) return false;
  // Сравнение за постоянное время: подпись проверяется на каждом пакете,
  // и обычный === давал бы утечку по времени.
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function encodeDatagram(message, key) {
  const body = JSON.stringify(message);
  return Buffer.from(JSON.stringify({ sig: sign(body, key), body }), 'utf8');
}

export function decodeDatagram(buf, key) {
  let envelope;
  try {
    envelope = JSON.parse(buf.toString('utf8'));
  } catch {
    return { error: 'malformed' };
  }
  if (typeof envelope.body !== 'string') return { error: 'malformed' };
  if (!verify(envelope.body, envelope.sig, key)) return { error: 'bad-signature' };


  let message;
  try {
    message = JSON.parse(envelope.body);
  } catch {
    return { error: 'malformed' };
  }
  if (!protoCompatible(message.proto)) return { error: 'proto-mismatch' };
  return { message };
}

/**
 * Разбор пакета, когда кругов доверия у узла несколько.
 *
 * Ключ выбирается по метке круга из самого пакета, и лишь потом проверяется
 * подпись. Значит, тело разбирается до проверки — и это осознанно: перебирать
 * все ключи на каждом чужом пакете дороже, а JSON.parse над недоверенными
 * данными в JavaScript безопасен (ключ «__proto__» из JSON становится обычным
 * собственным свойством и прототип не портит).
 *
 * До проверки подписи из тела берётся ровно одно поле — realm, и только чтобы
 * выбрать ключ. Всё остальное идёт в дело после проверки.
 *
 * @param {Buffer} buf
 * @param {(realm: string) => (string|undefined)} resolveKey
 *   ключ этого круга доверия или undefined, если круг нам чужой
 */
export function unpackDatagram(buf, resolveKey) {
  let envelope;
  try {
    envelope = JSON.parse(buf.toString('utf8'));
  } catch {
    return { error: 'malformed' };
  }
  if (typeof envelope.body !== 'string') return { error: 'malformed' };

  let message;
  try {
    message = JSON.parse(envelope.body);
  } catch {
    return { error: 'malformed' };
  }
  if (!protoCompatible(message.proto)) return { error: 'proto-mismatch' };

  const realm = message.realm || 'open';
  const key = resolveKey(realm);
  if (key === undefined) return { error: 'other-realm', realm };

  // В открытом круге ключа нет и проверять нечего — но и подписи там быть не
  // должно: иначе пакет из чужой ключевой сети, объявивший себя открытым,
  // прошёл бы как свой (verify с пустым ключом принимает что угодно).
  if (key === '' && envelope.sig) return { error: 'bad-signature', realm };
  if (!verify(envelope.body, envelope.sig, key)) return { error: 'bad-signature', realm };

  return { message, realm };
}

/** Глобальный идентификатор устройства: уникален в пределах всей сети. */
export function deviceKey(nodeId, busid) {
  return `${nodeId}:${busid}`;
}
