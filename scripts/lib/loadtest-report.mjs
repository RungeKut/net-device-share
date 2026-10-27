// Сводка нагрузочного стенда: читает info.json и *.jsonl из каталога
// результатов и собирает report.md. Читает файлы, а не память процесса,
// чтобы отдельно запущенные команды складывались в один отчёт.

import fs from 'node:fs';
import path from 'node:path';

function readJsonl(dir, file) {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/).filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  } catch { return []; }
}

function readJson(dir, file) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return null; }
}

const f = (x, d = 1) => (x == null || !Number.isFinite(Number(x)) ? '—' : String(Math.round(Number(x) * 10 ** d) / 10 ** d));
const sec = (ms) => (ms == null ? null : ms / 1000);
const gb = (mb) => (mb == null ? null : mb / 1024);

function table(head, body) {
  if (!body.length) return '_нет данных_\n';
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...body.map(line)].join('\n') + '\n';
}

/** Показатель степени в rate ~ N^k по методу наименьших квадратов в логарифмах. */
function growthExponent(points) {
  const pts = points.filter(([n, r]) => n > 0 && r > 0).map(([n, r]) => [Math.log(n), Math.log(r)]);
  if (pts.length < 2) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const den = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  if (!den) return null;
  return pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / den;
}

function thin(list, max) {
  if (list.length <= max) return list;
  const out = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]);
  return out;
}

function topLogs(logs) {
  if (!logs?.length) return 'Предупреждений и ошибок в журналах узлов не было.\n';
  return table(['Раз', 'Сообщение (числа, адреса и имена узлов обобщены)'], logs.map((l) => [l.count, `\`${l.msg.replace(/\|/g, '\\|')}\``]));
}

function machineSection(info) {
  if (!info) return '## Машина\n\n_info.json не найден_\n';
  const d = info.defender;
  return `## Машина

- Узел: ${info.hostname}, Node ${info.node}
- Процессор: ${info.cpu.model ?? '?'}; сокетов ${f(info.cpu.sockets, 0)}, физических ядер ${f(info.cpu.physicalCores, 0)}, логических ${info.cpu.logicalProcessors}
- Память: ${f(gb(info.memory.totalMb), 1)} ГБ всего, ${f(gb(info.memory.freeMb), 1)} ГБ свободно на момент замера
- ОС: ${info.windows.caption ?? '?'} ${info.windows.version ?? ''} (сборка ${info.windows.build ?? '?'})
- Защитник Windows: ${d ? `защита в реальном времени ${d.realtimeProtection ? 'включена' : 'выключена'}` : 'состояние не определено (нет Get-MpComputerStatus или сторонний антивирус)'}
- Динамические порты TCP: ${info.dynamicPortRange ? `${info.dynamicPortRange.start}–${info.dynamicPortRange.end} (${info.dynamicPortRange.count})` : '?'}
- Порты под узлы (база ${info.ports.basePort}, по 4 на узел): свободных мест ${info.ports.freeSlots} из ${info.ports.slotsTotal}, занято TCP-портов в системе ${info.ports.usedCount}, зарезервированных диапазонов ${info.ports.excluded.length}
- Процессов node.exe до запуска: ${info.nodeProcessesNow}
`;
}

