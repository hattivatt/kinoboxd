'use strict';

/**
 * /api/books/* router. Mounted under the existing auth gate in
 * server/index.js (`app.use('/api', auth.requireAuth)` runs first), so the
 * whole book namespace is password-protected exactly like the film API.
 *
 * The film payload (`/api/stats`) is not touched: books live in their own
 * namespace with their own cache directory.
 */

const express = require('express');

const { HttpError } = require('../upload');
const config = require('../config');
const bookCache = require('./book-cache');
const importJobs = require('./import');
const { buildBooksStats, listUnmatched } = require('./stats');
const { HardcoverError } = require('./hardcover');
const { LivelibError } = require('./livelib');

const router = express.Router();

const KNOWN_SOURCES = ['livelib', 'hardcover'];

function mapError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof LivelibError) {
    if (err.code === 'livelib_invalid_username') return new HttpError(400, err.message, err.code);
    if (err.code === 'livelib_blocked') return new HttpError(429, err.message, err.code);
    if (err.code === 'livelib_bulk_error') return new HttpError(404, err.message, err.code);
    return new HttpError(502, err.message, err.code);
  }
  if (err instanceof HardcoverError) {
    if (err.code === 'hardcover_token_missing' || err.code === 'hardcover_foreign_user') {
      return new HttpError(400, err.message, err.code);
    }
    return new HttpError(502, err.message, err.code);
  }
  return err;
}

function hardcoverTokenInfo() {
  try {
    const source = config.getHardcoverToken() ? config.hardcoverTokenSource() : null;
    // Only the *origin* of the token is exposed, never the value.
    return { configured: true, source: source === 'file' ? 'file' : 'env' };
  } catch (err) {
    return { configured: false, source: null };
  }
}

/** GET /api/books/profiles — cached source profiles for the switcher/badges. */
router.get('/profiles', (req, res) => {
  const profiles = bookCache.listProfiles();
  res.status(200).json({
    profiles,
    connected: [...new Set(profiles.map((profile) => profile.source))],
    hardcoverToken: hardcoverTokenInfo(),
    cacheDir: bookCache.BOOK_CACHE_DIR,
  });
});

/** POST /api/books/import/livelib { username } */
router.post('/import/livelib', (req, res, next) => {
  try {
    const username = req.body && req.body.username;
    if (!username || typeof username !== 'string') {
      throw new HttpError(
        400,
        'Body must contain "username" (LiveLib reader name or profile URL).',
        'username_required'
      );
    }
    // Accept a full profile URL as a convenience: /reader/Margaret or /users/50064.
    const nameMatch = String(username).match(/\/(?:reader|users)\/([^/?#]+)/);
    const value = nameMatch ? nameMatch[1] : username;
    const job = importJobs.startLivelibImport(value, {
      force: Boolean(req.body && req.body.force === true),
    });
    res.status(202).json(job);
  } catch (err) {
    next(mapError(err));
  }
});

/** POST /api/books/import/hardcover { userId? } — defaults to the token owner. */
router.post('/import/hardcover', (req, res, next) => {
  try {
    const body = req.body || {};
    const job = importJobs.startHardcoverImport(body.userId);
    res.status(202).json(job);
  } catch (err) {
    next(mapError(err));
  }
});

/** GET /api/books/import/status?id=... */
router.get('/import/status', (req, res, next) => {
  try {
    const id = req.query.id;
    if (!id || typeof id !== 'string') {
      throw new HttpError(400, 'Query parameter "id" is required.', 'job_id_required');
    }
    const status = importJobs.getStatus(id);
    if (!status) {
      throw new HttpError(404, 'Unknown import job id.', 'unknown_job');
    }
    res.status(200).json(status);
  } catch (err) {
    next(mapError(err));
  }
});

/** GET /api/books/stats?sources=livelib,hardcover&includeMangaComics=0|1 */
router.get('/stats', (req, res, next) => {
  try {
    const raw = req.query.sources;
    if (raw != null && String(raw).trim() !== '') {
      const wanted = String(raw)
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (!wanted.some((value) => KNOWN_SOURCES.includes(value))) {
        throw new HttpError(
          400,
          `Query parameter "sources" must be a comma separated subset of: ${KNOWN_SOURCES.join(', ')}.`,
          'invalid_sources'
        );
      }
    }
    const includeMangaRaw = req.query.includeMangaComics;
    let includeMangaComics = false;
    if (includeMangaRaw != null && String(includeMangaRaw).trim() !== '') {
      const value = String(includeMangaRaw).trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(value)) includeMangaComics = true;
      else if (!['0', 'false', 'no', 'off'].includes(value)) {
        throw new HttpError(
          400,
          'Query parameter "includeMangaComics" must be 0 or 1 (default 0).',
          'invalid_include_manga'
        );
      }
    }
    const stats = buildBooksStats({ sources: raw, includeMangaComics });
    res.set('X-Books-Build-Ms', String(stats.meta.buildMs));
    res.status(200).json(stats);
  } catch (err) {
    next(mapError(err));
  }
});

/** GET /api/books/unmatched?sources=livelib */
router.get('/unmatched', (req, res, next) => {
  try {
    res.status(200).json(listUnmatched({ sources: req.query.sources }));
  } catch (err) {
    next(mapError(err));
  }
});

module.exports = router;
