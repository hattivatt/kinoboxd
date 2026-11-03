'use strict';

/**
 * TMDB document helpers of the films stats payload (S3 split): genre
 * classification, collection-name cleanup, localized country labels and the
 * director/animation heuristics.
 */

const { normalizeKeyword } = require('../taxonomy');
const {
  HIDDEN_GENRE_IDS,
  HIDDEN_GENRE_NAMES,
  MUSIC_GENRE_ID,
  MUSIC_GENRE_NAMES,
} = require('./constants');

function isMusicGenre(genre) {
  if (!genre) return false;
  if (Number(genre.id) === MUSIC_GENRE_ID) return true;
  return MUSIC_GENRE_NAMES.has(normalizeKeyword(genre.name));
}

function isHiddenGenre(genre) {
  if (!genre) return false;
  if (HIDDEN_GENRE_IDS.has(Number(genre.id))) return true;
  return HIDDEN_GENRE_NAMES.has(String(genre.name || '').trim().toLowerCase());
}


/* TMDB localizes collection names as "Гарри Поттер (Коллекция)" (or
 * "(Collection)", "(Mcu Collect)", "(Сборник)"). The suffix is distribution
 * metadata, not part of the franchise title: strip one or more trailing
 * bracket groups that contain a collection word. The grouping key is the
 * collection id, so two collections that clean to the same display name stay
 * separate. Russian endings are spelled out so "(Коллекционер)" — a film
 * title, not a suffix — is left alone. */
const COLLECTION_SUFFIX_RE = /\s*[\(\[\{][^\(\)\[\]\{\}]*(?:\bcollect(?:ion)?\b|коллекци[яиюей]|сборник[а-яё]*)[^\(\)\[\]\{\}]*[\)\]\}]\s*$/iu;
const BARE_COLLECTION_SUFFIX_RE = /\s+(?:collection|collect|коллекци[яиюей]|сборник[а-яё]*)\s*$/iu;

function cleanCollectionName(name) {
  const original = String(name == null ? '' : name).trim();
  let value = original;
  for (let i = 0; i < 3; i++) {
    const next = value.replace(COLLECTION_SUFFIX_RE, '').trim();
    if (next === value) break;
    value = next;
  }
  // Localized names also occur without brackets ("X Коллекция",
  // "Шерлок Холмс (Роберт Дауни мл.) Коллекция"); the same word at the very
  // end is distribution metadata too.
  value = value.replace(BARE_COLLECTION_SUFFIX_RE, '').trim();
  return value || original;
}