function rampSection(rows) {
  if (!rows.length) return '';
  const start = rows.find((r) => r.ev === 'start');
  const base = rows.find((r) => r.ev === 'baseline');
  const steps = rows.filter((r) => r.ev === 'step');
  const done = rows.find((r) => r.ev === 'done');
  const crash = rows.find((r) => r.ev === 'crash');
  let s = '## Ступенчатый рост (ramp)\n\n';
  if (start) {
    s += `Параметры: ступени ${start.steps.join(', ')}; партия ${start.batch}; пауза перед замером ${start.settleSeconds} с; порог процессора ${start.maxCpu}%; порог свободной памяти ${start.minFreeMb} МБ; типы устройств ${start.types.join(',')}; сеть ${start.network ?? 'автовыбор'}; порт обнаружения ${start.discoveryPort}${start.jitter != null ? `; timerJitter ${start.jitter}` : ''}.\n\n`;
  }
  if (done) {
    s += `**Остановились: ${done.reason}.** Максимум, на котором сеть сошлась: **${done.lastGood} узлов**. Всего запущено ${done.spawned}, упало ${done.exited}; пропущено занятых мест под порты ${done.portSkips}, конфликтов EADDRINUSE ${done.portConflicts}.\n\n`;
  } else if (crash) {
    s += `**Стенд завершился аварийно:** \`${String(crash.error).split('\n')[0]}\`\n\n`;
  } else {
    s += '_Прогон не дошёл до конца (нет итоговой записи)._\n\n';
  }
  if (!steps.length) return s;

  s += '### Узлы, старт и сходимость\n\n';
  s += table(
    ['Узлов', 'Поднято за ступень', 'Старт p50 / p95, с', 'Не поднялись', 'Сходимость, с', 'Выборка', 'Устройство в каталоге, мс', 'Упало'],
    steps.map((r) => [r.nodes + (r.partial ? ' (неполная)' : ''), r.startup.added, `${f(sec(r.startup.p50Ms))} / ${f(sec(r.startup.p95Ms))}`, r.startup.notReady,
      r.convergence.timedOut ? 'не сошлась' : f(r.convergence.secs), r.convergence.sample, f(r.propagationMs, 0), r.exited]),
  );

  s += '\n### Процессор и память\n\n';
  s += table(
    ['Узлов', 'CPU машины, %', 'user', 'kernel', 'interrupt', 'node.exe, % машины', 'На узел, % ядра', 'ОЗУ узлов, ГБ', 'На узел, МБ', 'Свободно, ГБ', 'Дескрипторов на узел', 'Потоков на узел', 'Очередь CPU'],
    steps.map((r) => [r.nodes, f(r.cpu?.busyPct), f(r.cpu?.userPct), f(r.cpu?.kernelPct), f(r.cpu?.irqPct), f(r.proc?.cpuPctOfMachine), f(r.proc?.perNodeCpuPctOfCore, 2),
      f(gb(r.proc?.rssTotalMb), 2), f(r.proc?.rssAvgMb), f(gb(r.freeMb), 2), f(r.proc?.handlesAvg, 0), f(r.proc?.threadsAvg), f(r.net?.procQueueAvg)]),
  );

  s += '\n### Задержка API\n\n';
  s += table(
    ['Узлов', 'GET /api/v1/state p50 / p95, мс', 'Размер state, КБ', 'GET /metrics p50 / p95, мс', 'Размер /metrics, КБ', 'Серий метрик', 'Ошибок запросов'],
    steps.map((r) => [r.nodes, `${f(r.latency?.state.p50)} / ${f(r.latency?.state.p95)}`, f(r.latency?.state.kb), `${f(r.latency?.metrics.p50)} / ${f(r.latency?.metrics.p95)}`,
      f(r.latency?.metrics.kb), f(r.latency?.metrics.series, 0), (r.latency?.state.fail ?? 0) + (r.latency?.metrics.fail ?? 0)]),
  );

  s += '\n### Сеть (CIM, среднее за окно ~10 с)\n\n';
  const netRows = [];
  if (base?.net) netRows.push(['0 (без узлов)', f(base.net.udpRecvPerSec, 0), f(base.net.udpSentPerSec, 0), f(base.net.udpRecvErrors, 0), f(base.net.udpNoPortPerSec, 0), '—', f(base.net.tcpEstablished, 0), f(base.net.tcpFailures, 0), f(base.net.tcpRetransPerSec), f(base.net.nicPacketsPerSec, 0), f(base.net.nicBytesPerSec / 1048576, 3), f(base.net.nicDiscarded, 0), f(base.net.nicQueueMax, 0)]);
  for (const r of steps) {
    const n = r.net;
    netRows.push([r.nodes, f(n?.udpRecvPerSec, 0), f(n?.udpSentPerSec, 0), f(n?.udpRecvErrors, 0), f(n?.udpNoPortPerSec, 0), n ? f(n.udpRecvPerSec / (r.nodes * r.nodes), 4) : '—',
      f(n?.tcpEstablished, 0), f(n?.tcpFailures, 0), f(n?.tcpRetransPerSec), f(n?.nicPacketsPerSec, 0), n ? f(n.nicBytesPerSec / 1048576, 3) : '—', f(n?.nicDiscarded, 0), f(n?.nicQueueMax, 0)]);
  }
  s += table(
    ['Узлов', 'UDP принято/с', 'UDP отправлено/с', 'Ошибок приёма UDP (прирост)', 'UDP на закрытый порт/с', 'Принято/с на N²', 'TCP соединений', 'Сбоев соединений (прирост)', 'Ретрансмиссий/с', 'Сетевые карты: пакетов/с', 'МБ/с', 'Отброшено (прирост)', 'Очередь отправки, макс'],
    netRows,
  );

  const baseRate = base?.net?.udpRecvPerSec ?? 0;
  const pts = steps.filter((r) => r.net && r.nodes >= 5).map((r) => [r.nodes, Math.max(0, r.net.udpRecvPerSec - baseRate)]);
  const k = growthExponent(pts);
  const errTotal = steps.reduce((a, r) => a + (r.net?.udpRecvErrors ?? 0), 0);
  s += '\nПриём UDP на общем порту обнаружения: каждый широковещательный пакет доставляется каждому сокету, поэтому при N узлах на одной машине ожидается рост порядка N². ';
  s += k == null
    ? 'Точек для оценки показателя роста недостаточно.'
    : `Измеренный показатель роста DatagramsReceivedPersec (за вычетом фона без узлов) по ступеням ≈ **${f(k, 2)}** (1 — линейный рост, 2 — квадратичный).`;
  s += ` Ошибки приёма UDP (DatagramsReceivedErrors) за все ступени: ${errTotal > 0 ? `**выросли на ${errTotal}** — ядро теряет дейтаграммы` : 'не росли'}.\n\n`;
  const nicTop = steps.at(-1)?.net?.nics?.[0];
  if (nicTop) s += `Самый нагруженный адаптер на последней ступени: «${nicTop.name}», ${f(nicTop.packetsPerSec, 0)} пакетов/с, ${f(nicTop.bytesPerSec / 1048576, 3)} МБ/с, отброшено ${nicTop.discardedDelta}.\n\n`;

  s += '### Предупреждения и ошибки в журналах узлов\n\n';
  s += topLogs(done?.topLogs);
  return s;
}

