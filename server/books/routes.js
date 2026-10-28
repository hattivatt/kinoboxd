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
const {
  buildBooksStats,
  listUnmatched,
  profileSummary,
  resolveProfileScope,
  PROFILE_SOURCES,
} = require('./stats');
const livelibCookies = require('./livelib-cookies');
const { HardcoverError } = require('./hardcover');
const { LivelibError } = require('./livelib');

const router = express.Router();

const KNOWN_SOURCES = PROFILE_SOURCES;

function mapError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof livelibCookies.CookieError) {
    return new HttpError(400, err.message, err.code);
  }
  if (err instanceof LivelibError) {
    if (err.code === 'livelib_invalid_username') return new HttpError(400, err.message, err.code);
    if (err.code === 'livelib_import_running') return new HttpError(409, err.message, err.code);
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

/**
 * GET /api/books/profiles — cached source profiles for the switcher/badges.
 *
 * Each entry carries:
 *   - `key`       — the exact `?profiles=` token (`livelib-Margaret`),
 *   - `sourceKey` — the minimal provider-qualified key for docs
 *                   (`livelib/Margaret`, `hardcover/34748`),
 *   - `summary`   — compact aggregates (books/events/dates/avgRating),
 *   - `cookies`   — masked cookie-store status (LiveLib only; `present`/`count`).
 */
router.get('/profiles', (req, res) => {
  const profiles = bookCache.listProfiles().map((meta) => {
    const data = bookCache.getProfile(meta.source, meta.userKey);
    return Object.assign({}, meta, {
      key: `${meta.source}-${meta.userKey}`,
      sourceKey: `${meta.source}/${meta.userKey}`,
      summary: profileSummary(data),
      cookies:
        meta.source === 'livelib'
          ? livelibCookies.cookieStatus('livelib', meta.userKey)
          : { present: false, savedAt: null, count: 0 },
    });
  });
  res.status(200).json({
    profiles,
    connected: [...new Set(profiles.map((profile) => profile.source))],
    // Echoed for the frontend/docs: `?profiles=` accepts only these tokens.
    availableProfileKeys: profiles.map((profile) => profile.key),
    hardcoverToken: hardcoverTokenInfo(),
    cacheDir: bookCache.BOOK_CACHE_DIR,
  });
});

/**
 * `force` for the LiveLib re-import is accepted either as a JSON boolean in
 * the body (`{ force: true }`) or as a query flag (`?force=1`). Anything else
 * is a client bug and must not silently turn into a full profile scrape.
 */
function parseForce(bodyValue, queryValue) {
  if (bodyValue != null && typeof bodyValue !== 'boolean') {
    throw new HttpError(400, 'Body field "force" must be a boolean.', 'invalid_force');
  }
  if (bodyValue === true) return true;
  if (queryValue == null || String(queryValue).trim() === '') return false;
  const value = String(queryValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new HttpError(
    400,
    'Query parameter "force" must be 1 or 0 (default 0).',
    'invalid_force'
  );
}

/**
 * POST /api/books/import/livelib { username, force?, cookieHeader? }
 *
 * `cookieHeader` is the plan-B escape hatch for a DDoS-Guard-flagged host: the
 * `Cookie:` value copied from a browser where the profile opens. Accepted as
 * `"Cookie: a=b; c=d"`, `"a=b; c=d"` or a pairs object. It is validated here
 * (400 `invalid_cookie_header`), stored 0600 in `cache-book/cookies/` and never
 * echoed — the job status only reports `cookies.present`.
 */
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
    const force = parseForce(req.body && req.body.force, req.query && req.query.force);
    const cookieHeader =
      (req.body && (req.body.cookieHeader != null ? req.body.cookieHeader : req.body.cookies)) || null;
    const job = importJobs.startLivelibImport(value, { force, cookieHeader });
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

/**
 * Validate `?profiles=` strictly and return the resolved scope.
 *
 * A malformed token, a token that names no cached profile, or a scope that
 * resolves to zero profiles is a 400 — silently widening the scope to
 * "everything" would be worse than an explicit client error.
 */
function resolveProfileScopeOrThrow(raw) {
  const scope = resolveProfileScope(raw);
  if (!scope.explicit) return scope;
  if (scope.malformed.length > 0) {
    throw new HttpError(
      400,
      `Query parameter "profiles": expected "source-userKey" tokens ` +
        `(${PROFILE_SOURCES.join('|')}), got: ${scope.malformed.join(', ')}.`,
      'invalid_profiles'
    );
  }
  if (scope.unknown.length > 0) {
    const available = scope.profiles.map((profile) => `${profile.source}-${profile.userKey}`);
    throw new HttpError(
      400,
      `Query parameter "profiles": not a cached profile: ${scope.unknown.join(', ')}. ` +
        `Available: ${available.length ? available.join(', ') : '(none)'}.`,
      'unknown_profile'
    );
  }
  if (scope.selected.length === 0) {
    throw new HttpError(
      400,
      'Query parameter "profiles" must name at least one cached profile.',
      'invalid_profiles'
    );
  }
  return scope;
}

/**
 * GET /api/books/stats
 *   ?sources=livelib,hardcover      coarse axis (all profiles of those sources)
 *   ?profiles=livelib-Margaret,hardcover-34748   exact profile documents
 *   ?includeMangaComics=0|1
 *
 * `profiles=` wins over `sources=` (a parallel `sources=` is echoed as ignored
 * in `sources.filter`).
 */
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

    const profileScope = resolveProfileScopeOrThrow(req.query.profiles);

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
    const stats = buildBooksStats({
      sources: raw,
      profileScope,
      includeMangaComics,
    });
    res.set('X-Books-Build-Ms', String(stats.meta.buildMs));
    res.status(200).json(stats);
  } catch (err) {
    next(mapError(err));
  }
});

/**
 * POST /api/books/work/flag { workId, mangaComics }
 * Upsert the per-work manual manga/comics override. The body is intentionally
 * strict: `true` = hide as manga/comics, `false` = show again.
 */
router.post('/work/flag', async (req, res, next) => {
  try {
    const body = req.body || {};
    const workId = typeof body.workId === 'string' ? body.workId.trim() : '';
    if (!workId) {
      throw new HttpError(400, 'Body must contain "workId".', 'work_id_required');
    }
    if (typeof body.mangaComics !== 'boolean') {
      throw new HttpError(
        400,
        'Body must contain "mangaComics" as a boolean (true = hide, false = show).',
        'manga_flag_required'
      );
    }
    const entry = await bookCache.setMangaFlag(workId, body.mangaComics);
    res.status(200).json({ workId, ...entry });
  } catch (err) {
    next(mapError(err));
  }
});

/** DELETE /api/books/work/flag?workId=… — remove the override (idempotent). */
router.delete('/work/flag', async (req, res, next) => {
  try {
    const workId = typeof req.query.workId === 'string' ? req.query.workId.trim() : '';
    if (!workId) {
      throw new HttpError(400, 'Query parameter "workId" is required.', 'work_id_required');
    }
    const removed = await bookCache.clearMangaFlag(workId);
    res.status(200).json({ workId, removed });
  } catch (err) {
    next(mapError(err));
  }
});

/** GET /api/books/unmatched?sources=livelib&profiles=livelib-Margaret */
router.get('/unmatched', (req, res, next) => {
  try {
    const profileScope = resolveProfileScopeOrThrow(req.query.profiles);
    res.status(200).json(listUnmatched({ sources: req.query.sources, profileScope }));
  } catch (err) {
    next(mapError(err));
  }
});

module.exports = router;
