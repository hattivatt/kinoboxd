'use strict';

const express = require('express');

const { HttpError } = require('../core/errors');
const { assertOnlyParams } = require('../core/params');
const bookCache = require('./book-cache');
const links = require('./links');
const seriesOverrides = require('./series-overrides');
const audit = require('./audit');
const { eventLinkKeyOf } = require('./stats/events');
const { resolveProfileTokenOrThrow } = require('./routes');

const { MAX_SERIES, MAX_SERIES_NAME, MAX_WORK_ID, nameKeyOf } = seriesOverrides;
const MAX_BOOK_ID = 200;
const LINK_WORK_ID_RE = /^(hc|lr|gb|ol):.+$/;

const router = express.Router();

router.post('/series-override', async (req, res, next) => {
  try {
    const body = req.body || {};
    const profileToken = typeof body.profile === 'string' ? body.profile.trim() : '';
    if (!profileToken) {
      throw new HttpError(400, 'Body must contain "profile".', 'profile_required');
    }
    resolveProfileTokenOrThrow(profileToken, 'Body field "profile"');
    const workId = typeof body.workId === 'string' ? body.workId.trim() : '';
    if (!workId) {
      throw new HttpError(400, 'Body must contain "workId".', 'work_id_required');
    }
    if (workId.length > MAX_WORK_ID) {
      throw new HttpError(
        400,
        `Body field "workId" must be at most ${MAX_WORK_ID} characters.`,
        'invalid_work_id'
      );
    }
    const series = body.series;
    if (!Array.isArray(series)) {
      throw new HttpError(
        400,
        'Body field "series" must be an array of { name, position } objects ([] clears the series list).',
        'invalid_series'
      );
    }
    if (series.length > MAX_SERIES) {
      throw new HttpError(
        400,
        `Body field "series" must not carry more than ${MAX_SERIES} entries.`,
        'invalid_series'
      );
    }
    const normalized = [];
    const seen = new Set();
    for (const entry of series) {
      const name = entry && typeof entry === 'object' && entry.name != null
        ? String(entry.name).trim()
        : '';
      if (!name) {
        throw new HttpError(400, 'Every "series" entry needs a non-empty "name".', 'invalid_series');
      }
      if (name.length > MAX_SERIES_NAME) {
        throw new HttpError(
          400,
          `Body field "series[].name" must be at most ${MAX_SERIES_NAME} characters.`,
          'invalid_series'
        );
      }
      const key = nameKeyOf(name);
      if (seen.has(key)) {
        throw new HttpError(400, `Body field "series" repeats "${name}".`, 'invalid_series');
      }
      seen.add(key);
      let position = null;
      if (entry.position != null && entry.position !== '') {
        position = Number(entry.position);
        if (!Number.isFinite(position) || position < 0) {
          throw new HttpError(
            400,
            'Body field "series[].position" must be a finite number >= 0 or null.',
            'invalid_series'
          );
        }
      }
      normalized.push({ name, position });
    }
    const entry = await seriesOverrides.saveSeriesOverrides(workId, normalized);
    res.status(200).json({ ok: true, workId, series: entry.series });
  } catch (err) {
    next(err);
  }
});

router.delete('/series-override', async (req, res, next) => {
  try {
    const body = req.body || {};
    const profileToken = typeof body.profile === 'string' ? body.profile.trim() : '';
    if (!profileToken) {
      throw new HttpError(400, 'Body must contain "profile".', 'profile_required');
    }
    resolveProfileTokenOrThrow(profileToken, 'Body field "profile"');
    const workId = typeof body.workId === 'string' ? body.workId.trim() : '';
    if (!workId) {
      throw new HttpError(400, 'Body must contain "workId".', 'work_id_required');
    }
    if (workId.length > MAX_WORK_ID) {
      throw new HttpError(
        400,
        `Body field "workId" must be at most ${MAX_WORK_ID} characters.`,
        'invalid_work_id'
      );
    }
    await seriesOverrides.clearSeriesOverrides(workId);
    res.status(200).json({ ok: true, workId, cleared: true });
  } catch (err) {
    next(err);
  }
});

router.post('/link', async (req, res, next) => {
  try {
    const body = req.body || {};
    const profileToken = typeof body.profile === 'string' ? body.profile.trim() : '';
    if (!profileToken) {
      throw new HttpError(400, 'Body must contain "profile".', 'profile_required');
    }
    const profile = resolveProfileTokenOrThrow(profileToken, 'Body field "profile"').selected[0];
    const bookId = body.bookId == null ? '' : String(body.bookId).trim();
    if (!bookId) {
      throw new HttpError(400, 'Body must contain "bookId".', 'book_id_required');
    }
    if (bookId.length > MAX_BOOK_ID) {
      throw new HttpError(
        400,
        `Body field "bookId" must be at most ${MAX_BOOK_ID} characters.`,
        'invalid_book_id'
      );
    }
    const workId = typeof body.workId === 'string' ? body.workId.trim() : '';
    if (!workId) {
      throw new HttpError(400, 'Body must contain "workId".', 'work_id_required');
    }
    if (workId.length > MAX_WORK_ID || !LINK_WORK_ID_RE.test(workId)) {
      throw new HttpError(
        400,
        'Body field "workId" must look like "hc:<id>", "lr:<id>", "gb:<id>" or "ol:<id>".',
        'invalid_work_id'
      );
    }
    const data = bookCache.getProfile(profile.source, profile.userKey);
    const events = data && Array.isArray(data.events) ? data.events : [];
    if (!events.some((event) => eventLinkKeyOf(event) === bookId)) {
      throw new HttpError(
        404,
        `Book "${bookId}" is not part of profile ${profile.source}-${profile.userKey}.`,
        'unknown_book'
      );
    }
    await links.saveManualLink(bookId, workId);
    res.status(200).json({ ok: true, bookId, workId });
  } catch (err) {
    next(err);
  }
});

router.delete('/link', async (req, res, next) => {
  try {
    const body = req.body || {};
    const profileToken = typeof body.profile === 'string' ? body.profile.trim() : '';
    if (!profileToken) {
      throw new HttpError(400, 'Body must contain "profile".', 'profile_required');
    }
    resolveProfileTokenOrThrow(profileToken, 'Body field "profile"');
    const bookId = body.bookId == null ? '' : String(body.bookId).trim();
    if (!bookId) {
      throw new HttpError(400, 'Body must contain "bookId".', 'book_id_required');
    }
    if (bookId.length > MAX_BOOK_ID) {
      throw new HttpError(
        400,
        `Body field "bookId" must be at most ${MAX_BOOK_ID} characters.`,
        'invalid_book_id'
      );
    }
    links.deleteLink(bookId);
    res.status(200).json({ ok: true, bookId, cleared: true });
  } catch (err) {
    next(err);
  }
});

router.get('/audit', (req, res, next) => {
  try {
    assertOnlyParams(req, ['profile'], 'GET /api/books/audit');
    const selected = resolveProfileTokenOrThrow(
      req.query.profile,
      'Query parameter "profile"'
    ).selected[0];
    const result = audit.listSuspiciousLinks(selected);
    res.status(200).json({
      profile: `${selected.source}-${selected.userKey}`,
      count: result.count,
      items: result.items,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