function stormSection(rows) {
  if (!rows.length) return '';
  const start = rows.find((r) => r.ev === 'start');
  const get = (ev) => rows.find((r) => r.ev === ev);
  const startup = get('startup');
  const full = get('fullview');
  const det = get('detection');
  const rej = get('rejoin');
  const done = rows.find((r) => r.ev === 'done');
  let s = '## Одновременный старт и падение узлов (storm)\n\n';
  if (!startup) {
    s += `${done ? `Сценарий не выполнен: ${done.reason}.` : 'Сценарий не дошёл до старта узлов.'}\n\n`;
    return s;
  }
  s += `Узлов ${start.nodes}, останавливалось ${start.victims}. Рестарт идёт с тем же каталогом данных (config.json не затирается), поэтому nodeId сохраняется.\n\n`;
  const rowsT = [
    ['Запуск всех процессов, с', f(startup.spawnSecs)],
    ['Готовность узла p50 / p95, с', `${f(sec(startup.p50Ms))} / ${f(sec(startup.p95Ms))}`],
    ['Не поднялись / упали при старте', `${startup.notReady} / ${startup.exited}`],
    ['Полный взаимный обзор от старта, с', full?.fullSecsFromStart == null ? 'не наступил' : f(full.fullSecsFromStart)],
  ];
  if (det) {
    rowsT.push(['Обнаружение падения (пар наблюдатель-узел)', `${det.detected} из ${det.pairs}`]);
    rowsT.push(['Обнаружение p50 / p95 / max, с', `${f(det.p50Secs)} / ${f(det.p95Secs)} / ${f(det.maxSecs)}`]);
    rowsT.push(['Сообщений «помечен офлайн» при этом', det.offlineMarks]);
  }
  if (rej) {
    rowsT.push(['Возврат после рестарта (пар)', `${rej.returned} из ${rej.pairs}`]);
    rowsT.push(['Возврат p50 / p95 / max, с', `${f(rej.p50Secs)} / ${f(rej.p95Secs)} / ${f(rej.maxSecs)}`]);
    rowsT.push(['Перезапущенные увидели всех (p50 / max), с', `${f(rej.victimsFullViewP50Secs)} / ${f(rej.victimsFullViewMaxSecs)} (${rej.victimsFullView} из ${start.victims})`]);
    rowsT.push(['nodeId сохранился', rej.nodeIdKept ? 'да' : 'нет']);
  }
  s += table(['Показатель', 'Значение'], rowsT);
  const w = get('startup-window')?.window;
  if (w?.net) {
    s += `\nОкно первых ~15 с после старта: CPU машины ${f(w.cpu?.busyPct)}% (kernel ${f(w.cpu?.kernelPct)}%), UDP принято ${f(w.net.udpRecvPerSec, 0)}/с, ошибок приёма ${f(w.net.udpRecvErrors, 0)}, свободно ${f(gb(w.net.cimFreeMb), 2)} ГБ.\n`;
  }
  if (done?.after?.net) s += `Спокойное состояние после сценария: CPU ${f(done.after.cpu?.busyPct)}%, UDP принято ${f(done.after.net.udpRecvPerSec, 0)}/с, ошибок приёма ${f(done.after.net.udpRecvErrors, 0)}.\n`;
  s += '\n### Предупреждения и ошибки в журналах узлов\n\n';
  s += topLogs(done?.topLogs);
  return s;
}

