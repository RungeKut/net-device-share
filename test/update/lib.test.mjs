// Проверки библиотеки обновления: tar, релиз, подпись, раскладка.
//   node --test test/update/

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { packTar, unpackTar, pathProblem, gzip } from '../../launcher/lib/tar.js';
import { compareVersions, isVersion } from '../../launcher/lib/semver.js';
import {
  buildRelease, verifyManifest, verifyPayload, compatProblem, packBundle, unpackBundle, ReleaseError,
} from '../../launcher/lib/release.js';
import {
  installRelease, verifyInstalled, restoreFromArchive, readState, updateState, listInstalled, prune,
  appDir, badKey,
} from '../../launcher/lib/layout.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const other = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEYS = [{ keyId: 'k1', publicKey, channels: ['stable'] }];

const files = () => [
  { path: 'src/main.js', data: Buffer.from('console.log(1)\n') },
  { path: 'src/ui/index.html', data: Buffer.from('<html></html>') },
  { path: 'package.json', data: Buffer.from('{"version":"9.9.9"}') },
  { path: 'a/very/' + 'long/'.repeat(30) + 'file.txt', data: Buffer.from('длинный путь') },
];
const make = (over = {}) => buildRelease({
  files: files(), version: '2.1.0', keyId: 'k1', privateKey, built: '2026-01-01T00:00:00.000Z', ...over,
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nds-test-'));

test('semver: порядок и мусор', () => {
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('2.0.1', '2.0.0'), 1);
  assert.equal(compareVersions('2.10.0', '2.9.0'), 1);
  assert.equal(compareVersions('2.1.0-rc1', '2.1.0'), -1);
  assert.equal(compareVersions('2.1.0-rc.2', '2.1.0-rc.10'), -1);
  assert.equal(isVersion('2.1'), false);
  assert.throws(() => compareVersions('x', '1.0.0'));
});

test('tar: круг и длинные пути, воспроизводимость', () => {
  const a = packTar(files());
  const b = packTar([...files()].reverse());
  assert.deepEqual(a, b, 'порядок входных файлов не влияет на байты');
  const back = unpackTar(a);
  assert.equal(back.length, 4);
  const long = back.find((e) => e.path.endsWith('file.txt'));
  assert.equal(long.data.toString(), 'длинный путь');
});

test('tar: нечитаемое отвергается', () => {
  for (const bad of ['../x', '/abs', 'C:/x', 'a\\b', 'a//b', 'CON', 'dir/nul.txt', 'a/./b', 'x.', 'bad:name']) {
    assert.ok(pathProblem(bad), `должен быть отказ для ${bad}`);
  }
  assert.equal(pathProblem('src/ok.js'), null);
  assert.throws(() => packTar([{ path: '../evil', data: Buffer.from('x') }]));

  const t = packTar([{ path: 'a.txt', data: Buffer.from('hello') }]);
  const broken = Buffer.from(t);
  broken[10] ^= 0xff;                                   // портим заголовок
  assert.throws(() => unpackTar(broken), /контрольная сумма/);

  const dup = packTar([{ path: 'A.txt', data: Buffer.from('1') }, { path: 'b.txt', data: Buffer.from('2') }]);
  // «A.txt» и «a.txt» — один файл для Windows
  const clash = Buffer.concat([dup.subarray(0, dup.length - 1024), packTar([{ path: 'a.txt', data: Buffer.from('3') }])]);
  assert.throws(() => unpackTar(clash), /повторяющийся/);

  const link = Buffer.from(packTar([{ path: 'l', data: Buffer.alloc(0) }]));
  link[156] = '2'.charCodeAt(0);                         // символическая ссылка
  let sum = 0; link.fill(0x20, 148, 156); for (let i = 0; i < 512; i++) sum += link[i];
  link.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  assert.throws(() => unpackTar(link), /недопустимый тип/);
});

test('релиз: сборка воспроизводима, проверка проходит', () => {
  const r1 = make();
  const r2 = make();
  assert.deepEqual(r1.manifestBytes, r2.manifestBytes);
  assert.deepEqual(r1.payload, r2.payload);
  const manifest = verifyManifest(r1.manifestBytes, r1.sig, KEYS);
  assert.equal(manifest.version, '2.1.0');
  const entries = verifyPayload(r1.payload, manifest);
  assert.equal(entries.length, 4);
});

test('релиз: подделки отвергаются', () => {
  const r = make();

  // чужая подпись
  const foreign = crypto.sign(null, r.manifestBytes, crypto.createPrivateKey(other.privateKey));
  assert.throws(() => verifyManifest(r.manifestBytes, foreign, KEYS), (e) => e.code === 'bad_signature');

  // изменён манифест
  const tampered = Buffer.from(r.manifestBytes.toString().replace('2.1.0', '2.1.1'));
  assert.throws(() => verifyManifest(tampered, r.sig, KEYS), (e) => e.code === 'bad_signature');

  // неизвестный ключ и неподходящий канал
  assert.throws(() => verifyManifest(r.manifestBytes, r.sig, []), (e) => e.code === 'unknown_key');
  const test = make({ channel: 'test' });
  assert.throws(() => verifyManifest(test.manifestBytes, test.sig, KEYS), (e) => e.code === 'bad_channel');

  // подмена нагрузки при верном манифесте
  const manifest = verifyManifest(r.manifestBytes, r.sig, KEYS);
  const evil = gzip(packTar([{ path: 'src/main.js', data: Buffer.from('evil') }]));
  assert.throws(() => verifyPayload(evil, manifest), ReleaseError);
  const flipped = Buffer.from(r.payload);
  flipped[flipped.length - 20] ^= 1;
  assert.throws(() => verifyPayload(flipped, manifest), ReleaseError);

  // нагрузка с верными суммами файлов, но лишним файлом: размер и sha нагрузки не сойдутся
  const extra = gzip(packTar([...files(), { path: 'src/extra.js', data: Buffer.from('x') }]));
  assert.throws(() => verifyPayload(extra, manifest), ReleaseError);
});

test('релиз: gzip-бомба не раздувается', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(300 * 1024 * 1024));
  const manifest = { payload: { size: bomb.length, sha256: crypto.createHash('sha256').update(bomb).digest('hex') }, files: [{ path: 'a', sha256: '0', size: 0 }] };
  assert.throws(() => verifyPayload(bomb, manifest), ReleaseError);
});

