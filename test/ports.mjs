// Порты для тестов, поднимающих настоящие узлы: их портам нужно быть
// известными до запуска процесса (они задаются в config.json), поэтому
// «попросить свободный у системы» (listen(0)) нельзя.
import net from 'node:net';

/** Свободен ли порт на всех адресах: приложение слушает 0.0.0.0. */
const free = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen({ port, host: '0.0.0.0', exclusive: true }, () => s.close(() => resolve(true)));
});

/**
 * Блок соседних свободных портов: база + size − 1.
 *
 * Диапазон — ниже динамического (в Windows с 49152): там система выдаёт
 * эфемерные порты любым исходящим соединениям, и случайная база изредка
 * попадала на занятый — узел падал с EADDRINUSE ещё до готовности.
 * Занятость проверяется пробной привязкой: параллельные файлы тестов и
 * другие прогоны на машине держат свои порты где угодно.
 */
export async function freePortBlock(size = 4, { from = 45200, to = 47000, step = 10 } = {}) {
  const bases = Math.floor((to - from) / step);
  for (let attempt = 0; attempt < 200; attempt++) {
    const base = from + Math.floor(Math.random() * bases) * step;
    const ports = Array.from({ length: size }, (_, i) => base + i);
    const ok = [];
    for (const p of ports) ok.push(await free(p));
    if (ok.every(Boolean)) return base;
  }
  throw new Error(`не найден свободный блок из ${size} портов в ${from}–${to}`);
}
