// Простой логгер без зависимостей + кольцевой буфер для отдачи в UI.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

let currentLevel = LEVELS.info;
const ring = [];
const RING_MAX = 500;
const listeners = new Set();

export function setLevel(name) {
  if (name in LEVELS) currentLevel = LEVELS[name];
}

export function onLogRecord(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recentLogs(limit = 200) {
  return ring.slice(-limit);
}

function emit(level, scope, args) {
  if (LEVELS[level] > currentLevel) return;
  const msg = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');
  const rec = { ts: Date.now(), level, scope, msg };

  ring.push(rec);
  if (ring.length > RING_MAX) ring.shift();

  const time = new Date(rec.ts).toISOString().slice(11, 23);
  const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');

  for (const fn of listeners) {
    try {
      fn(rec);
    } catch {
      /* слушатель UI не должен ронять логгер */
    }
  }
}

function safeStringify(value) {
  if (value instanceof Error) return `${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function logger(scope) {
  return {
    error: (...a) => emit('error', scope, a),
    warn: (...a) => emit('warn', scope, a),
    info: (...a) => emit('info', scope, a),
    debug: (...a) => emit('debug', scope, a),
    trace: (...a) => emit('trace', scope, a),
  };
}