test('совместимость: лаунчер, Node, платформа', () => {
  const m = verifyManifest(make().manifestBytes, make().sig, KEYS);
  assert.equal(compatProblem(m), null);
  assert.match(compatProblem({ compat: { minLauncher: 99 } }), /установщик/);
  assert.match(compatProblem({ compat: { minNode: '99.0.0' } }), /Node/);
  assert.match(compatProblem({ compat: { platforms: ['darwin'] } }, { platform: 'win32' }), /не предназначена/);
});

test('файл .ndsupd: круг', () => {
  const r = make();
  const back = unpackBundle(packBundle(r));
  assert.deepEqual(back.manifestBytes, r.manifestBytes);
  assert.deepEqual(back.sig, r.sig);
  assert.deepEqual(back.payload, r.payload);
});

test('установка, проверка целостности и самовосстановление', () => {
  const base = tmp();
  const r = make();
  installRelease(base, r, KEYS);
  assert.deepEqual(listInstalled(base), ['2.1.0']);
  assert.equal(verifyInstalled(base, '2.1.0', KEYS).ok, true);

  // испортили файл → не цела → починили из архива
  fs.writeFileSync(path.join(appDir(base, '2.1.0'), 'src', 'main.js'), 'tampered');
  const bad = verifyInstalled(base, '2.1.0', KEYS);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /изменён/);
  restoreFromArchive(base, '2.1.0', KEYS);
  assert.equal(verifyInstalled(base, '2.1.0', KEYS).ok, true);

  // лишний файл тоже нарушение
  fs.writeFileSync(path.join(appDir(base, '2.1.0'), 'src', 'stray.js'), 'x');
  assert.match(verifyInstalled(base, '2.1.0', KEYS).reason, /лишний/);

  // подпись чужим ключом — нет
  assert.equal(verifyInstalled(base, '2.1.0', [{ keyId: 'k1', publicKey: other.publicKey, channels: ['stable'] }]).ok, false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('очистка старых версий и состояние', () => {
  const base = tmp();
  for (const v of ['2.0.0', '2.1.0', '2.2.0']) installRelease(base, make({ version: v }), KEYS);
  fs.mkdirSync(path.join(base, 'app', 'not-a-version'));
  assert.deepEqual(listInstalled(base), ['2.0.0', '2.1.0', '2.2.0']);
  prune(base, ['2.1.0', '2.2.0']);
  assert.deepEqual(listInstalled(base), ['2.1.0', '2.2.0']);
  assert.ok(fs.existsSync(path.join(base, 'app', 'not-a-version')), 'чужое не трогаем');
  assert.ok(!fs.existsSync(path.join(base, 'releases', '2.0.0')));

  const home = tmp();
  assert.equal(readState(home).current, null);
  updateState(home, (s) => { s.current = '2.1.0'; s.bad[badKey('2.2.0', 'abcdef123')] = { reason: 'x' }; });
  const s = readState(home);
  assert.equal(s.current, '2.1.0');
  assert.ok(s.bad['2.2.0|abcdef12']);
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
