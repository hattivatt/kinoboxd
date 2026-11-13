'use strict';

const { round2 } = require('./core/stats');
const {
  CATEGORY_DEFS,
  ORIGIN_DEFS,
  ORIGINAL_DEF,
  PERIOD_DEFS,
  DIRECTOR_DEFS,
  CATEGORY_RULES,
  ORIGIN_RULES,
  PERIOD_RULES,
  DIRECTOR_RULES,
  WD,
  FILM_NOIR_LAST_YEAR,
  normalizeKeyword,
  normalizePersonName,
} = require('./taxonomy-defs');
const {
  BLACKLIST_PATH,
  BLACKLIST_VERSION,
  normalizeBlacklist,
  readBlacklist,
  resolveBlacklist,
} = require('./taxonomy-blacklist');

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

function wdSets(wd) {
  const source = wd && typeof wd === 'object' ? wd : {};
  const toSet = (value) =>
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => String(item == null ? '' : item).trim())
        .filter(Boolean)
    );
  return {
    genres: toSet(source.genres),
    colors: toSet(source.colors),
    movements: toSet(source.movements),
    basedClasses: toSet(source.basedClasses),
  };
}

function wdOrigin(wdSet) {
  for (const key of ['remake', 'book', 'comic', 'play', 'video-game']) {
    if (wdSet.basedClasses.has(key)) return key;
  }
  return null;
}

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

function classifyFilm(film) {
  const keywordSet = keywordSetOf(film && film.keywords);
  const wd = wdSets(film && film.wd);
  const year = Number(film && film.year);
  const hasYear = Number.isFinite(year) && year > 0;
  const categories = [];

  for (const rule of CATEGORY_RULES) {
    if (rule.def.genreBased) continue;
    if (matchesAlias(keywordSet, rule.aliases)) categories.push(rule.def.key);
  }

  for (const rule of CATEGORY_RULES) {
    if (!rule.def.wdGenre) continue;
    if (!categories.includes(rule.def.key) && wd.genres.has(rule.def.wdGenre)) {
      categories.push(rule.def.key);
    }
  }

  if (
    !categories.includes('black-and-white') &&
    wd.colors.has(WD.BLACK_AND_WHITE) &&
    !wd.colors.has(WD.COLOR)
  ) {
    categories.push('black-and-white');
  }
  if (!categories.includes('silent') && wd.genres.has(WD.SILENT_FILM)) {
    categories.push('silent');
  }
  if (
    !categories.includes('film-noir') &&
    wd.genres.has(WD.FILM_NOIR) &&
    hasYear &&
    year <= FILM_NOIR_LAST_YEAR
  ) {
    categories.push('film-noir');
  }
  if (!categories.includes('neo-noir') && wd.genres.has(WD.NEO_NOIR)) {
    categories.push('neo-noir');
  }

  const anime = categories.includes('anime');
  const animationGenre = isAnimationGenre(film && film.genres);
  if (animationGenre && !anime) categories.push('animation');

  let origin = ORIGINAL_DEF.key;
  for (const rule of ORIGIN_RULES) {
    if (matchesAlias(keywordSet, rule.aliases)) {
      origin = rule.def.key;
      break;
    }
  }
  if (origin === ORIGINAL_DEF.key) {
    const fromWikidata = wdOrigin(wd);
    if (fromWikidata) origin = fromWikidata;
  }

  const periods = [];
  for (const rule of PERIOD_RULES) {
    if (matchesAlias(keywordSet, rule.aliases)) periods.push(rule.def.key);
  }
  if (
    !periods.includes('film-noir') &&
    wd.genres.has(WD.FILM_NOIR) &&
    hasYear &&
    year <= FILM_NOIR_LAST_YEAR
  ) {
    periods.push('film-noir');
  }
  if (!periods.includes('new-hollywood') && wd.movements.has(WD.NEW_HOLLYWOOD)) {
    periods.push('new-hollywood');
  }
  for (const rule of PERIOD_RULES) {
    if (rule.def.wdMovement && wd.movements.has(rule.def.wdMovement)) {
      if (!periods.includes(rule.def.key)) periods.push(rule.def.key);
    }
  }

  const kind = String((film && film.kind) || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
  if (kind === 'movie' && !animationGenre && hasYear) {
    const directors = new Set(
      (Array.isArray(film && film.directors) ? film.directors : [])
        .map(normalizePersonName)
        .filter(Boolean)
    );
    const countries = new Set(
      (Array.isArray(film && film.countries) ? film.countries : [])
        .map((code) => String(code == null ? '' : code).toUpperCase())
        .filter(Boolean)
    );
    if (directors.size > 0 && countries.size > 0) {
      for (const rule of DIRECTOR_RULES) {
        if (periods.includes(rule.key)) continue;
        if (year < rule.window.from || year > rule.window.to) continue;
        let countryMatch = false;
        for (const code of countries) {
          if (rule.countries.has(code)) {
            countryMatch = true;
            break;
          }
        }
        if (!countryMatch) continue;
        for (const name of directors) {
          if (rule.directors.has(name)) {
            periods.push(rule.key);
            break;
          }
        }
      }
    }
  }

  return { categories, origin, periods };
}

function buildTaxonomy(films, options = {}) {
  const blacklist = resolveBlacklist(options && options.blacklist);
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
    const blocked = blacklist.bySlug.get(film.slug);
    for (const key of classified.categories) {
      if (blocked && blocked.has(key)) continue;
      addToBucket(categoryBuckets.get(key), film);
    }
    addToBucket(originBuckets.get(classified.origin), film);
    for (const key of classified.periods) {
      if (blocked && blocked.has(key)) continue;
      addToBucket(periodBuckets.get(key), film);
    }
  }

  return {
    categories: serializeBuckets(CATEGORY_DEFS, categoryBuckets, 'count'),
    origins: serializeBuckets(
      [...ORIGIN_DEFS, ORIGINAL_DEF],
      originBuckets,
      'definition'
    ),
    periods: serializeBuckets(PERIOD_DEFS, periodBuckets, 'count'),
  };
}

module.exports = {
  BLACKLIST_PATH,
  BLACKLIST_VERSION,
  normalizeBlacklist,
  readBlacklist,
  CATEGORY_DEFS,
  ORIGIN_DEFS,
  PERIOD_DEFS,
  DIRECTOR_DEFS,
  WD,
  FILM_NOIR_LAST_YEAR,
  normalizeKeyword,
  normalizePersonName,
  classifyFilm,
  buildTaxonomy,
};