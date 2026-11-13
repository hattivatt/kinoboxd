'use strict';

const express = require('express');
const multer = require('multer');

const { HttpError, mapDomainError } = require('../core/errors');
const config = require('../config');
const bookCache = require('./book-cache');
const importJobs = require('./import');
const livelibFile = require('./livelib-file');
const {
  buildBooksStats,
  profileSummary,
  PROFILE_SOURCES,
} = require('./stats');
const livelibCookies = require('./livelib-cookies');
const profileRegistry = require('../core/profile');
const { resolveProfileTokenOrThrow } = require('./profile-scope');
const { BOOKS_ERROR_PROFILE } = require('./route-errors');
const statsRouter = require('./routes-stats');

const router = express.Router();

function hardcoverTokenInfo() {
  try {
    const source = config.getHardcoverToken() ? config.hardcoverTokenSource() : null;
    return { configured: true, source: source === 'file' ? 'file' : 'env' };
  } catch (err) {
    return { configured: false, source: null };
  }
}

function listBookProfileOwners() {
  const profiles = bookCache.listProfiles().map((meta) => {
    const data = bookCache.getProfile(meta.source, meta.userKey);
    const key = `${meta.source}-${meta.userKey}`;
    const summary = profileSummary(data);
    return Object.assign({}, meta, {
      key,
      sourceKey: `${meta.source}/${meta.userKey}`,
      summary,
      deepScan: (data && data.deepScan) || null,
      cookies:
        meta.source === 'livelib'
          ? livelibCookies.cookieStatus('livelib', meta.userKey)
          : { present: false, savedAt: null, count: 0 },
      id: key,
      label: null,
      primary: {
        source: meta.source,
        userKey: String(meta.userKey),
        status: 'connected',
        updatedAt: meta.importedAt || null,
      },
      enrichers: [],
      metrics: summary,
    });
  });
  const sources = PROFILE_SOURCES.map((source) => {
    const connected = profiles.some((profile) => profile.source === source);
    return { id: source, role: 'primary', connected, state: connected ? 'ready' : 'missing' };
  });
  return { profiles, sources };
}

profileRegistry.registerDomainProfiles('books', listBookProfileOwners);

router.get('/profiles', (req, res) => {
  const { profiles, sources } = profileRegistry.snapshot('books');
  res.status(200).json({
    profiles,
    connected: [...new Set(profiles.map((profile) => profile.source))],
    availableProfileKeys: profiles.map((profile) => profile.key),
    hardcoverToken: hardcoverTokenInfo(),
    cacheDir: bookCache.BOOK_CACHE_DIR,
    sources,
  });
});

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
    const nameMatch = String(username).match(/\/(?:reader|users)\/([^/?#]+)/);
    const value = nameMatch ? nameMatch[1] : username;
    const force = parseForce(req.body && req.body.force, req.query && req.query.force);
    const deep = parseDeep(req.body && req.body.deep, req.query && req.query.deep);
    const cookieHeader =
      (req.body && (req.body.cookieHeader != null ? req.body.cookieHeader : req.body.cookies)) || null;
    const job = importJobs.startLivelibImport(value, { force, deep, cookieHeader });
    res.status(202).json(job);
  } catch (err) {
    next(mapDomainError(err, BOOKS_ERROR_PROFILE));
  }
});

router.post('/import/hardcover', (req, res, next) => {
  try {
    const body = req.body || {};
    const force = parseForce(body.force, req.query && req.query.force);
    const job = importJobs.startHardcoverImport(body.userId, { force });
    res.status(202).json(job);
  } catch (err) {
    next(mapDomainError(err, BOOKS_ERROR_PROFILE));
  }
});

const FILE_IMPORT_MAX_BYTES = 24 * 1024 * 1024;
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FILE_IMPORT_MAX_BYTES, files: 1 },
});

const fileImportLocks = new Set();

const RESOLVE_FALSE_TOKENS = new Set(['0', 'false', 'no', 'off', 'skip']);
const RESOLVE_TRUE_TOKENS = new Set(['1', 'true', 'yes', 'on']);

function resolveFlagOf(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  const token = String(value).trim().toLowerCase();
  if (!token) return null;
  if (RESOLVE_FALSE_TOKENS.has(token)) return false;
  if (RESOLVE_TRUE_TOKENS.has(token)) return true;
  return null;
}

