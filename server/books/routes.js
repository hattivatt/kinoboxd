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
const multer = require('multer');

const { HttpError } = require('../upload');
const config = require('../config');
const bookCache = require('./book-cache');
const importJobs = require('./import');
const livelibFile = require('./livelib-file');
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

function mapError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof livelibCookies.CookieError) {
    return new HttpError(400, err.message, err.code);
  }
  if (err instanceof livelibFile.LivelibFileError) {
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
 *   - `key`       — the exact `?profile=` token (`livelib-Margaret`),
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
      // `/api/books/stats?profile=` tokens. One profile = one source.
      deepScan: (data && data.deepScan) || null,
      cookies:
        meta.source === 'livelib'
          ? livelibCookies.cookieStatus('livelib', meta.userKey)
          : { present: false, savedAt: null, count: 0 },
    });
  });
  res.status(200).json({
    profiles,
    connected: [...new Set(profiles.map((profile) => profile.source))],
    // Echoed for the frontend/docs: `?profile=` accepts one of these tokens.
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

function parseDeep(bodyValue, queryValue) {
  const raw = bodyValue != null ? bodyValue : queryValue;
  if (raw == null || raw === '') return false;
  if (raw === true) return true;
  if (raw === false) return false;
  const value = String(raw).trim().toLowerCase();
  if (['auto', '1', 'true', 'yes', 'on'].includes(value)) {
    return value === 'auto' ? 'auto' : true;
  }
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new HttpError(
    400,
    'Body/query field "deep" must be true, false or "auto" (default false).',
    'invalid_deep'
  );
}

/**
 * POST /api/books/import/livelib { username, force?, deep?, cookieHeader? }
 *
 * `deep` (task two-phase import):
 *   - false (default, ~3 requests): bulk + RSC page 1, dates for the newest 20;
 *   - true: also read every collection page (~63 polite requests) and fill the
 *     exact dates of the already imported events;
 *   - "auto": deep only when the stored profile still has undated events.
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
    const deep = parseDeep(req.body && req.body.deep, req.query && req.query.deep);
    const cookieHeader =
      (req.body && (req.body.cookieHeader != null ? req.body.cookieHeader : req.body.cookies)) || null;
    const job = importJobs.startLivelibImport(value, { force, deep, cookieHeader });
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

/* ------------------------------------------------------------------ */
/* LiveLib export FILE import (livelib-backup)                         */
/* ------------------------------------------------------------------ */

/**
 * Multipart limits: one file. A `livelib-backup` export of 1 245 books with
 * every column ticked is ~2–4 MB of JSON, so 24 MB leaves plenty of room while
 * still refusing an accidental database dump.
 */
const FILE_IMPORT_MAX_BYTES = 24 * 1024 * 1024;
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FILE_IMPORT_MAX_BYTES, files: 1 },
});

