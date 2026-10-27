'use strict';

/**
 * LiveLib -> Hardcover resolve: normalisation, guards and the resolve job
 * (ISBN strategy + title/author strategy + unmatched negatives).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-resolve-'));
process.env.HARDCOVER_API_TOKEN = 'hc_pat_test_token_value';

const bookCache = require('../server/books/book-cache');
const hardcover = require('../server/books/hardcover');
const resolve = require('../server/books/resolve');

test('title normalisation strips series markers but keeps short main titles', () => {
  assert.equal(
    resolve.normalizeTitle('Гарри Поттер и Дары Смерти (Гарри Поттер, #7)'),
    'гарри поттер и дары смерти'
  );
  assert.equal(resolve.normalizeTitle('Дюна: Мессия'), 'дюна мессия');
  assert.equal(resolve.normalizeTitle('Гарри Поттер и Дары Смерти: Пьеса. Часть первая'), 'гарри поттер и дары смерти');
  assert.equal(resolve.normalizeTitle('Ведьмак. Том 3'), 'ведьмак');
  assert.equal(resolve.normalizeTitle('Ёлка и её друзья'), 'елка и ее друзья');
});

test('token Jaccard and surname extraction', () => {
  assert.equal(resolve.tokenJaccard('Дюна', 'Дюна'), 1);
  assert.ok(resolve.tokenJaccard('Дюна', 'Дюна: Дом Атрейдесов') < 0.9);
  assert.equal(resolve.surnameOf('Джефф Вандермеер'), 'вандермеер');
  assert.equal(resolve.surnameOf('J. K. Rowling'), 'rowling');
  assert.equal(resolve.surnameOf(''), '');
});

test('ISBN normalisation and conversion', () => {
  assert.equal(resolve.normalizeIsbn('978-5-699-98967-6'), '9785699989676');
  assert.equal(resolve.normalizeIsbn('0-306-40615-2'), '9780306406157');
  assert.equal(resolve.isbn10to13('0-306-40615-2'), '9780306406157');
  assert.equal(resolve.isbn10Of('9780306406157'), '0306406152');
  assert.equal(resolve.normalizeIsbn('not-an-isbn'), null);
});

test('exact title + author + year scores 1.0', () => {
  const event = {
    title: 'Дюна',
    authors: ['Фрэнк Герберт'],
    edition: { year: 1965 },
  };
  const candidate = {
    hcWorkId: 100,
    title: 'Дюна',
    authors: [{ name: 'Фрэнк Герберт' }],
    publicationYear: 1965,
    ratingsCount: 1000,
    series: [],
  };
  const scored = resolve.scoreCandidate(event, candidate);
  assert.equal(scored.score, 1);
  assert.equal(scored.method, 'title-author-year');
});

test('collection marker blocks an otherwise exact match', () => {
  const event = { title: 'Дюна (сборник)', authors: ['Фрэнк Герберт'], edition: { year: 1965 } };
  const candidate = {
    hcWorkId: 100,
    title: 'Дюна',
    authors: [{ name: 'Фрэнк Герберт' }],
    publicationYear: 1965,
    ratingsCount: 1000,
    series: [],
  };
  const scored = resolve.scoreCandidate(event, candidate);
  assert.equal(scored.score, 0);
  assert.equal(scored.evidence.guard, 'collection-marker');
});

test('equally good different candidates are reported as ambiguous', () => {
  const event = { title: 'Дюна', authors: ['Фрэнк Герберт'], edition: { year: 1965 } };
  const make = (id) => ({
    hcWorkId: id,
    title: 'Дюна',
    authors: [{ name: 'Фрэнк Герберт' }],
    publicationYear: 1965,
    ratingsCount: 1000,
    series: [],
  });
  const best = resolve.bestCandidate(event, [make(2), make(1)]);
  assert.equal(best.ambiguous, true);
});

test('resolveProfile matches by ISBN and by title, keeps negatives uncached', async () => {
  // Two candidate works already known from a journal import.
  await bookCache.saveDetails(200, {
    schemaVersion: 1,
    hcWorkId: 200,
    title: 'Мартин Иден',
    authors: [{ hcId: 1, name: 'Джек Лондон' }],
    genres: [],
    series: [],
    pages: 400,
    publicationYear: 1909,
    ratingsCount: 500,
    partial: false,
  });

  const llProfile = {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'tester',
    events: [
      {
        id: 'll:1',
        source: 'livelib',
        sourceBookId: '1001',
        title: 'Дюна',
        authors: ['Фрэнк Герберт'],
        rating: 9,
        ratingScale: 10,
        rating10: 9,
        edition: { isbn: '978-0-441-01359-3', year: 1965 },
      },
      {
        id: 'll:2',
        source: 'livelib',
        sourceBookId: '1002',
        title: 'Мартин Иден',
        authors: ['Джек Лондон'],
        rating: 8,
        ratingScale: 10,
        rating10: 8,
        edition: { isbn: null, year: 1909 },
      },
      {
        id: 'll:3',
        source: 'livelib',
        sourceBookId: '1003',
        title: 'Совершенно неизвестная книга',
        authors: ['Никто Никтович'],
        rating: null,
        edition: { isbn: null, year: 2020 },
      },
    ],
  };

  const originalGraphql = hardcover.graphql;
  let queries = 0;
  hardcover.graphql = async (query, variables) => {
    queries++;
    assert.match(query, /editions/);
    assert.deepEqual(variables.isbns.sort(), ['0441013597', '9780441013593'].sort());
    return {
      editions: [
        {
          id: 555,
          book_id: 100,
          isbn_13: '9780441013593',
          isbn_10: '0441013593',
          language_id: 1,
          pages: 512,
          publisher_id: 1,
          release_year: 1965,
          release_date: '1965-08-01',
          publisher: { id: 1, name: 'Chilton' },
          language: { id: 1, language: 'English' },
          book: {
            id: 100,
            title: 'Дюна',
            slug: 'dune',
            pages: 512,
            release_year: 1965,
            rating: 4.5,
            ratings_count: 5000,
            contributions: [{ author: { id: 7, name: 'Фрэнк Герберт' }, contribution: 'Author' }],
            book_series: [],
            taggings: [{ tag: { id: 6, tag: 'Science Fiction', tag_category_id: 1 } }],
          },
        },
      ],
    };
  };

  try {
    const report = await resolve.resolveProfile(llProfile, { providers: [] });
    assert.equal(report.total, 3);
    assert.equal(report.resolvedIsbn, 1);
    assert.equal(report.resolvedTitle, 1);
    assert.equal(report.unmatched, 1);
    assert.equal(queries, 1);

    const isbnLink = bookCache.getLink('1001');
    assert.equal(isbnLink.workId, 'hc:100');
    assert.equal(isbnLink.method, 'isbn');

    const titleLink = bookCache.getLink('1002');
    assert.equal(titleLink.workId, 'hc:200');
    assert.equal(titleLink.method, 'title-author-year');

    // Negative results are not cached: a later import can still resolve them.
    assert.equal(bookCache.getLink('1003'), null);

    // The index gets both key styles.
    assert.equal(bookCache.getIndexEntry('ll:1001'), 100);
    assert.equal(bookCache.getIndexEntry('isbn:9780441013593'), 100);

    // Running again reuses positive links and re-queries only the negative.
    hardcover.graphql = async () => ({ editions: [] });
    const second = await resolve.resolveProfile(llProfile, { providers: [] });
    assert.equal(second.cached, 2);
    assert.equal(second.unmatched, 1);
  } finally {
    hardcover.graphql = originalGraphql;
  }
});