function soakSection(rows) {
  if (!rows.length) return '';
  const start = rows.find((r) => r.ev === 'start');
  const samples = rows.filter((r) => r.ev === 'sample');
  const done = rows.find((r) => r.ev === 'done');
  let s = '## Длительная выдержка (soak)\n\n';
  if (!samples.length) return `${s}${done ? `Не выполнено: ${done.reason}.` : 'Нет замеров.'}\n\n`;
  s += `Узлов ${start.nodes}, срок ${start.minutes} мин, замер раз в 30 с.${done ? ` Итог: ${done.reason}.` : ''}\n\n`;
  s += table(
    ['Минута', 'Узлов (упало)', 'CPU, %', 'node.exe, % машины', 'ОЗУ узлов, ГБ', 'Свободно, ГБ', 'Дескрипторов', 'Потоков', 'UDP принято/с', 'Ошибок UDP (прирост)', 'Сбоев TCP', 'Ложных офлайн', 'Видят не меньше'],
    thin(samples, 30).map((r) => [f(r.minutes), `${r.nodes} (${r.exited})`, f(r.cpu?.busyPct), f(r.proc?.cpuPctOfMachine), f(gb(r.proc?.rssTotalMb), 2), f(gb(r.freeMb), 2),
      f(r.proc?.handlesTotal, 0), f(r.proc?.threadsTotal, 0), f(r.net?.udpRecvPerSec, 0), f(r.net?.udpRecvErrors, 0), f(r.net?.tcpFailures, 0), r.falseOffline, `${f(r.seenMin, 0)} из ${r.seenExpected}`]),
  );
  const a = samples[0];
  const z = samples.at(-1);
  const hours = Math.max(0.01, (z.minutes - a.minutes) / 60);
  const memGrowth = ((z.proc?.rssTotalMb ?? 0) - (a.proc?.rssTotalMb ?? 0));
  const handleGrowth = ((z.proc?.handlesTotal ?? 0) - (a.proc?.handlesTotal ?? 0));
  s += `\nЛожные офлайн (строки WARN «помечен офлайн», пока все узлы живы): **${done?.falseOfflineTotal ?? z.falseOfflineTotal}**. `;
  s += `Рост памяти узлов за время выдержки: ${f(memGrowth, 0)} МБ ${hours >= 0.1 ? `(${f(memGrowth / hours, 0)} МБ/ч)` : '(срок слишком мал для оценки скорости)'}; дескрипторов: ${f(handleGrowth, 0)}. Упало узлов: ${z.exited}.\n\n`;
  s += '### Предупреждения и ошибки в журналах узлов\n\n';
  s += topLogs(done?.topLogs);
  return s;
}