/** Accept `Margaret`, `@Margaret`, `/reader/Margaret` or `livelib-Margaret`. */
function parseImportUserKey(body) {
  const raw = body && (body.username || body.userKey || body.profileKey);
  let value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  const fromUrl = /\/(?:reader|users)\/([^/?#]+)/.exec(value);
  if (fromUrl) value = fromUrl[1];
  value = value.replace(/^@/, '');
  const fromKey = /^livelib-(.+)$/i.exec(value);
  if (fromKey) value = fromKey[1];
  return value.trim();
}

/**
 * POST /api/books/import/livelib-file — multipart
 *
 *   file      required  JSON (or CSV) export of livelib-backup
 *   username  required when the profile is new; LiveLib reader name
 *             (aliases: `userKey`, `profileKey` = `livelib-<name>`)
 *   shelf     read|dnf|reading|wish (RU labels accepted); sniffed from the
 *             filename (`livelib-margaret-read-28.10.2026.json`) when omitted
 *   resolve   1 = also run the metadata chain (network, optional)
 *
 * **No request ever leaves the server for livelib.ru**: this is the safe path
 * (see §9 «ban risk»). The parsed rows are merged into
 * `profiles/livelib-{userKey}.json` with `origin: 'livelib-file'`; an event
 * never loses a date it already had, and a shelf upload is additive, so the
 * four pages can be imported in any order.
 *
 * The response is single-shot (no job to poll): counts, shelf tallies and the
 * parser warnings. `resolve: 1` starts the usual background enrichment job,
 * whose progress the dashboard already shows as «Метадата: N%».
 */
router.post('/import/livelib-file', (req, res, next) => {
  fileUpload.single('file')(req, res, (uploadError) => {
    if (uploadError) {
      if (uploadError.code === 'LIMIT_FILE_SIZE') {
        return next(
          new HttpError(
            413,
            `Файл больше ${Math.round(FILE_IMPORT_MAX_BYTES / (1024 * 1024))} МБ.`,
            'file_too_large'
          )
        );
      }
      return next(
        new HttpError(400, `Не удалось принять файл: ${uploadError.message}`, 'upload_failed')
      );
    }
    handleLivelibFileImport(req, res).catch((err) => next(mapError(err)));
  });
});

async function handleLivelibFileImport(req, res) {
  const file = req.file;
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new HttpError(
      400,
      'Форма должна содержать файл экспорта в поле "file" (.json или .csv).',
      'file_required'
    );
  }

  const body = req.body || {};
  const userKey = parseImportUserKey(body);
  if (!userKey) {
    throw new HttpError(
      400,
      'Укажите имя пользователя LiveLib (поле "username"), чтобы файл попал в нужный профиль.',
      'username_required'
    );
  }
  if (!/^[\w.-]{1,64}$/.test(userKey)) {
    throw new HttpError(
      400,
      'Имя пользователя LiveLib: латиница, цифры, «_», «.», «-» (до 64 символов).',
      'invalid_user_key'
    );
  }

  const shelfField = typeof body.shelf === 'string' ? body.shelf.trim() : '';
  let shelf = null;
  if (shelfField) {
    shelf = livelibFile.shelfOf(shelfField);
    if (!shelf) {
      throw new HttpError(
        400,
        `Неизвестная полка "${shelfField}". Допустимо: ${livelibFile.SHELVES.join(', ')} ` +
          'или «Прочитал»/«Не дочитал»/«Читаю сейчас»/«Хочу прочитать».',
        'invalid_shelf'
      );
    }
  }

  if (importJobs.isRunning('livelib', userKey)) {
    throw new HttpError(
      409,
      'Импорт этого профиля с сайта уже выполняется — дождитесь завершения, чтобы файл и скрап не перезаписывали друг друга.',
      'livelib_import_running'
    );
  }

  // Pure parsing: `livelib-file.js` makes no network request.
  const parsed = livelibFile.parseExportFile(file.buffer, {
    filename: file.originalname,
    shelf,
  });
  const resolvedShelf = parsed.shelf || shelf;
  if (!resolvedShelf) {
    throw new HttpError(
      400,
      'Не удалось определить полку файла. Передайте поле "shelf" ' +
        `(${livelibFile.SHELVES.join('|')}) — сервис экспортирует одну страницу за раз, ` +
        'и в самом файле её названия нет.',
      'shelf_required'
    );
  }

  const existing = bookCache.getProfile('livelib', userKey);
  const merged = livelibFile.mergeFileIntoProfile(existing, {
    userKey,
    books: parsed.books,
    shelf: resolvedShelf,
    format: parsed.format,
    filename: file.originalname,
  });

  await bookCache.saveProfile('livelib', userKey, merged.profile);
  await bookCache.saveRawImport('livelib', userKey, {
    totals: parsed.stats,
    shelf: resolvedShelf,
    format: parsed.format,
    origin: livelibFile.ORIGIN,
    added: merged.added,
    enriched: merged.enriched,
    skipped: merged.skipped,
    importedAt: merged.profile.importedAt,
  });

  const resolveJob = body.resolve === true || ['1', 'true', 'yes', 'on'].includes(
    String(body.resolve || '').trim().toLowerCase()
  )
    ? importJobs.startResolveJob()
    : null;

  console.log(
    `[books-import livelib-file] ${userKey}/${resolvedShelf}: ${parsed.books.length} rows, ` +
      `+${merged.added} new, ${merged.enriched} enriched, ${merged.skipped} unchanged ` +
      `(${parsed.format}, ${parsed.stats.withIsbn} isbn)`
  );

  res.status(201).json({
    ok: true,
    source: 'livelib',
    userKey,
    profileKey: `livelib-${userKey}`,
    origin: livelibFile.ORIGIN,
    shelf: resolvedShelf,
    format: parsed.format,
    imported: parsed.books.length,
    added: merged.added,
    enriched: merged.enriched,
    skipped: merged.skipped,
    events: merged.profile.events.length,
    shelves: merged.profile.shelves,
    stats: parsed.stats,
    warnings: parsed.warnings,
    resolve: resolveJob ? { jobId: resolveJob.id, stage: resolveJob.stage } : null,
  });
}

/**
 * DELETE /api/books/import/livelib/cookies?userKey=Margaret
 *
 * The counterpart of the cookie paste: the stored header is a secret the user
 * handed us for one retry, so it must be removable without shell access to the
 * cache directory. Semantics:
 *
 *   - `userKey` (alias `sourceUserKey`) is the LiveLib reader name, validated
 *     with the same shape the store uses (`[\w.-]{1,120}`) — no path tricks;
 *   - no stored header -> 404 `cookies_not_found` (the caller can tell "already
 *     gone" from "wrong userKey"); a successful delete -> 200 with the masked
 *     `{ present: false, savedAt: null, count: 0 }` block;
 *   - a delete during a running import of that profile is 409
 *     `livelib_import_running` — that job already holds its own copy of the
 *     header, and reporting "deleted" while the job still reports
 *     `cookies.present: true` would be a lie;
 *   - the response never echoes the header or its cookie names.
 */
router.delete('/import/livelib/cookies', async (req, res, next) => {
  try {
    const raw = req.query.userKey != null ? req.query.userKey : req.query.sourceUserKey;
    const userKey = typeof raw === 'string' ? raw.trim() : '';
    if (!userKey) {
      throw new HttpError(
        400,
        'Query parameter "userKey" is required (LiveLib reader name).',
        'user_key_required'
      );
    }
    if (!/^[\w.-]{1,120}$/.test(userKey)) {
      throw new HttpError(
        400,
        'Query parameter "userKey" must be 1-120 chars of letters, digits, ".", "_" or "-".',
        'invalid_user_key'
      );
    }
    if (importJobs.isRunning('livelib', userKey)) {
      throw new HttpError(
        409,
        'A LiveLib import of this profile is running — wait for it to finish before removing the cookies.',
        'livelib_import_running'
      );
    }
    const removed = await livelibCookies.clearCookies('livelib', userKey);
    if (!removed) {
      throw new HttpError(
        404,
        `No stored LiveLib cookies for "${userKey}".`,
        'cookies_not_found'
      );
    }
    res.status(200).json({
      source: 'livelib',
      userKey,
      removed: true,
      cookies: livelibCookies.cookieStatus('livelib', userKey),
    });
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
 * Validate the single `?profile=` parameter strictly and return the resolved
 * scope.
 *
 * A missing parameter, a repeated/CSV parameter, a malformed token or a token
 * that names no cached profile is a 400 — silently widening the scope to
 * "everything" (the old union behaviour) is exactly what this contract
 * removes. `?profiles=` is NOT an alias any more: it is an unexpected
 * parameter (400 `unexpected_parameter`).
 */
function resolveProfileScopeOrThrow(req) {
  const scope = resolveProfileScope(req.query.profile);
  const available = scope.availableProfileKeys;
  const availableText = available.length ? available.join(', ') : '(none)';
  if (!scope.explicit || scope.empty) {
    throw new HttpError(
      400,
      'Query parameter "profile" is required: exactly one source-userKey token ' +
        `(${PROFILE_SOURCES.join('|')}). Available: ${availableText}.`,
      'profile_required'
    );
  }
  if (scope.multi) {
    throw new HttpError(
      400,
      'Query parameter "profile" accepts exactly ONE profile (source-userKey); ' +
        `a books profile is one source + one account. Available: ${availableText}.`,
      'invalid_profile'
    );
  }
  if (scope.malformed.length > 0) {
    throw new HttpError(
      400,
      `Query parameter "profile": expected "source-userKey" tokens ` +
        `(${PROFILE_SOURCES.join('|')}), got: ${scope.malformed.join(', ')}.`,
      'invalid_profile'
    );
  }
  if (scope.unknown.length > 0) {
    throw new HttpError(
      400,
      `Query parameter "profile": not a cached profile: ${scope.unknown.join(', ')}. ` +
        `Available: ${availableText}.`,
      'unknown_profile'
    );
  }
  if (scope.selected.length !== 1) {
    throw new HttpError(
      400,
      `Query parameter "profile" must name one cached profile. Available: ${availableText}.`,
      'invalid_profile'
    );
  }
  return scope;
}

/**
 * Strict query contract: the endpoint accepts exactly the listed parameters.
 * An unknown one is a client bug (a stale build still sending `?sources=`,
 * `?profiles=` or a typo), and silently ignoring it would make the payload look
 * like it honoured a filter it never applied.
 */
function assertOnlyParams(req, allowed, endpoint) {
  const keys = Object.keys(req.query || {});
  const extra = keys.filter((key) => !allowed.includes(key));
  if (!extra.length) return;
  const list = extra.map((key) => `"${key}"`).join(', ');
  throw new HttpError(
    400,
    `Unexpected query parameter(s) for ${endpoint}: ${list}. ` +
      `Accepted: ${allowed.map((key) => `"${key}"`).join(', ')}.`,
    'unexpected_parameter'
  );
}

/**
 * GET /api/books/stats?profile=livelib-Margaret&includeMangaComics=0|1
 *
 * `profile` is mandatory and single: the payload is built from that profile's
 * events only (no union with another account/service). Any other query
 * parameter — including the retired `?sources=` and `?profiles=` — is a 400
 * `unexpected_parameter`; there is no compatibility echo any more.
 */
router.get('/stats', (req, res, next) => {
  try {
    assertOnlyParams(req, ['profile', 'includeMangaComics'], 'GET /api/books/stats');
    const scope = resolveProfileScopeOrThrow(req);

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
    const selected = scope.selected[0];
    const stats = buildBooksStats({
      profileScope: scope,
      includeMangaComics,
      resolveState: importJobs.getResolveState(selected.source, selected.userKey),
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

/** GET /api/books/unmatched?profile=livelib-Margaret (single profile). */
router.get('/unmatched', (req, res, next) => {
  try {
    assertOnlyParams(req, ['profile'], 'GET /api/books/unmatched');
    const scope = resolveProfileScopeOrThrow(req);
    res.status(200).json(listUnmatched({ profileScope: scope }));
  } catch (err) {
    next(mapError(err));
  }
});

module.exports = router;
