// Legacy-слаг для обратной совместимости: тесты и HTTP-статусы смотрят e.code.
// CAPS-код (srvCode) уходит клиенту для перевода. Где old errWith('слаг') не было —
// записи не добавляются, e.code = CAPS.
const LEGACY_FOR = {
  CLAIM_BLOCKED: 'busy',
  CLAIM_BLOCKED_GROUP: 'busy',
  CLAIM_BLOCKED_BRIDGE: 'busy',
  CLAIM_BLOCKED_DEVICE: 'busy',
  DEVICE_BUSY: 'busy',
  GROUP_BUSY: 'busy',
  GROUP_MEMBER_BUSY: 'busy',
  DEVICE_PREPARING: 'busy',
  CARD_BUSY: 'busy',
  RESERVED: 'busy',
  NOT_JOINABLE: 'not_joinable',
  OWN_CARD_NO_BRIDGE_NEEDED: 'not_joinable',
  DEVICE_NOT_FOUND: 'device_not_found',
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'forbidden',
  IN_GROUP: 'in_group',
  UNAVAILABLE: 'unavailable',
  GROUP_NOT_FOUND: 'not_found',
  BAD_REQUEST: 'bad_request',
  GROUP_CONFLICT: 'conflict',
  GROUP_NOT_SHARED: 'not_shared',
  DEVICE_NOT_SHARED: 'not_shared',
  BIND_FAILED: 'bind_failed',
  JOIN_FAILED: 'bind_failed',
  NO_CLAIM: 'no_claim',
  NOT_BUSY: 'not_busy',
  ALREADY_YOURS: 'already_yours',
  REQUEST_CLOSED: 'closed',
  // netManager (CAPS-места, где в том же файле был errWith('слаг'))
  ADAPTER_NOT_FOUND: 'not_found',
  BRIDGE_ALREADY_EXISTS: 'bridge_busy',
  BRIDGE_FOREIGN_EXISTS: 'bridge_foreign',
  TAP_DRIVER_MISSING: 'unavailable',
};

// Единый конструктор ошибок с кодом и параметрами для i18n на клиенте.
//   e.code    — legacy-слаг (совместимость с тестами и HTTP-статусами)
//   e.srvCode — CAPS-код (для клиента-перевода)
//   extra     — свои поля поверх ошибки (например claim), как в старом errWith
export function fail(code, ru, params, extra) {
  const err = new Error(ru);
  err.code = LEGACY_FOR[code] || code;
  err.srvCode = code;
  err.params = params || {};
  Object.assign(err, extra);
  return err;
}