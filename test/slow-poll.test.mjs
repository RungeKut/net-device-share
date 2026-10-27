import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceHub } from '../src/devices/hub.js';
import { portsFromPnp, netsFromAdapters, netSignature, listPortsAndNets, slowSignature } from '../src/devices/ports.js';

const port = (key) => ({ type: 'com', key, deviceId: `com:${key}`, title: key, description: 'порт', details: {}, present: true });
const nic = (name) => ({ type: 'net', key: name, deviceId: `net:${name}`, title: name, description: 'карта', details: { addresses: [] }, present: true });

/** Хаб с подменёнными источниками и управляемыми часами: ничего настоящего не запускается. */
function rig({ types = ['com', 'net'], sig = 'S1', loads = [] } = {}) {
  const calls = { load: 0, signature: 0 };
  const clock = { t: 1_000_000 };
  const state = { sig, ports: [port('COM3')], nets: [nic('Ethernet')], loadError: null, sigError: null };
  const hub = new DeviceHub({
    backend: {},
    enabledTypes: () => types,
    slow: {
      now: () => clock.t,
      random: () => 0.5,
      load: async (want) => {
        calls.load++;
        loads.push(want);
        if (state.loadError) throw state.loadError;
        return { ports: want.ports ? state.ports : [], nets: want.nets ? state.nets : [] };
      },
      signature: async () => {
        calls.signature++;
        if (state.sigError) throw state.sigError;
        return state.sig;
      },
    },
  });
  return { hub, calls, clock, state };
}
const keys = (list) => list.map((d) => d.key).sort();

test('первый опрос читает порты и интерфейсы ОДНИМ вызовом, а не двумя', async () => {
  const { hub, calls } = rig();
  const list = await hub.listLocal();
  assert.equal(calls.load, 1);
  assert.deepEqual(keys(list), ['COM3', 'Ethernet']);
});

test('пока кеш свеж, не спрашивается даже отпечаток', async () => {
  const { hub, calls, clock } = rig();
  await hub.listLocal();
  clock.t += 14_000;
  await hub.listLocal();
  assert.equal(calls.load, 1);
  assert.equal(calls.signature, 1);
});

test('отпечаток не изменился: тяжёлое чтение не запускается, список прежний', async () => {
  const { hub, calls, clock } = rig();
  await hub.listLocal();
  for (let i = 0; i < 6; i++) {
    clock.t += 16_000;
    const list = await hub.listLocal();
    assert.deepEqual(keys(list), ['COM3', 'Ethernet']);
  }
  assert.equal(calls.load, 1, 'тяжёлое чтение — только первое');
  assert.equal(calls.signature, 7);
  assert.equal(hub.slowStats.skipped, 6);
});

test('отпечаток изменился: список перечитывается и новый порт виден', async () => {
  const { hub, calls, clock, state } = rig();
  await hub.listLocal();
  state.sig = 'S2';
  state.ports = [port('COM3'), port('COM7')];
  clock.t += 16_000;
  const list = await hub.listLocal();
  assert.equal(calls.load, 2);
  assert.deepEqual(keys(list), ['COM3', 'COM7', 'Ethernet']);
});

test('отпечаток не меняется, но полное перечитывание всё равно раз в fullRefreshMs', async () => {
  const { hub, calls, clock, state } = rig();
  await hub.listLocal();
  state.nets = [nic('Ethernet')];
  clock.t += 280_000;
  await hub.listLocal();
  assert.equal(calls.load, 1, 'до срока — по отпечатку');
  clock.t += 30_000;
  await hub.listLocal();
  assert.equal(calls.load, 2, 'срок вышел — настоящее чтение, даже без перемен в отпечатке');
});

test('«Обновить» (invalidateSlow) читает заново при том же отпечатке', async () => {
  const { hub, calls, clock, state } = rig();
  await hub.listLocal();
  state.ports = [port('COM3'), port('COM9')];
  hub.invalidateSlow();
  const list = await hub.listLocal();
  assert.equal(calls.load, 2);
  assert.deepEqual(keys(list), ['COM3', 'COM9', 'Ethernet']);
  clock.t += 16_000;
  await hub.listLocal();
  assert.equal(calls.load, 2, 'после обновления снова работает отпечаток');
});

