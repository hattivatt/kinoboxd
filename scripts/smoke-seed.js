'use strict';

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const root = process.argv[2];

if (!root) {
  console.error('usage: node scripts/smoke-seed.js <tmp-root>');
  process.exit(2);
}

process.env.KINOBOXD_CACHE_DIR = path.join(root, 'cache');
process.env.KINOBOXD_CACHE_BOOK_DIR = path.join(root, 'cache-book');
process.env.KINOBOXD_CACHE_GAMES_DIR = path.join(root, 'cache-games');
process.env.KINOBOXD_STATE_DIR = path.join(root, 'state');
process.env.KINOBOXD_EPIC_TOKENS_DIR = path.join(root, 'state', 'epic-tokens');

const bookCache = require(path.join(ROOT, 'server/books/book-cache'));
const gameCache = require(path.join(ROOT, 'server/games/game-cache'));
const cache = require(path.join(ROOT, 'server/cache'));
const seed = require(path.join(ROOT, 'test/golden/seed'));

(async () => {
  const films = await seed.seedFilms(cache);
  const books = await seed.seedBooks(bookCache);
  const games = await seed.seedGames(gameCache);
  console.log(
    `[smoke-seed] films: ${films.details} details; ` +
      `books: ${books.profile} (${books.links} links, ${books.details} details); ` +
      `games: ${games.profileKey} (${games.libraryGames} games, ${games.details} details)`
  );
})().catch((err) => {
  console.error(`[smoke-seed] failed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
