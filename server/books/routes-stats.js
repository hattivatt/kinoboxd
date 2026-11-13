'use strict';

const express = require('express');

const { mapDomainError } = require('../core/errors');
const { assertOnlyParams, parseBoolean } = require('../core/params');
const authorsBridge = require('./authors-bridge');
const importJobs = require('./import');
const { buildBooksStats, listUnmatched } = require('./stats');
const { resolveProfileScopeOrThrow } = require('./profile-scope');
const { BOOKS_ERROR_PROFILE } = require('./route-errors');

const router = express.Router();

router.get('/stats', (req, res, next) => {
  try {
    assertOnlyParams(req, ['profile', 'includeMangaComics'], 'GET /api/books/stats');
    const scope = resolveProfileScopeOrThrow(req);
    const includeMangaComics = parseBoolean(req.query.includeMangaComics, {
      name: 'includeMangaComics',
      code: 'invalid_include_manga',
    });
    const selected = scope.selected[0];
    const stats = buildBooksStats({
      profileScope: scope,
      includeMangaComics,
      resolveState: importJobs.getResolveState(selected.source, selected.userKey),
      authorBridge: authorsBridge.kickAuthorsWikidata,
    });
    res.set('X-Books-Build-Ms', String(stats.meta.buildMs));
    res.status(200).json(stats);
  } catch (err) {
    next(mapDomainError(err, BOOKS_ERROR_PROFILE));
  }
});

router.get('/unmatched', (req, res, next) => {
  try {
    assertOnlyParams(req, ['profile'], 'GET /api/books/unmatched');
    const scope = resolveProfileScopeOrThrow(req);
    res.status(200).json(listUnmatched({ profileScope: scope }));
  } catch (err) {
    next(mapDomainError(err, BOOKS_ERROR_PROFILE));
  }
});

module.exports = router;
