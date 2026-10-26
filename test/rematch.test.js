'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-rematch-'));
fs.mkdirSync(path.join(cacheDir, 'details'), { recursive: true });
fs.mkdirSync(path.join(cacheDir, 'kp'), { recursive: true });

const index = {
  'mission: impossible - dead reckoning|2023': 1199378,
  'star wars: episode viii - the last jedi|2017': 11,
  'send help|2025': 1577425,
  'слезы капали|1982': 27925,
  'hilreo|2014': 61670,
  'manual entry|2024': { id: 999, kind: 'movie' },
  'unknown thing|2020': false,
  'nope|2021': false,
  'old classic|1965': 3780,
  'vanished|1999': 555,
};
fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify(index), 'utf8');

fs.writeFileSync(
  path.join(cacheDir, 'kp', '1.json'),
  JSON.stringify({
    entries: [
      { kpId: 1, type: 'film', titleRu: 'Смертельная расплата', titleEn: 'Mission: Impossible - Dead Reckoning', year: 2023 },
      { kpId: 2, type: 'film', titleRu: 'Последние джедаи', titleEn: 'Star Wars: Episode VIII - The Last Jedi', year: 2017 },
      { kpId: 3, type: 'film', titleRu: 'На помощь!', titleEn: 'Send Help', year: 2025 },
      { kpId: 4, type: 'film', titleRu: 'Слезы капали', titleEn: null, year: 1982 },
      { kpId: 5, type: 'tv', titleRu: 'Хилер', titleEn: 'Hilreo', year: 2014 },
      { kpId: 6, type: 'film', titleRu: 'Неизвестная вещь', titleEn: 'Unknown Thing', year: 2020 },
      { kpId: 7, type: 'film', titleRu: 'Нет', titleEn: 'Nope', year: 2021 },
      { kpId: 8, type: 'film', titleRu: 'Старая классика', titleEn: 'Old Classic', year: 1965 },
      { kpId: 9, type: 'film', titleRu: 'Исчезнувший', titleEn: 'Vanished', year: 1999 },
    ],
  }),
  'utf8'
);

process.env.KINOBOXD_CACHE_DIR = cacheDir;
process.env.TMDB_API_TOKEN = 'test-token';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json' },
  });
}

function movie(id, title, release, votes) {
  return {
    id,
    title,
    original_title: title,
    release_date: release,
    vote_count: votes,
    vote_average: 7,
    popularity: 10,
  };
}

const searchHandler = async (url) => {
  const q = url.searchParams.get('query') || '';
  const tv = url.pathname.endsWith('/search/tv');
  const empty = () => json({ results: [] });
  if (tv) {
    if (q === 'Хилер') {
      return json({
        results: [
          {
            id: 61670,
            name: 'Хилер (Целитель)',
            original_name: '힐러',
            first_air_date: '2014-12-08',
            vote_count: 329,
            vote_average: 8,
            popularity: 10,
          },
        ],
      });
    }
    return empty();
  }
  if (/mission/i.test(q) || /Миссия/i.test(q)) return json({ results: [movie(575264, 'Mission: Impossible - Dead Reckoning Part One', '2023-07-08', 5478)] });
  if (/star wars/i.test(q)) return json({ results: [movie(181808, 'Star Wars: The Last Jedi', '2017-12-13', 16820)] });
  if (/send help/i.test(q)) return json({ results: [movie(1198994, 'Send Help', '2026-01-22', 2435)] });
  if (/сл[её]зы/i.test(q)) return json({ results: [movie(27925, 'Слёзы капали', '1983-01-15', 24)] });
  if (/unknown thing/i.test(q)) return json({ results: [movie(12345, 'Unknown Thing', '2020-05-01', 500)] });
  if (/old classic/i.test(q)) return json({ results: [movie(1636700, 'Old Classic', '1997-01-01', 0)] });
  return empty();
};

const detailsHandler = async (url, id) => {
  if (url.pathname.endsWith('/credits')) return json({ cast: [], crew: [] });
  return json({
    id,
    title: `Title ${id}`,
    original_title: `Title ${id}`,
    release_date: '2020-01-01',
    runtime: 100,
    imdb_id: null,
    genres: [],
    poster_path: null,
    vote_average: 7,
    overview: '',
    production_countries: [],
    production_companies: [],
    keywords: { keywords: [] },
    belongs_to_collection: null,
  });
};

global.fetch = async (url) => {
  const parsed = new URL(String(url));
  const detailsMatch = parsed.pathname.match(/\/(movie|tv)\/(\d+)/);
  if (detailsMatch && !parsed.pathname.includes('/search/')) {
    return detailsHandler(parsed, Number(detailsMatch[2]));
  }
  return searchHandler(parsed);
};

const { runRematch } = require('../server/rematch');

test('rematch updates auto matches, keeps manual matches and reports failures', async () => {
  const stats = await runRematch();

  const written = JSON.parse(fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8'));
  assert.equal(written['mission: impossible - dead reckoning|2023'], 575264);
  assert.equal(written['star wars: episode viii - the last jedi|2017'], 181808);
  assert.equal(written['send help|2025'], 1198994);
  assert.equal(written['слезы капали|1982'], 27925);
  assert.equal(written['hilreo|2014'], 61670);
  assert.deepEqual(written['manual entry|2024'], { id: 999, kind: 'movie' });
  assert.equal(written['unknown thing|2020'], 12345);
  assert.equal(written['nope|2021'], false);
  assert.equal(written['old classic|1965'], 3780, 'year guard keeps the classic');
  assert.equal(written['vanished|1999'], 555, 'missing search result never downgrades an id');

  assert.equal(stats.manual, 1);
  assert.equal(stats.changed, 4);
  assert.equal(stats.unchanged, 2);
  assert.equal(stats.stillFailed, 1);
  assert.equal(stats.unconfirmed, 1);
  assert.equal(stats.guarded, 1);
  assert.equal(stats.retriedMatched, 1);
  assert.equal(stats.errors, 0);
  assert.equal(stats.detailsRefetched, 4);

  for (const id of [575264, 181808, 1198994, 12345]) {
    assert.ok(fs.existsSync(path.join(cacheDir, 'details', `${id}.json`)), `details ${id}`);
  }
});
