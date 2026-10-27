'use strict';

/**
 * Manga/comics detection for the books payload (`?includeMangaComics=0|1`).
 *
 * The flag is deliberately tri-state:
 *   true  — at least one metadata signal names manga/comics/graphic novel;
 *   false — genres are known and none of them is manga/comics;
 *   null  — no genre-level signal (LiveLib bulk has no genres at all), so the
 *           book is never filtered. `null` survives every filter, which is the
 *           conscious choice from the brief: a missing signal must not hide a
 *           regular book.
 */

const MANGA_PATTERN =
  /manga|manhwa|manhua|comics?|graphic[\s-]?novel|манга|манхва|манхуа|комикс|аниме/i;

function namesOf(signals) {
  if (!signals) return [];
  const list = Array.isArray(signals) ? signals : [signals];
  const names = [];
  for (const entry of list) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      if (entry.trim()) names.push(entry.trim());
      continue;
    }
    if (typeof entry === 'object' && typeof entry.name === 'string' && entry.name.trim()) {
      names.push(entry.name.trim());
    }
  }
  return names;
}

function isMangaSignal(value) {
  return Boolean(value) && MANGA_PATTERN.test(String(value));
}

/**
 * @param {{genres?: Array<string|object>, categories?: Array<string>,
 *          series?: Array<string|object>, publisher?: string|null}} input
 * @returns {boolean|null}
 */
function detectManga(input = {}) {
  const genres = namesOf(input.genres).concat(namesOf(input.categories));
  const series = namesOf(input.series);
  const publisher = input.publisher ? String(input.publisher).trim() : '';

  for (const value of genres.concat(series)) {
    if (isMangaSignal(value)) return true;
  }
  if (isMangaSignal(publisher)) return true;
  // Genres known and clean -> confidently not manga/comics.
  if (genres.length > 0) return false;
  return null;
}

module.exports = {
  MANGA_PATTERN,
  detectManga,
};