test('отпечаток недоступен (null или сбой): читаем по-настоящему, как раньше', async () => {
  const a = rig({ sig: null });
  await a.hub.listLocal();
  a.clock.t += 16_000;
  await a.hub.listLocal();
  assert.equal(a.calls.load, 2, 'null — не доказательство неизменности');

  const b = rig();
  await b.hub.listLocal();
  b.state.sigError = new Error('reg.exe не запустился');
  b.clock.t += 16_000;
  await b.hub.listLocal();
  assert.equal(b.calls.load, 2);
});

test('смена набора типов (включили COM) не отдаётся из кеша прежних типов', async () => {
  const types = ['net'];
  const loads = [];
  const { hub, calls, clock } = rig({ types, loads });
  await hub.listLocal();
  assert.deepEqual(loads[0], { ports: false, nets: true });
  types.push('com');
  clock.t += 16_000;
  const list = await hub.listLocal();
  assert.equal(calls.load, 2, 'набор изменился — отпечатка недостаточно');
  assert.deepEqual(loads[1], { ports: true, nets: true });
  assert.deepEqual(keys(list), ['COM3', 'Ethernet']);
});

test('сбой чтения оставляет прошлый список и не считается «устройств нет»; повтор — сразу', async () => {
  const { hub, calls, clock, state } = rig();
  await hub.listLocal();
  state.loadError = new Error('PowerShell завершился с кодом 1');
  state.sig = 'S2';
  clock.t += 16_000;
  const kept = await hub.listLocal();
  assert.deepEqual(keys(kept), ['COM3', 'Ethernet'], 'прежний список, а не пустой');
  assert.equal(hub.slowStats.failed, 1);

  state.loadError = null;
  state.ports = [port('COM3'), port('COM4')];
  const next = await hub.listLocal();
  assert.equal(calls.load, 3, 'после сбоя кеш не свеж: пробуем сразу');
  assert.deepEqual(keys(next), ['COM3', 'COM4', 'Ethernet']);
});

test('источник вернул null (сорвалась половина): его список сохраняется, второй обновляется', async () => {
  const clock = { t: 5_000_000 };
  let n = 0;
  const hub = new DeviceHub({
    backend: {},
    enabledTypes: () => ['com', 'net'],
    slow: {
      now: () => clock.t,
      signature: async () => null,
      load: async () => (++n === 1
        ? { ports: [port('COM3')], nets: [nic('Ethernet')] }
        : { ports: null, nets: [nic('Ethernet'), nic('Wi-Fi')] }),
    },
  });
  await hub.listLocal();
  clock.t += 16_000;
  const list = await hub.listLocal();
  assert.deepEqual(keys(list), ['COM3', 'Ethernet', 'Wi-Fi'], 'порты не стёрты, карты обновились');
});

test('срок полного чтения разбросан ±25%: одновременно запущенные хабы не читают в один момент', async () => {
  const dues = [];
  for (const r of [0, 0.5, 1]) {
    const clock = { t: 1_000_000 };
    const hub = new DeviceHub({
      backend: {},
      enabledTypes: () => ['com', 'net'],
      slow: { now: () => clock.t, random: () => r, signature: async () => 'S', load: async () => ({ ports: [], nets: [] }) },
    });
    await hub.listLocal();
    dues.push(hub._slow.fullDue - clock.t);
  }
  assert.deepEqual(dues, [225_000, 300_000, 375_000]);
});

test('параллельные опросы делят одно чтение', async () => {
  const { hub, calls } = rig();
  await Promise.all([hub.listLocal(), hub.listLocal(), hub.listLocal()]);
  assert.equal(calls.load, 1);
});

test('сто опросов за час: тяжёлых чтений — десятки, а не сотни', async () => {
  const { hub, calls, clock } = rig();
  for (let i = 0; i < 240; i++) {
    await hub.listLocal();
    clock.t += 15_000;
  }
  assert.equal(calls.load, 12, 'час при полном перечитывании раз в 300 с');
  assert.ok(hub.slowStats.skipped >= 220);
});

// ------------------------------------------------------------ разбор и признак

