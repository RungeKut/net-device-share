#!/usr/bin/env node
// Точка входа.

import { spawn } from 'node:child_process';
import { Config, parseArgs, applyCliOverrides, configDir } from './config.js';
import { logger, setLevel } from './log.js';
import { App, VERSION } from './core/app.js';
import { createBackend } from './devices/backend.js';
import { listNetworks, resolveNetwork } from './net/interfaces.js';

const log = logger('main');

const HELP = `
Net Device Share ${VERSION} — общий доступ к USB-устройствам по сети.

  node src/main.js [параметры]

Параметры:
  --name <имя>            имя этого узла в сети (по умолчанию — имя компьютера)
  --network <CIDR>        рабочая сеть, например 192.168.1.0/24 (по умолчанию auto)
  --key <строка>          общий ключ: узлы с разными ключами друг друга не видят
  --api-port <порт>       HTTP: интерфейс и RPC между узлами (по умолчанию 47812)
  --discovery-port <порт> UDP: обнаружение узлов (по умолчанию 47811)
  --usbip-port <порт>     TCP: данные USB/IP (по умолчанию 3240)
  --traffic-port <порт>   TCP: счётчик трафика (по умолчанию 47813)
  --backend <тип>         auto | windows | linux | mock
  --log-level <уровень>   error | warn | info | debug | trace
  --no-open               не открывать браузер при запуске
  --doctor                проверить окружение и выйти
  --networks              показать доступные сети и выйти
  --help                  эта справка

Каталог настроек: ${configDir()}
`;

async function doctor(config) {
  const args = [];
  const line = (s) => args.push(s);

  line(`Net Device Share ${VERSION}`);
  line(`Платформа:      ${process.platform} ${process.arch}, Node ${process.version}`);
  line(`Каталог настроек: ${config.file}`);
  line(`Имя узла:       ${config.get('name')}`);
  line(`Идентификатор:  ${config.get('nodeId')}`);
  line('');

  line('Сетевые интерфейсы:');
  const nets = listNetworks();
  if (!nets.length) line('  (ни одного пригодного IPv4-интерфейса)');
  for (const n of nets) line(`  ${n.cidr.padEnd(20)} ${n.address.padEnd(16)} ${n.iface}`);
  const chosen = resolveNetwork(config.get('network'));
  line(`Рабочая сеть:   ${chosen ? `${chosen.cidr} (${chosen.iface})` : 'НЕ ОПРЕДЕЛЕНА'}`);
  line('');

  const backend = await createBackend(config.get('backend'), {
    usbipdPath: config.get('usbipdPath'),
    usbipPath: config.get('usbipPath'),
  });
  const info = await backend.probe();
  line(`Бэкенд USB/IP:  ${backend.name}`);
  line(`  раздача своих устройств:   ${info.server ? 'ДА' : 'НЕТ'}`);
  line(`  подключение чужих:         ${info.client ? 'ДА' : 'НЕТ'}`);
  for (const [k, v] of Object.entries(info.tools || {})) {
    line(`  ${k}: ${v || 'не найдено'}`);
  }
  if (info.issues.length) {
    line('');
    line('Замечания:');
    for (const i of info.issues) line(`  • ${i}`);
  }

  line('');
  line('Локальные USB-устройства:');
  try {
    const devices = await backend.listLocal();
    if (!devices.length) line('  (список пуст)');
    for (const d of devices) {
      line(`  ${(d.busid || '—').padEnd(8)} ${(d.vendorId || '????')}:${(d.productId || '????')}  ${d.description}${d.bound ? '  [опубликовано]' : ''}`);
    }
  } catch (e) {
    line(`  ошибка: ${e.message}`);
  }

  process.stdout.write(args.join('\n') + '\n');
}

/**
 * Открывает интерфейс штатным обработчиком ссылок операционной системы.
 *
 * Здесь намеренно НЕ используется `cmd /c start` со скрытым окном и
 * отвязкой от родителя. Такая связка — запуск командного интерпретатора с
 * произвольной строкой, спрятанным окном и выброшенным выводом — совпадает
 * с типовым поведением загрузчиков вредоносного кода, и антивирусы
 * справедливо помечают её эвристикой. explorer.exe делает ровно то же
 * полезное действие (ShellExecute по протоколу http), но интерпретатор
 * команд в цепочке не участвует и ничего не прячется.
 */
function openBrowser(url) {
  // Проверяем ссылку перед передачей во внешнюю программу. Сейчас она
  // собирается нами же из локального адреса и порта, но подстановка чужой
  // строки в аргумент внешнего процесса — как раз то, чего делать нельзя.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    log.debug('некорректная ссылка, браузер не открываем:', url);
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    log.debug('ссылка не по протоколу http(s), браузер не открываем:', url);
    return;
  }

  const [command, args] = process.platform === 'win32' ? ['explorer.exe', [parsed.href]]
    : process.platform === 'darwin' ? ['open', [parsed.href]]
    : ['xdg-open', [parsed.href]];

  try {
    const child = spawn(command, args, { stdio: 'ignore' });
    // explorer.exe возвращает ненулевой код даже при успешном открытии,
    // поэтому код выхода не проверяем: важно лишь, что процесс запустился.
    child.on('error', (e) => log.debug(`браузер открыть не удалось: ${e.message}`));
    child.unref();
  } catch (e) {
    log.debug('браузер открыть не удалось:', e.message);
  }
}

async function main() {
  const args = parseArgs();

  if (args.help || args.h) {
    process.stdout.write(HELP);
    return;
  }

  const config = new Config(typeof args.config === 'string' ? args.config : undefined);
  applyCliOverrides(config, args);
  setLevel(config.get('logLevel'));

  if (args.networks) {
    for (const n of listNetworks()) {
      process.stdout.write(`${n.cidr}\t${n.address}\t${n.iface}\n`);
    }
    return;
  }

  if (args.doctor) {
    await doctor(config);
    return;
  }

  const app = new App(config);
  await app.start();

  const url = `http://${config.get('uiHost')}:${config.get('apiPort')}/`;
  process.stdout.write(`\n  Интерфейс: ${url}\n  Узел: "${config.get('name')}"  сеть: ${app.network.cidr}\n  Остановка: Ctrl+C\n\n`);
  if (!args['no-open']) openBrowser(url);

  let shuttingDown = false;
  const stop = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`получен ${signal}`);
    // Завершение не должно висеть вечно, если сеть или драйвер не отвечают.
    const timer = setTimeout(() => {
      log.warn('корректное завершение затянулось — выходим принудительно');
      process.exit(1);
    }, 15000);
    timer.unref();
    try {
      await app.shutdown();
    } catch (e) {
      log.error('ошибка при завершении:', e.message);
    }
    clearTimeout(timer);
    process.exit(0);
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('uncaughtException', (e) => {
    log.error('необработанное исключение:', e.stack || e.message);
  });
  process.on('unhandledRejection', (e) => {
    log.error('необработанное отклонение промиса:', e?.stack || String(e));
  });
}

main().catch((e) => {
  process.stderr.write(`\nЗапуск не удался: ${e.message}\n\n`);
  process.exit(1);
});