function wantsResolve(req) {
  const fromBody = resolveFlagOf(req.body && req.body.resolve);
  if (fromBody != null) return fromBody;
  const query = req.query && typeof req.query.resolve === 'string' ? req.query.resolve : null;
  const fromQuery = resolveFlagOf(query);
  if (fromQuery != null) return fromQuery;
  return true;
}

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
    handleLivelibFileImport(req, res).catch((err) =>
      next(mapDomainError(err, BOOKS_ERROR_PROFILE))
    );
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

  const lockKey = userKey.toLowerCase();
  if (fileImportLocks.has(lockKey)) {
    throw new HttpError(
      409,
      'Файл этого профиля уже загружается — дождитесь ответа, чтобы две выгрузки не перезаписали друг друга.',
      'livelib_import_running'
    );
  }
  fileImportLocks.add(lockKey);
  try {
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

    const resolveRequested = wantsResolve(req);
    const resolveJob = resolveRequested
      ? importJobs.startResolveJob({ coalesce: false, allowLivelibCard: false })
      : null;

    console.log(
      `[books-import livelib-file] ${userKey}/${resolvedShelf}: ${parsed.books.length} rows, ` +
        `+${merged.added} new, ${merged.enriched} enriched, ${merged.skipped} unchanged ` +
        `(${parsed.format}, ${parsed.stats.withIsbn} isbn, ` +
        `resolve=${resolveJob ? resolveJob.id : 'skipped'})`
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
  } finally {
    fileImportLocks.delete(lockKey);
  }
}

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
    next(mapDomainError(err, BOOKS_ERROR_PROFILE));
  }
});

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
    next(mapDomainError(err, BOOKS_ERROR_PROFILE));
  }
});

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
    next(mapDomainError(err, BOOKS_ERROR_PROFILE));
  }
});

router.delete('/work/flag', async (req, res, next) => {
  try {
    const workId = typeof req.query.workId === 'string' ? req.query.workId.trim() : '';
    if (!workId) {
      throw new HttpError(400, 'Query parameter "workId" is required.', 'work_id_required');
    }
    const removed = await bookCache.clearMangaFlag(workId);
    res.status(200).json({ workId, removed });
  } catch (err) {
    next(mapDomainError(err, BOOKS_ERROR_PROFILE));
  }
});

const YEAR_OVERRIDE_MIN = -3000;
const YEAR_OVERRIDE_MAX = 2100;

router.post('/year-override', async (req, res, next) => {
  try {
    const body = req.body || {};
    const profileToken = typeof body.profile === 'string' ? body.profile.trim() : '';
    if (!profileToken) {
      throw new HttpError(400, 'Body must contain "profile".', 'profile_required');
    }
    const scope = resolveProfileTokenOrThrow(profileToken);
    const selected = scope.selected[0];
    const workId = typeof body.workId === 'string' ? body.workId.trim() : '';
    if (!workId) {
      throw new HttpError(400, 'Body must contain "workId".', 'work_id_required');
    }

    const remove = body.year === undefined || body.year === null;
    if (!remove) {
      const year = Number(body.year);
      if (!Number.isInteger(year) || year === 0 || year < YEAR_OVERRIDE_MIN || year > YEAR_OVERRIDE_MAX) {
        throw new HttpError(
          400,
          `Body field "year" must be an integer in ${YEAR_OVERRIDE_MIN}..${YEAR_OVERRIDE_MAX} ` +
            'or null to remove the correction.',
          'invalid_year'
        );
      }
    }

    if (remove) {
      const removed = await bookCache.clearYearOverride(selected.source, selected.userKey, workId);
      res.status(200).json({
        profile: `${selected.source}-${selected.userKey}`,
        workId,
        year: null,
        removed,
      });
      return;
    }

    const stats = buildBooksStats({ profileScope: scope });
    const known = Boolean(stats.booksIndex[workId]) ||
      Object.values(stats.booksIndex).some(
        (entry) => Array.isArray(entry.mergedWorkIds) && entry.mergedWorkIds.includes(workId)
      );
    if (!known) {
      throw new HttpError(
        400,
        `Work "${workId}" is not part of profile ${selected.source}-${selected.userKey}.`,
        'unknown_work'
      );
    }

    const entry = await bookCache.setYearOverride(
      selected.source,
      selected.userKey,
      workId,
      Number(body.year)
    );
    res.status(200).json({
      profile: `${selected.source}-${selected.userKey}`,
      workId,
      year: entry.year,
      updatedAt: entry.updatedAt,
      removed: false,
    });
  } catch (err) {
    next(mapDomainError(err, BOOKS_ERROR_PROFILE));
  }
});

router.use(statsRouter);

module.exports = router;
