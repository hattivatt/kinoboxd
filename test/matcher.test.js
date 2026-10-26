'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TMDB_API_TOKEN = process.env.TMDB_API_TOKEN || 'test-token';

const tmdb = require('../server/tmdb');

let handler = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });

global.fetch = async (url) => handler(new URL(String(url)));

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json' },
  });
}

function movie(id, title, release, votes, original) {
  return {
    id,
    title,
    original_title: original || title,
    release_date: release,
    vote_count: votes,
    vote_average: 7,
    popularity: 10,
  };
}

function tv(id, name, firstAir, votes, original) {
  return {
    id,
    name,
    original_name: original || name,
    first_air_date: firstAir,
    vote_count: votes,
    vote_average: 7,
    popularity: 10,
  };
}

function searchResults(url, items) {
  return json({ results: items });
}

test('similarity table protects against fragment matches', () => {
  const miCanonical = [
    'Mission: Impossible - Dead Reckoning',
    'Миссия невыполнима: Смертельная расплата',
  ];
  assert.equal(
    tmdb.titleMatchScore(
      ['Mission: Impossible - Dead Reckoning Part One', 'Mission: Impossible - Dead Reckoning Part One'],
      miCanonical
    ),
    0.95
  );
  assert.ok(
    tmdb.titleMatchScore(['ImPossible', 'ImPossible'], miCanonical) < 0.5,
    'a one-word fragment must not become an exact match'
  );

  const swCanonical = [
    'Star Wars: Episode VIII - The Last Jedi',
    'Звёздные войны: Последние джедаи',
  ];
  assert.equal(
    tmdb.titleMatchScore(['Star Wars: The Last Jedi', 'Star Wars: The Last Jedi'], swCanonical),
    1
  );
  assert.ok(
    tmdb.titleMatchScore(['Star Wars', 'Star Wars'], swCanonical) < 0.5,
    'the franchise title must not match an episode'
  );
  assert.equal(
    tmdb.titleMatchScore(
      ['Звёздные войны: Эпизод 8 - Последние джедаи', 'Star Wars: The Last Jedi'],
      swCanonical
    ),
    1
  );

  assert.equal(
    tmdb.titleMatchScore(['Слёзы капали', 'Слёзы капали'], ['Слезы капали']),
    1
  );
  assert.ok(
    tmdb.titleMatchScore(
      ['Ён Паль. Подпольный доктор', 'Yong Pal'],
      ['Yongpari', 'Ён-пхаль: Подпольный доктор']
    ) >= 0.85
  );
});

test('Mission: Impossible picks Dead Reckoning, not ImPossible', async () => {
  const dead = movie(575264, 'Mission: Impossible - Dead Reckoning Part One', '2023-07-08', 5478);
  const imp = movie(1199378, 'ImPossible', '2023-10-29', 0);
  handler = async (url) => {
    const q = url.searchParams.get('query');
    if (q === 'Mission: Impossible - Dead Reckoning') return searchResults(url, [dead, imp]);
    if (q === 'Impossible') return searchResults(url, [imp, dead]);
    if (q && q.startsWith('Миссия невыполнима')) return searchResults(url, [dead]);
    if (q === 'Dead Reckoning') return searchResults(url, [dead]);
    return searchResults(url, []);
  };
  const found = await tmdb.searchMovie('Mission: Impossible - Dead Reckoning', 2023, {
    language: 'en-US',
    fallbackTitle: 'Миссия невыполнима: Смертельная расплата',
  });
  assert.equal(found && found.id, 575264);
});

