// Доверенные ключи подписи релизов.
//
// Список вшит и меняется только вместе с лаунчером (то есть установщиком):
// это корень доверия, и обновление по сети не должно уметь его заменять.
// Ключей два с первого дня. k1 — рабочий, k2 — запасной, его закрытая часть
// лежит вне компьютера сборки. Потерян или скомпрометирован k1 — выпускается
// версия, подписанная k2, и k1 из списка убирается новым установщиком.
//
// Список между метками правит scripts/release-keygen.mjs.

import fs from 'node:fs';

// BEGIN KEYS
export const TRUSTED_KEYS = [
  {
    keyId: 'k1',
    channels: ['stable'],
    publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAhbqYHKLUS+kxFuP7hxRq5P7uj+Zs1xhzN4DWXsE1/c8=
-----END PUBLIC KEY-----
`,
  },
  {
    keyId: 'k2',
    channels: ['stable'],
    publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEACyhURX6J7NVOfTzqFpF727Apn88eSQ9pFelqVWfFS8Q=
-----END PUBLIC KEY-----
`,
  },
];
// END KEYS

/**
 * Тестовый ключ для проверок на одной машине (два экземпляра на разных
 * портах). Подключается только переменной NDS_UPDATE_TEST_KEY с путём к
 * открытому ключу и вправе подписывать лишь канал «test» — релиз такого
 * канала рабочий ключ подписать не может, а тестовый ключ не может
 * подписать рабочий. Включение пишется в журнал громко.
 */
export function trustedKeys(env = process.env) {
  const keys = [...TRUSTED_KEYS];
  const testKeyFile = env.NDS_UPDATE_TEST_KEY;
  if (testKeyFile) {
    const pem = readTestKey(testKeyFile);
    if (pem) keys.push({ keyId: 'test', publicKey: pem, channels: ['test'] });
  }
  return keys;
}

function readTestKey(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
