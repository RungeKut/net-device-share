// Круги доверия узла.
//
// Раньше круг был один: либо общий ключ задан, либо нет. Теперь узел может
// состоять сразу в нескольких — например, «Цех» и «Лаборатория» — и в каждом
// его видят только те, у кого тот же ключ.
//
// ОТКРЫТЫЙ КРУГ — это такой же круг, просто без ключа. Он не «отсутствие
// защиты», а отдельная сеть, в которой узел может участвовать наравне с
// ключевыми. Участие в нём распадается на две независимые половины:
//
//   seeOpen     — принимаем анонсы узлов без ключа, то есть ВИДИМ их;
//   showToOpen  — рассылаем анонс без подписи, то есть они видят НАС.
//
// Все четыре сочетания осмысленны:
//
//   обе выключены — узел полностью скрыт от тех, у кого ключа нет;
//   только seeOpen — пользуемся их устройствами, себя не показываем;
//   только showToOpen — отдаём свои устройства всем, чужих не показываем;
//   обе включены — как было до появления ключей.
//
// ПОЧЕМУ ПОРЯДОК ПРОВЕРКИ ВАЖЕН. Проверка подписи пустым ключом принимает
// что угодно, поэтому открытый круг, если пробовать его первым, перехватывал
// бы сообщения из всех чужих ключевых сетей. Ключевые круги пробуются
// первыми, а открытый принимает только то, что подписи вовсе не несёт.

import { realmOf, verify } from './protocol.js';

export const OPEN_REALM = 'open';

/** Название открытого круга. Своего имени у него быть не может: он общий. */
export const OPEN_LABEL = 'без ключа';

const OPEN_ENTRY = Object.freeze({
  id: OPEN_REALM,
  realm: OPEN_REALM,
  key: '',
  label: OPEN_LABEL,
  open: true,
});

export class Realms {
  constructor(config) {
    this.config = config;
  }

  get seeOpen() {
    return this.config.get('seeOpen') !== false;
  }

  get showToOpen() {
    return this.config.get('showToOpen') !== false;
  }

  /** Ключевые сети из настроек, каждая со своим отпечатком. */
  keyed() {
    const out = [];

    // Ключ из «--key»: только на текущий запуск, в настройках его нет.
    // Нужен для отладки и приёмочных проверок, где заводить сеть в
    // интерфейсе неудобно.
    const cli = this.config.get('preSharedKey');
    if (typeof cli === 'string' && cli.trim()) {
      out.push({
        id: 'cli', key: cli.trim(), label: 'ключ из командной строки',
        realm: realmOf(cli.trim()), open: false,
      });
    }

    return out.concat((this.config.get('networks') || [])
      .filter((n) => n && n.key)
      .map((n) => ({
        id: n.id,
        key: n.key,
        label: n.label || 'сеть без названия',
        realm: realmOf(n.key),
        open: false,
      })));
  }

  /** Круги, в которых мы объявляем о себе. */
  announcing() {
    const out = this.keyed();
    if (this.showToOpen) out.push(OPEN_ENTRY);
    return out;
  }

  /** Круги, чьи анонсы мы принимаем. */
  listening() {
    const out = this.keyed();
    if (this.seeOpen) out.push(OPEN_ENTRY);
    return out;
  }

  /**
   * Круги, чьи вызовы HTTP мы обслуживаем.
   *
   * Шире, чем listening: тот, кому мы объявились, будет к нам обращаться —
   * занимать устройства, продлевать аренду, сообщать об отзыве. Отказывать
   * ему значило бы показать устройство и не дать им воспользоваться.
   */
  serving() {
    const out = this.keyed();
    if (this.seeOpen || this.showToOpen) out.push(OPEN_ENTRY);
    return out;
  }

  /** Ключ круга или undefined, если круг нам чужой. */
  keyFor(realm, scope = 'serving') {
    return this[scope]().find((r) => r.realm === realm)?.key;
  }

  /** Человеческое название круга — для списка узлов. */
  labelFor(realm) {
    if (realm === OPEN_REALM) return OPEN_LABEL;
    return this.keyed().find((r) => r.realm === realm)?.label || null;
  }

  /**
   * Круг, в котором мы разговариваем сами с собой.
   *
   * Занятие собственного устройства идёт тем же путём по HTTP, что и чужого,
   * поэтому подписать такой вызов нужно ключом, который мы же и примем.
   */
  self() {
    const keyed = this.keyed();
    if (keyed.length) return keyed[0];
    return this.seeOpen || this.showToOpen ? OPEN_ENTRY : null;
  }

  /**
   * Какому нашему кругу принадлежит подписанное сообщение.
   *
   * @returns {object|null} круг или null, если ни одному
   */
  match(payload, signature) {
    for (const r of this.keyed()) {
      if (verify(payload, signature, r.key)) return r;
    }
    if (signature) return null; // подпись есть, но ни один ключ не подошёл
    return this.serving().find((r) => r.open) || null;
  }

  /** Для интерфейса: чем мы сейчас являемся, без самих ключей. */
  describe() {
    return {
      networks: this.keyed().map(({ id, label, realm }) => ({ id, label, realm })),
      seeOpen: this.seeOpen,
      showToOpen: this.showToOpen,
      // Ни в одном круге — узел никого не видит и никому не виден.
      isolated: !this.keyed().length && !this.seeOpen && !this.showToOpen,
    };
  }
}
