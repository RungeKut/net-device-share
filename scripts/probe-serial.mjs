// Можно ли работать с последовательным портом штатными средствами Node,
// без нативных модулей? От ответа зависит, возможен ли сервер RFC 2217
// в проекте без зависимостей и сборки.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const open = promisify(fs.open);
const close = promisify(fs.close);
const write = promisify(fs.write);

const B = String.fromCharCode(92); // обратный слэш, чтобы не воевать с экранированием
const paths = [`${B}${B}.${B}COM1`, 'COM1', `${B}${B}.${B}COM3`];

console.log('=== настройка порта через mode.com ===');
try {
  const out = execFileSync('mode.com', ['COM1:', 'baud=115200', 'parity=n', 'data=8', 'stop=1'],
    { encoding: 'latin1', timeout: 10000 });
  console.log('mode COM1: успех');
  console.log(out.split('\n').slice(0, 6).map((l) => '  ' + l.trim()).filter(Boolean).join('\n'));
} catch (e) {
  console.log('mode COM1: ОШИБКА — ' + (e.stderr || e.message || '').toString('latin1').slice(0, 200));
}

console.log('\n=== открытие порта ===');
for (const p of paths) {
  try {
    const fd = await open(p, 'r+');
    console.log(`открыт: ${p} (fd ${fd})`);
    try {
      const { bytesWritten } = await write(fd, Buffer.from([0x41]));
      console.log(`  запись: ок, байт ${bytesWritten}`);
    } catch (e) {
      console.log(`  запись: ${e.code} ${e.message}`);
    }
    await close(fd);
  } catch (e) {
    console.log(`НЕ открыт: ${p} → ${e.code}`);
  }
}

console.log('\n=== чтение: не заблокирует ли поток навсегда ===');
try {
  const fd = await open(`${B}${B}.${B}COM1`, 'r+');
  const buf = Buffer.alloc(64);
  const started = Date.now();
  const timer = setTimeout(() => {
    console.log('  чтение не вернулось за 3 с — запрос завис в пуле потоков');
    process.exit(0);
  }, 3000);
  timer.unref();
  const { bytesRead } = await promisify(fs.read)(fd, buf, 0, 64, null);
  clearTimeout(timer);
  console.log(`  чтение вернулось за ${Date.now() - started} мс, байт ${bytesRead}`);
  await close(fd);
} catch (e) {
  console.log(`  чтение: ${e.code} ${e.message}`);
}
