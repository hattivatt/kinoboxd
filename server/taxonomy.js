'use strict';

/*
 * Keyword-based film taxonomy.
 *
 * TMDB keywords are not a controlled vocabulary: the same idea is spelled
 * "neo-noir", "neo noir" or "neonoir", and loose substring matching would
 * drag in unrelated tags ("musical number", "anime inspired", "tech noir").
 * Every rule below therefore matches a NORMALIZED keyword name exactly.
 *
 * Normalization: lowercase, ё -> е, hyphens/dashes/ampersands become spaces,
 * repeated whitespace collapses. Thus "Neo-Noir", "neo noir" and "NEO NOIR"
 * all become "neo noir", while "musical number" stays a different token and
 * is not picked up by the "musical" rule.
 *
 * The corpus used to pick aliases is the local TMDB cache (2618 films), see
 * the round-2 report for the observed frequencies. Aliases with zero hits are
 * intentionally kept: TMDB may add them later.
 */

function normalizeKeyword(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/&/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */

const CATEGORY_DEFS = [
  { key: 'musical', name: 'Мюзикл', aliases: ['musical'] },
  { key: 'film-noir', name: 'Фильм-нуар', aliases: ['film noir'] },
  { key: 'neo-noir', name: 'Нео-нуар', aliases: ['neo noir', 'neonoir'] },
  {
    key: 'arthouse',
    name: 'Артхаус',
    aliases: ['art house', 'art house film', 'arthouse', 'art film'],
  },
  { key: 'anime', name: 'Аниме', aliases: ['anime'] },
  // Animation is genre-based (TMDB genre 16) and excludes anime films; it has
  // no keyword aliases on purpose. The raw TMDB genre 16 is hidden from the
  // dashboard (see stats.js), so this derived bucket is the only "Мультфильмы"
  // entry. The key stays "animation" so existing sortScope/kicker handling is
  // unaffected; only the display name is localized.
  { key: 'animation', name: 'Мультфильмы', aliases: [], genreBased: true },
  {
    key: 'black-and-white',
    name: 'Чёрно-белые',
    aliases: ['black and white', 'black white', 'b w', 'bw'],
  },
  { key: 'silent', name: 'Немые', aliases: ['silent film', 'silent movie', 'silent'] },
];

/*
 * Origins are mutually exclusive. The first matching definition wins, in the
 * order below (remake > sequel > true story > book > comic > video game >
 * play). Anything left is an original screenplay.
 */
const ORIGIN_DEFS = [
  {
    key: 'remake',
    name: 'Ремейк',
    aliases: ['remake', 'live action remake', 'horror remake'],
  },
  { key: 'sequel', name: 'Сиквел', aliases: ['sequel'] },
  {
    key: 'true-story',
    name: 'Реальные события',
    aliases: ['based on true story', 'inspired by true events', 'true story'],
  },
  {
    key: 'book',
    name: 'По книге',
    aliases: [
      'based on novel',
      'based on book',
      'based on novella',
      'based on novel or book',
      'based on young adult novel',
      "based on children's book",
      'based on short story',
      'based on memoir or autobiography',
      'based on light novel',
      'based on web novel',
    ],
  },
  {
    key: 'comic',
    name: 'По комиксу',
    aliases: [
      'based on comic',
      'based on comic book',
      'graphic novel',
      'based on graphic novel',
      'based on manga',
      'based on manhwa',
      'based on webcomic or webtoon',
      'based on comic strip',
    ],
  },
  {
    key: 'video-game',
    name: 'По видеоигре',
    aliases: ['based on video game', 'videogame', 'based on game', 'based on visual novel'],
  },
  {
    key: 'play',
    name: 'По пьесе',
    aliases: ['based on play or musical', 'based on play', 'stage play'],
  },
];

const ORIGINAL_DEF = { key: 'original', name: 'Оригинальный сценарий' };

const PERIOD_DEFS = [
  { key: 'film-noir', name: 'Фильм-нуар', aliases: ['film noir'] },
  {
    key: 'german-expressionism',
    name: 'Немецкий экспрессионизм',
    aliases: ['german expressionism'],
  },
  {
    key: 'french-new-wave',
    name: 'Французская новая волна',
    aliases: ['french new wave', 'nouvelle vague'],
  },
  {
    key: 'italian-neorealism',
    name: 'Итальянский неореализм',
    aliases: ['italian neorealism', 'italian neo realism', 'neorealism', 'neo realism'],
  },
  {
    key: 'japanese-new-wave',
    name: 'Японская новая волна',
    aliases: ['japanese new wave', 'nuberu bagu'],
  },
  {
    key: 'new-hollywood',
    name: 'Новая Голливуд',
    aliases: ['new hollywood', 'american new wave'],
  },
  { key: 'soviet-montage', name: 'Советский монтаж', aliases: ['soviet montage'] },
  // Dogme 95 исключён по решению пользователя: это закрытый манифест (~35
  // сертифицированных фильмов), в коллекции таких нет, а эвристика по фон
  // Триеру даёт ложный «Догвилль». Советский монтаж оставлен: сейчас 0
  // фильмов, но к нему вернёмся вместе с викиданными по советским периодам.
];

/* Pre-normalized alias sets: one Set per definition for O(1) lookups. */
function aliasSets(defs) {
  return defs.map((def) => ({
    def,
    aliases: new Set((def.aliases || []).map(normalizeKeyword).filter(Boolean)),
  }));
}

const CATEGORY_RULES = aliasSets(CATEGORY_DEFS);
const ORIGIN_RULES = aliasSets(ORIGIN_DEFS);
const PERIOD_RULES = aliasSets(PERIOD_DEFS);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function round2(value) {
  return Math.round(value * 100) / 100;
}

function isAnimationGenre(genres) {
  const list = Array.isArray(genres) ? genres : [];
  return list.some((genre) => {
    if (!genre || typeof genre !== 'object') return false;
    if (Number(genre.id) === 16) return true;
    const name = normalizeKeyword(genre.name);
    return name === 'animation' || name === 'анимация' || name === 'мультфильм';
  });
}

function keywordSetOf(keywords) {
  const set = new Set();
  const list = Array.isArray(keywords) ? keywords : [];
  for (const keyword of list) {
    if (!keyword) continue;
    const name = typeof keyword === 'string' ? keyword : keyword.name;
    const normalized = normalizeKeyword(name);
    if (normalized) set.add(normalized);
  }
  return set;
}

function matchesAlias(keywordSet, aliases) {
  for (const alias of aliases) {
    if (keywordSet.has(alias)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

function createBucket() {
  return { count: 0, ratingSum: 0, ratingCount: 0, films: [] };
}

function addToBucket(bucket, film) {
  bucket.count++;
  bucket.films.push(film.slug);
  if (film.rating !== null && film.rating !== undefined && Number.isFinite(Number(film.rating))) {
    bucket.ratingSum += Number(film.rating);
    bucket.ratingCount++;
  }
}

function serializeBuckets(defs, buckets, order) {
  const out = [];
  for (const def of defs) {
    const bucket = buckets.get(def.key);
    if (!bucket || bucket.count === 0) continue;
    out.push({
      key: def.key,
      name: def.name,
      count: bucket.count,
      avgRating: bucket.ratingCount > 0 ? round2(bucket.ratingSum / bucket.ratingCount) : null,
      films: bucket.films.slice().sort(),
    });
  }
  if (order === 'definition') return out;
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

/**
 * Classify one film.
 *
 * @param {{slug:string, rating?:number|null, genres?:Array, keywords?:Array}} film
 * @returns {{categories:string[], origin:string, periods:string[]}}
 */
function classifyFilm(film) {
  const keywordSet = keywordSetOf(film && film.keywords);
  const categories = [];

  for (const rule of CATEGORY_RULES) {
    if (rule.def.genreBased) continue;
    if (matchesAlias(keywordSet, rule.aliases)) categories.push(rule.def.key);
  }

  const anime = categories.includes('anime');
  const animationGenre = isAnimationGenre(film && film.genres);
  // "Мультфильмы" is the TMDB Animation genre minus anime. An anime title
  // without the Animation genre still counts as anime above; it is never
  // added here.
  if (animationGenre && !anime) categories.push('animation');

  let origin = ORIGINAL_DEF.key;
  for (const rule of ORIGIN_RULES) {
    if (matchesAlias(keywordSet, rule.aliases)) {
      origin = rule.def.key;
      break;
    }
  }

  const periods = [];
  for (const rule of PERIOD_RULES) {
    if (matchesAlias(keywordSet, rule.aliases)) periods.push(rule.def.key);
  }

  return { categories, origin, periods };
}

/**
 * Aggregate the taxonomy over every matched film.
 *
 * @param {Array<{slug:string, rating?:number|null, genres?:Array, keywords?:Array}>} films
 * @returns {{categories:Array, origins:Array, periods:Array}}
 */
function buildTaxonomy(films) {
  const categoryBuckets = new Map();
  const originBuckets = new Map();
  const periodBuckets = new Map();
  for (const def of CATEGORY_DEFS) categoryBuckets.set(def.key, createBucket());
  for (const def of ORIGIN_DEFS) originBuckets.set(def.key, createBucket());
  originBuckets.set(ORIGINAL_DEF.key, createBucket());
  for (const def of PERIOD_DEFS) periodBuckets.set(def.key, createBucket());

  for (const film of Array.isArray(films) ? films : []) {
    if (!film || !film.slug) continue;
    const classified = classifyFilm(film);
    for (const key of classified.categories) {
      addToBucket(categoryBuckets.get(key), film);
    }
    addToBucket(originBuckets.get(classified.origin), film);
    for (const key of classified.periods) {
      addToBucket(periodBuckets.get(key), film);
    }
  }

  return {
    categories: serializeBuckets(CATEGORY_DEFS, categoryBuckets, 'count'),
    // Origins keep the semantic priority order: the donut reads from
    // "Оригинальный сценарий" through the specific adaptations.
    origins: serializeBuckets(
      [...ORIGIN_DEFS, ORIGINAL_DEF],
      originBuckets,
      'definition'
    ),
    periods: serializeBuckets(PERIOD_DEFS, periodBuckets, 'count'),
  };
}

module.exports = {
  CATEGORY_DEFS,
  ORIGIN_DEFS,
  PERIOD_DEFS,
  normalizeKeyword,
  classifyFilm,
  buildTaxonomy,
};
