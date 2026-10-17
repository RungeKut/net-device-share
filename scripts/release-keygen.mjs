#!/usr/bin/env node
// Создание ключа подписи релизов (Ed25519).
//
//   node scripts/release-keygen.mjs --id k1                 рабочий ключ
//   node scripts/release-keygen.mjs --id k2                 запасной ключ
//   node scripts/release-keygen.mjs --id t1 --test --out <каталог>   тестовый (канал test)
//
// Закрытая часть пишется вне репозитория (по умолчанию в
// ~/.net-device-share-signing/<id>.pem) и НЕ должна попасть в git. Если задана
// переменная NDS_SIGNING_PASS, файл шифруется этим паролем.
// Открытая часть для рабочих ключей вносится в launcher/lib/keys.js между
// метками BEGIN KEYS / END KEYS: именно этот список — корень доверия.
//
// Запасной ключ после создания перенесите с компьютера сборки на отдельный
// носитель: он нужен только на случай потери или компрометации рабочего.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};

const id = opt('id', null);
if (!id || !/^[A-Za-z0-9_-]{1,16}$/.test(id)) {
  process.stderr.write('Нужен --id (буквы, цифры, - и _; до 16 знаков), например --id k1\n');
  process.exit(2);
}
const isTest = args.includes('--test');
const outDir = path.resolve(opt('out', path.join(os.homedir(), '.net-device-share-signing')));
const pass = process.env.NDS_SIGNING_PASS || undefined;

const privFile = path.join(outDir, `${id}.pem`);
if (fs.existsSync(privFile)) {
  process.stderr.write(`Ключ ${privFile} уже существует — не перезаписываю. Выберите другой --id или удалите файл.\n`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: pass
    ? { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: pass }
    : { type: 'pkcs8', format: 'pem' },
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(privFile, privateKey, { mode: 0o600 });
fs.writeFileSync(path.join(outDir, `${id}.pub.pem`), publicKey);

process.stdout.write(`Закрытый ключ: ${privFile}${pass ? ' (зашифрован паролем из NDS_SIGNING_PASS)' : ' (БЕЗ пароля — задайте NDS_SIGNING_PASS при следующем ключе)'}\n`);
process.stdout.write(`Открытый ключ: ${path.join(outDir, `${id}.pub.pem`)}\n`);

if (!isTest) {
  const file = path.join(ROOT, 'launcher', 'lib', 'keys.js');
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = /(\/\/ BEGIN KEYS\n)([\s\S]*?)(\/\/ END KEYS)/.exec(text);
  if (!m) throw new Error('в launcher/lib/keys.js нет меток BEGIN KEYS / END KEYS');
  const existing = [...m[2].matchAll(/keyId: '([^']+)'/g)].map((x) => x[1]);
  if (existing.includes(id)) throw new Error(`ключ ${id} уже есть в keys.js`);
  // Уже внесённые записи переносим как есть: каждая — от «  {» до «  },».
  const entries = (m[2].match(/^ {2}\{[\s\S]*?^ {2}\},?\n/gm) || []).join('');
  const entry = `  {\n    keyId: '${id}',\n    channels: ['stable'],\n    publicKey: \`${publicKey}\`,\n  },\n`;
  const block = `export const TRUSTED_KEYS = [\n${entries}${entry}];\n`;
  fs.writeFileSync(file, text.replace(m[0], `${m[1]}${block}${m[3]}`));
  process.stdout.write(`Открытый ключ внесён в launcher/lib/keys.js (${[...existing, id].join(', ')}).\n`);
}