test('Star Wars episode numbers resolve to the right episode', async () => {
  const episodes = {
    'Star Wars: Episode VIII - The Last Jedi': tvOrMovie(181808, 'Star Wars: The Last Jedi', '2017-12-13', 16820),
    'Star Wars: Episode IX - The Rise of Skywalker': tvOrMovie(181812, 'Star Wars: The Rise of Skywalker', '2019-12-18', 11275),
    'Star Wars: Episode VII - The Force Awakens': tvOrMovie(140607, 'Star Wars: The Force Awakens', '2015-12-15', 21069),
  };
  function tvOrMovie(id, title, release, votes) {
    return movie(id, title, release, votes);
  }
  handler = async (url) => {
    const q = url.searchParams.get('query');
    if (episodes[q]) return searchResults(url, [episodes[q]]);
    if (q === 'Star Wars') return searchResults(url, [movie(11, 'Star Wars', '1977-05-25', 23078)]);
    return searchResults(url, []);
  };

  const viii = await tmdb.searchMovie('Star Wars: Episode VIII - The Last Jedi', 2017, {
    language: 'en-US',
    fallbackTitle: 'Звёздные войны: Последние джедаи',
  });
  assert.equal(viii && viii.id, 181808);
  const ix = await tmdb.searchMovie('Star Wars: Episode IX - The Rise of Skywalker', 2019, {
    language: 'en-US',
    fallbackTitle: 'Звёздные войны: Скайуокер. Восход',
  });
  assert.equal(ix && ix.id, 181812);
  const vii = await tmdb.searchMovie('Star Wars: Episode VII - The Force Awakens', 2015, {
    language: 'en-US',
    fallbackTitle: 'Звёздные войны: Пробуждение силы',
  });
  assert.equal(vii && vii.id, 140607);
});

test('previous broad regressions stay matched', async () => {
  const tears = movie(27925, 'Слёзы капали', '1983-01-15', 24);
  const yong = tv(63311, 'Ён Паль. Подпольный доктор', '2015-08-05', 33, 'Yong Pal');
  const healer = tv(61670, 'Хилер (Целитель)', '2014-12-08', 329, '힐러');
  const wicked = movie(402431, 'Wicked', '2024-10-16', 3303);

  handler = async (url) => {
    const q = url.searchParams.get('query');
    const pathname = url.pathname;
    if (pathname.endsWith('/search/tv')) {
      if (q === 'Ён-пхаль: Подпольный доктор' || q === 'Ён-пхаль' || q === 'Подпольный доктор') {
        return searchResults(url, [yong]);
      }
      if (q === 'Хилер') return searchResults(url, [healer]);
      return searchResults(url, []);
    }
    if (q === 'Слезы капали' || q === 'Слёзы капали') return searchResults(url, [tears]);
    if (q === 'Wicked') return searchResults(url, [wicked]);
    return searchResults(url, []);
  };

  const t = await tmdb.searchMovie('Слезы капали', 1982, { language: 'ru-RU' });
  assert.equal(t && t.id, 27925);

  const y = await tmdb.searchTv('Yongpari', 2015, {
    language: 'en-US',
    fallbackTitle: 'Ён-пхаль: Подпольный доктор',
  });
  assert.equal(y && y.id, 63311);

  const h = await tmdb.searchTv('Hilreo', 2014, {
    language: 'en-US',
    fallbackTitle: 'Хилер',
  });
  assert.equal(h && h.id, 61670);

  const w = await tmdb.searchMovie('Wicked', 2024, { language: 'en-US' });
  assert.equal(w && w.id, 402431);
});

test('a lone unrelated hit is rejected, a supported lone hit is accepted', async () => {
  const posh = movie(1577425, 'POSH (Please only send help)', '2025-11-01', 1);
  handler = async () => searchResults(null, [posh]);
  const rejected = await tmdb.searchMovie('Send Help', 2025, { language: 'en-US' });
  assert.equal(rejected, null);

  const obscure = movie(777, 'Старая деревня', '2000-01-01', 500);
  handler = async () => searchResults(null, [obscure]);
  const accepted = await tmdb.searchMovie('Деревня', 2000, { language: 'ru-RU' });
  assert.equal(accepted && accepted.id, 777);

  const nobody = movie(778, 'Старая деревня', '2000-01-01', 5);
  handler = async () => searchResults(null, [nobody]);
  const rejected2 = await tmdb.searchMovie('Деревня', 2000, { language: 'ru-RU' });
  assert.equal(rejected2, null);
});

test('transport failures are retried with backoff', async () => {
  let calls = 0;
  handler = async () => {
    calls++;
    if (calls <= 2) throw new Error('fetch failed');
    return json({ ok: true });
  };
  const before = tmdb.counters.transportRetries;
  const result = await tmdb.tmdbGet('/configuration', {});
  assert.deepEqual(result, { ok: true });
  assert.ok(calls >= 3);
  assert.ok(tmdb.counters.transportRetries >= before + 2);
});
