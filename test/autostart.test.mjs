// Автозапуск службой: задание от SYSTEM при загрузке, прежний режим для открытой папки,
// запуск из установщика без второго UAC.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Autostart } from '../src/core/autostart.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auto = new Autostart(null);

test('задание службы: SYSTEM, загрузка и вход любого пользователя, без LogonType', () => {
  const xml = auto._taskXml({ system: true, userId: 'DOM\\user' });
  assert.match(xml, /<Principal id="Author">\s*<UserId>S-1-5-18<\/UserId>\s*<RunLevel>HighestAvailable<\/RunLevel>/);
  assert.match(xml, /<BootTrigger>[\s\S]*<Delay>PT30S<\/Delay>/);
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<\/LogonTrigger>/, 'вход без привязки к пользователю');
  assert.doesNotMatch(xml, /S4U|DOM/, 'имя включившего в задании службы не нужно');
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
});

test('прежний режим (папка открыта на запись): S4U от имени пользователя, без загрузочного триггера', () => {
  const xml = auto._taskXml({ system: false, userId: 'DOM\\user' });
  assert.match(xml, /<UserId>DOM\\user<\/UserId>\s*<LogonType>S4U<\/LogonType>/);
  assert.doesNotMatch(xml, /BootTrigger|S-1-5-18/);
});

test('автозапуск.bat читает autostart.home до запуска приложения', () => {
  // CP866: ASCII-строки читаются как latin1 без искажений.
  const bat = fs.readFileSync(path.join(root, 'scripts', 'autostart.bat')).toString('latin1');
  const home = bat.indexOf('autostart.home');
  const launch = bat.indexOf('"%NODE_EXE%" "%ENTRY%"');
  assert.ok(home > 0 && launch > home, 'NDS_HOME должен быть задан до запуска узла');
  assert.ok(!bat.replace(/\r\n/g, '').includes('\n'), 'переводы строк только CRLF');
});

test('установщик: службу запускает сам и не просит UAC второй раз', () => {
  const iss = fs.readFileSync(path.join(root, 'installer', 'nds.iss.tpl'), 'utf8');
  assert.match(iss, /schtasks\.exe"; Parameters: "\/Run \/TN NetDeviceShare"[^\n]*Tasks: autostart/);
  assert.match(iss, /open\.vbs"" \/elevated"[^\n]*runascurrentuser[^\n]*Check: not AutostartChosen/);
  assert.match(iss, /function AutostartChosen\(\): Boolean;/);
});

test('ярлык: с /elevated запускает напрямую, без runas; сначала пробует задание службы', () => {
  const vbs = fs.readFileSync(path.join(root, 'launcher', 'open.vbs')).subarray(2).toString('utf16le');
  assert.match(vbs, /"\/elevated"/);
  assert.match(vbs, /ElseIf elev Then\s+sh\.CurrentDirectory = base\s+sh\.Run/);
  assert.match(vbs, /schtasks\.exe \/Run \/TN NetDeviceShare/);
  assert.ok(vbs.indexOf('RunTask') < vbs.indexOf('StartApp nodeExe, entry'), 'задание пробуется раньше runas');
});