test('portsFromPnp разбирает COM и LPT по скобкам в названии', () => {
  const out = portsFromPnp([
    { FriendlyName: 'USB-SERIAL CH340 (COM19)', InstanceId: 'USB\\VID_1A86&PID_7523\\5&1', Status: 'OK' },
    { FriendlyName: 'Printer Port (LPT1)', InstanceId: 'ACPI\\PNP0400\\1', Status: 'OK' },
    { FriendlyName: 'Без порта в названии', InstanceId: 'X', Status: 'OK' },
  ]);
  assert.deepEqual(out.map((p) => p.key), ['COM19', 'LPT1']);
  assert.equal(out[0].details.viaUsb, true);
});

test('netsFromAdapters прячет служебные TAP и мост, оставляет настоящую карту', () => {
  const out = netsFromAdapters([
    { Name: 'Ethernet', InterfaceDescription: 'Intel Gigabit', InterfaceGuid: '{A}', Status: 'Up', MacAddress: '00-11', Virtual: false, ComponentID: 'pci', HardwareInterface: true, NdisPhysicalMedium: 14 },
    { Name: 'NDS мост', InterfaceDescription: 'TAP-Windows Adapter V9', InterfaceGuid: '{B}', ComponentID: 'tap0901' },
    { Name: 'Сетевой мост', InterfaceDescription: 'Microsoft Network Adapter Multiplexor Driver', InterfaceGuid: '{C}', ComponentID: 'ms_implat' },
  ]);
  assert.deepEqual(out.map((n) => n.title), ['Ethernet']);
  assert.equal(out[0].details.hardware, true);
});

test('netSignature стабилен между вызовами и не зависит от порядка', () => {
  assert.equal(netSignature(), netSignature());
  assert.equal(typeof netSignature(), 'string');
});

test('настоящий опрос Windows: один запуск возвращает оба списка, отпечаток читается без PowerShell', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const sig = await slowSignature({ ports: true, nets: true });
  assert.equal(typeof sig, 'string', 'reg.exe и интерфейсы дали отпечаток');
  assert.equal(sig, await slowSignature({ ports: true, nets: true }), 'без перемен отпечаток тот же');

  const r = await listPortsAndNets({ ports: true, nets: true });
  assert.ok(Array.isArray(r.ports), 'порты — список');
  assert.ok(Array.isArray(r.nets) && r.nets.length > 0, 'сетевые интерфейсы есть');
  assert.ok(r.nets.every((n) => n.type === 'net' && n.deviceId.startsWith('net:')));
  assert.ok(r.ports.every((p) => /^(com|lpt)$/.test(p.type)));
});

test('склейка JSON в PowerShell: список из 0, 1 и 2 элементов остаётся списком', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const { psJson } = await import('../src/devices/backend.js');
  const item = (n) => `[pscustomobject]@{ FriendlyName = 'Порт ${n} (COM${n})'; InstanceId = 'X${n}'; Status = 'OK' }`;
  const script = `$a = @(); $b = @(${item(1)}); $c = @(${item(1)}, ${item(2)}); `
    + '$aj = ConvertTo-Json -InputObject $a -Compress -Depth 3; $bj = ConvertTo-Json -InputObject $b -Compress -Depth 3; '
    + '$cj = ConvertTo-Json -InputObject $c -Compress -Depth 3; '
    + '\'{"a":\' + $aj + \',"b":\' + $bj + \',"c":\' + $cj + \'}\'';
  const [r] = await psJson(script, { strict: true });
  assert.deepEqual(r.a, []);
  assert.ok(Array.isArray(r.b) && r.b.length === 1, 'один элемент не должен «разворачиваться» в объект');
  assert.equal(r.c.length, 2);
  assert.deepEqual(portsFromPnp(r.c).map((p) => p.key), ['COM1', 'COM2']);
  assert.equal(portsFromPnp(r.b)[0].description, 'Порт 1', 'кириллица доехала');
});

test('отдельный опрос одного источника по-прежнему работает', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const onlyNets = await listPortsAndNets({ ports: false, nets: true });
  assert.deepEqual(onlyNets.ports, []);
  assert.ok(onlyNets.nets.length > 0);
});