function conclusions(ramp, storm, soak) {
  const out = [];
  const done = ramp.find((r) => r.ev === 'done');
  const steps = ramp.filter((r) => r.ev === 'step');
  if (done) out.push(`Машина выдержала **${done.lastGood}** узлов; рост остановлен: ${done.reason}.`);
  const last = [...steps].reverse().find((r) => r.proc && !r.convergence.timedOut);
  if (last) {
    const perGb = last.proc.rssAvgMb ? Math.floor(1024 / last.proc.rssAvgMb) : null;
    out.push(`Один узел занимает около ${f(last.proc.rssAvgMb, 0)} МБ и ${f(last.proc.perNodeCpuPctOfCore, 2)}% ядра в покое (${f(last.proc.handlesAvg, 0)} дескрипторов, ${f(last.proc.threadsAvg, 0)} потоков)${perGb ? `: на каждый гигабайт памяти приходится около ${perGb} узлов` : ''}.`);
    out.push(`Время сходимости на ${last.nodes} узлах: ${f(last.convergence.secs)} с; ответ GET /api/v1/state p95 ${f(last.latency?.state.p95)} мс при ${f(last.latency?.state.kb)} КБ.`);
  }
  const errTotal = steps.reduce((a, r) => a + (r.net?.udpRecvErrors ?? 0), 0);
  if (steps.length) out.push(errTotal > 0 ? `Ядро теряло UDP-дейтаграммы: DatagramsReceivedErrors вырос на ${errTotal}.` : 'Ошибок приёма UDP (DatagramsReceivedErrors) за ramp не было.');
  const det = storm.find((r) => r.ev === 'detection');
  const rej = storm.find((r) => r.ev === 'rejoin');
  if (det) out.push(`Падение узла замечают за p50 ${f(det.p50Secs)} с, максимум ${f(det.maxSecs)} с (порог узла ${det.peerTimeoutMs / 1000} с); вернувшийся узел виден за p50 ${f(rej?.p50Secs)} с.`);
  const sdone = soak.find((r) => r.ev === 'done');
  const sl = soak.filter((r) => r.ev === 'sample').at(-1);
  if (sdone && sl) out.push(`Выдержка: ложных офлайн ${sdone.falseOfflineTotal ?? sl.falseOfflineTotal}, упало узлов ${sl.exited}.`);
  return out.length ? out.map((l) => `- ${l}`).join('\n') + '\n' : '_данных для выводов пока нет_\n';
}

export function buildReport(dir) {
  const info = readJson(dir, 'info.json');
  const ramp = readJsonl(dir, 'ramp.jsonl');
  const storm = readJsonl(dir, 'storm.jsonl');
  const soak = readJsonl(dir, 'soak.jsonl');
  return `# Отчёт нагрузочного стенда Net Device Share

Сформирован ${new Date().toISOString()}. Узлы — настоящее приложение с имитацией устройств (\`--backend mock\`) на одной машине, имена LT-0001 …

## Выводы

${conclusions(ramp, storm, soak)}
${machineSection(info)}
${rampSection(ramp)}
${stormSection(storm)}
${soakSection(soak)}`;
}
