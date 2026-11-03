// Языки веб-интерфейса — ключевая схема.
//
// Шаблоны app.js/net.js и разметка index.html ссылаются на ключи
// (t('app.device.take'), data-i18n="ui.tab.nodes"), словари
// src/ui/i18n/<код>.js хранят переводы для всех языков, включая русский.
// Русская фраза правится в одном месте — ru.js, шаблоны не трогаются.
// Цепочка t(): словарь выбранного языка → ru → сам ключ.
//
// Выбор языка живёт в localStorage, по умолчанию английский. Смена языка
// перезагружает страницу.

import en from './i18n/en.js';
import ru from './i18n/ru.js';

const LANGS = {
  en: 'English',
  ru: 'Русский',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  'es-MX': 'Español (Latinoamérica)',
  it: 'Italiano',
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português',
  nl: 'Nederlands',
  pl: 'Polski',
  tr: 'Türkçe',
  sv: 'Svenska',
  nb: 'Norsk bokmål',
  da: 'Dansk',
  fi: 'Suomi',
  uk: 'Українська',
  ar: 'العربية',
  hi: 'हिन्दी',
  bn: 'বাংলা',
  id: 'Bahasa Indonesia',
  ms: 'Bahasa Melayu',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  fil: 'Filipino',
  sw: 'Kiswahili',
};
const RTL = new Set(['ar']);

const dicts = { en, ru };

function isLang(code) {
  return typeof code === 'string' && Object.hasOwn(LANGS, code);
}

/** Реестр для переключателя языка в шапке. */
export function languages() {
  return Object.entries(LANGS).map(([code, name]) => ({ code, name, dir: RTL.has(code) ? 'rtl' : 'ltr' }));
}

let lang = 'en';
try {
  const saved = localStorage.getItem('nds-lang');
  lang = isLang(saved) ? saved : 'en';
} catch { /* приватный режим — просто язык по умолчанию */ }

export function getLang() {
  return lang;
}

/**
 * Сменить язык. Перезагрузка нужна потому, что перерисовка из шаблонов
 * при живом интерфейсе дороже и рискованнее, чем один новый запрос.
 */
export function setLang(next) {
  if (isLang(next)) {
    try {
      localStorage.setItem('nds-lang', next);
    } catch { /* приватный режим — язык доживёт до перезагрузки */ }
  }
  location.reload();
}

// hasOwn: ключ вроде 'constructor' не должен вытянуть метод прототипа.
function pick(dict, key) {
  return dict && Object.hasOwn(dict, key) ? dict[key] : undefined;
}

/** Перевод по ключу с подстановкой {токенов}. */
export function t(key, params) {
  const text = pick(dicts[lang], key) ?? pick(dicts.ru, key) ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+(?:\.\w+)*)\}/g, (token, name) => (
    (() => {
      const v = Object.hasOwn(params, name) ? params[name] : name.includes('.') && Object.hasOwn(params, name.split('.').pop()) ? params[name.split('.').pop()] : null;
      return v != null ? String(v) : token;
    })()
  ));
}

/**
 * Перевести серверную ошибку по коду srv.*.
 * Приоритет у srvCode (CAPS-код для перевода), затем legacy code.
 * Иначе возвращает err.message или строковое представление.
 */
export function srv(err) {
  const c = err && (err.srvCode || err.code);
  if (c) {
    const key = 'srv.' + c;
    const known = pick(dicts[lang], key) ?? pick(dicts.ru, key);
    if (known !== undefined) return t(key, err.params);
  }
  return (err && err.message) || String(err);
}

/** Ключи из разметки: data-i18n="ключ" и data-i18n-placeholder/title/aria-label. */
function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  }
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      const key = el.getAttribute(`data-i18n-${attr}`);
      if (key) el.setAttribute(attr, t(key));
    }
  }
}

/** Загрузить словарь выбранного языка, выставить lang/dir, перевести разметку. */
export async function startI18n() {
  if (!dicts[lang]) {
    try {
      dicts[lang] = (await import('./i18n/' + lang + '.js')).default;
    } catch {
      lang = 'en';
    }
  }
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
  applyStatic();
}