const COUNTRY_RU = {
  AD: 'Андорра',
  AE: 'ОАЭ',
  AF: 'Афганистан',
  AL: 'Албания',
  AM: 'Армения',
  AN: 'Нидерландские Антильские острова',
  AR: 'Аргентина',
  AT: 'Австрия',
  AU: 'Австралия',
  AZ: 'Азербайджан',
  BA: 'Босния и Герцеговина',
  BD: 'Бангладеш',
  BE: 'Бельгия',
  BG: 'Болгария',
  BO: 'Боливия',
  BR: 'Бразилия',
  BY: 'Беларусь',
  CA: 'Канада',
  CH: 'Швейцария',
  CL: 'Чили',
  CN: 'Китай',
  CO: 'Колумбия',
  CR: 'Коста-Рика',
  CS: 'Сербия и Черногория',
  CU: 'Куба',
  CY: 'Кипр',
  CZ: 'Чехия',
  DE: 'Германия',
  DK: 'Дания',
  DO: 'Доминикана',
  DZ: 'Алжир',
  EC: 'Эквадор',
  EE: 'Эстония',
  EG: 'Египет',
  ES: 'Испания',
  ET: 'Эфиопия',
  FI: 'Финляндия',
  FR: 'Франция',
  GB: 'Великобритания',
  GE: 'Грузия',
  GR: 'Греция',
  GT: 'Гватемала',
  HK: 'Гонконг',
  HR: 'Хорватия',
  HU: 'Венгрия',
  ID: 'Индонезия',
  IE: 'Ирландия',
  IL: 'Израиль',
  IN: 'Индия',
  IQ: 'Ирак',
  IR: 'Иран',
  IS: 'Исландия',
  IT: 'Италия',
  JM: 'Ямайка',
  JO: 'Иордания',
  JP: 'Япония',
  KE: 'Кения',
  KG: 'Киргизия',
  KH: 'Камбоджа',
  KR: 'Южная Корея',
  KW: 'Кувейт',
  KZ: 'Казахстан',
  LB: 'Ливан',
  LK: 'Шри-Ланка',
  LT: 'Литва',
  LU: 'Люксембург',
  LV: 'Латвия',
  MA: 'Марокко',
  MC: 'Монако',
  MD: 'Молдавия',
  ME: 'Черногория',
  MK: 'Македония',
  MN: 'Монголия',
  MT: 'Мальта',
  MX: 'Мексика',
  MY: 'Малайзия',
  NG: 'Нигерия',
  NL: 'Нидерланды',
  NO: 'Норвегия',
  NP: 'Непал',
  NZ: 'Новая Зеландия',
  PA: 'Панама',
  PE: 'Перу',
  PH: 'Филиппины',
  PK: 'Пакистан',
  PL: 'Польша',
  PR: 'Пуэрто-Рико',
  PT: 'Португалия',
  PY: 'Парагвай',
  QA: 'Катар',
  RO: 'Румыния',
  RS: 'Сербия',
  RU: 'Россия',
  SA: 'Саудовская Аравия',
  SE: 'Швеция',
  SG: 'Сингапур',
  SI: 'Словения',
  SK: 'Словакия',
  SN: 'Сенегал',
  SU: 'СССР',
  SV: 'Сальвадор',
  SY: 'Сирия',
  TH: 'Таиланд',
  TJ: 'Таджикистан',
  TM: 'Туркмения',
  TN: 'Тунис',
  TR: 'Турция',
  TT: 'Тринидад и Тобаго',
  TW: 'Тайвань',
  UA: 'Украина',
  US: 'США',
  UY: 'Уругвай',
  UZ: 'Узбекистан',
  VA: 'Ватикан',
  VE: 'Венесуэла',
  VN: 'Вьетнам',
  XC: 'Чехословакия',
  XG: 'ГДР',
  XK: 'Косово',
  YU: 'Югославия',
  ZA: 'ЮАР',
  ZW: 'Зимбабве',
};

const CYRILLIC_RE = /[а-яё]/i;

function localizedCountryName(country) {
  const iso = String((country && country.iso_3166_1) || '').toUpperCase();
  const name = String((country && country.name) || '').trim();
  if (iso && COUNTRY_RU[iso]) return COUNTRY_RU[iso];
  if (CYRILLIC_RE.test(name)) return name;
  return name || iso || null;
}

/** Deduped list of localized country names for a matched film. */
function filmCountries(details) {
  const list =
    details && Array.isArray(details.production_countries)
      ? details.production_countries
      : [];
  const out = [];
  const seen = new Set();
  for (const country of list) {
    const name = localizedCountryName(country);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * ISO-3166-1 codes from TMDB production_countries. Kept separate from the
 * localized `filmCountries` payload: the period heuristics need codes
 * (e.g. "SU" for Soviet films), while the dashboard displays Russian names.
 */
function productionCountryCodes(details) {
  const list =
    details && Array.isArray(details.production_countries)
      ? details.production_countries
      : [];
  const out = [];
  const seen = new Set();
  for (const country of list) {
    const code = String((country && country.iso_3166_1) || '').toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** Names of credited directors (TMDB crew job is exactly "Director"). */
function crewDirectorNames(credits) {
  const list = credits && Array.isArray(credits.crew) ? credits.crew : [];
  const out = [];
  const seen = new Set();
  for (const role of list) {
    if (!role || role.job !== 'Director') continue;
    const name = String(role.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function isAnimation(details) {
  const genres = (details && details.genres) || [];
  return genres.some(
    (g) =>
      g.id === 16 ||
      /^(animation|анимация)$/i.test(String(g.name || '').trim())
  );
}

module.exports = {
  cleanCollectionName,
  isMusicGenre,
  isHiddenGenre,
  localizedCountryName,
  filmCountries,
  productionCountryCodes,
  crewDirectorNames,
  isAnimation,
};
