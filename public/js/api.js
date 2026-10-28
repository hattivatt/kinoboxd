/* Thin API client for the Express backend (same origin). */

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

async function readBody(response) {
  const type = response.headers.get('content-type') || '';
  try {
    if (type.includes('application/json')) return await response.json();
    return await response.text();
  } catch {
    return null;
  }
}

function describe(payload, fallback) {
  if (payload && typeof payload === 'object') {
    const value = payload.error || payload.message || payload.detail;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object' && typeof value.message === 'string') return value.message;
  }
  if (typeof payload === 'string') {
    const text = payload.trim();
    if (text && text.length < 240 && !text.startsWith('<')) return text;
  }
  return fallback;
}

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new ApiError('Запрос отменён', { code: 'aborted' });
    }
    throw new ApiError('Не удалось связаться с сервером', { code: 'network' });
  }

  const payload = await readBody(response);
  if (!response.ok) {
    const code = payload && typeof payload === 'object'
      ? (typeof payload.code === 'string' ? payload.code
        : payload.error === 'auth_required' ? payload.error : '')
      : '';
    // The backend protects every /api/* route once a password is configured.
    // Any protected call may discover that the cookie expired — let the app
    // switch to the login view instead of surfacing a generic 401.
    if (response.status === 401 && code === 'auth_required' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kinoboxd:auth-required'));
    }
    throw new ApiError(
      describe(payload, `Сервер ответил ${response.status}`),
      { status: response.status, code, payload },
    );
  }
  return payload;
}

/* ---------------- auth ---------------- */

export function getAuthSession() {
  return request('/api/auth/session');
}

export function login(password) {
  return request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

export function logout() {
  return request('/api/auth/logout', { method: 'POST' });
}

/* ---------------- manual matching ---------------- */

export function searchTmdb(query, kind = 'all', { signal } = {}) {
  const params = new URLSearchParams({ q: String(query || ''), kind: kind || 'all' });
  return request(`/api/tmdb/search?${params.toString()}`, { signal });
}

export function matchFilm({ uploadId, slug, tmdbId, kind }) {
  return request('/api/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, slug, tmdbId, kind }),
  });
}

/**
 * Attach a Letterboxd ZIP to the active KinoPoisk import.
 * The server resolves kpUserId from uploadId and persists the attachment.
 */
export function attachLbZip(uploadId, file, { signal } = {}) {
  const form = new FormData();
  form.append('uploadId', uploadId);
  form.append('file', file, file.name || 'letterboxd-export.zip');
  return request('/api/attach/lbzip', { method: 'POST', body: form, signal });
}

export function getStats(uploadId, { signal } = {}) {
  return request(`/api/stats?uploadId=${encodeURIComponent(uploadId)}`, { signal });
}

/* ---------------- cached profiles + comparison ---------------- */

export function getKpProfiles({ signal } = {}) {
  return request('/api/profiles', { signal });
}

export function getCompare(a, b, { signal } = {}) {
  const params = new URLSearchParams({ a: String(a || ''), b: String(b || '') });
  return request(`/api/compare?${params.toString()}`, { signal });
}

export function startKinopoiskImport(url, { signal } = {}) {
  return request('/api/import/kinopoisk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
}

export function getKinopoiskStatus(uploadId, { signal } = {}) {
  return request(`/api/import/kinopoisk/status?uploadId=${encodeURIComponent(uploadId)}`, { signal });
}

/* ---------------- books ---------------- */

/**
 * Aggregated book payload for ONE profile.
 *
 * - `profile` is the mandatory single token (`livelib-Margaret` or
 *   `hardcover-34748`): a books profile is one source + one account, and the
 *   backend answers 400 without it. There is no `sources` parameter and no
 *   multi-profile CSV any more (a union was removed by design).
 */
export function getBooksStats({ profile = '', includeMangaComics = null, signal } = {}) {
  const params = new URLSearchParams();
  if (profile) params.set('profile', profile);
  // Always spelled out: the backend default is "exclude", but sending it
  // explicitly keeps the toggle and the request in one state.
  if (includeMangaComics != null) {
    params.set('includeMangaComics', includeMangaComics ? '1' : '0');
  }
  const query = params.toString();
  return request(`/api/books/stats${query ? `?${query}` : ''}`, { signal });
}

/**
 * Per-work manual manga/comics override.
 * `mangaComics: true` hides the work, `false` shows it again.
 */
export function setBookMangaFlag(workId, mangaComics, { signal } = {}) {
  return request('/api/books/work/flag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workId, mangaComics: Boolean(mangaComics) }),
    signal,
  });
}

/** Drop the override so the detector decides again. */
export function clearBookMangaFlag(workId, { signal } = {}) {
  return request(`/api/books/work/flag?workId=${encodeURIComponent(workId)}`, {
    method: 'DELETE',
    signal,
  });
}

/**
 * Start a LiveLib import.
 *
 * `deep` selects the phase:
 *   - false (default): light — bulk + RSC page 1, ~3 requests;
 *   - 'auto': light, then a background deep scan only while the stored
 *     profile still has events without an exact date;
 *   - true: always deep.
 * The deep phase keeps running server-side; the UI polls `/import/status` and
 * renders `percent` on the «Обновить профиль» button.
 */
export function startBooksImportLivelib(username, { force = false, deep = false, cookieHeader = '', signal } = {}) {
  const body = { username };
  // `force: true` deliberately skips the 12 h LiveLib reuse window and
  // re-scrapes the bulk list. Only the manual "Обновить профиль" button sets it.
  if (force) body.force = true;
  if (deep) body.deep = deep;
  // The raw `Cookie: __ddg1=...` header is sent exactly once, after a 403.
  // The value is never echoed back, stored client-side or logged; the server
  // owns persistence (K5).
  if (cookieHeader) body.cookieHeader = cookieHeader;
  return request('/api/books/import/livelib', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

export function startBooksImportHardcover(userId, { signal } = {}) {
  return request('/api/books/import/hardcover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userId != null && userId !== '' ? { userId } : {}),
    signal,
  });
}

/**
 * Import a `livelib-backup` export file (safe path, §2.1 of the books doc).
 *
 * Multipart, single shot: the server parses the file and merges it into
 * `livelib-{username}`, returning `201 { added, enriched, skipped, shelves,
 * warnings, resolve }`. Nothing is scraped — no request goes to livelib.ru.
 *
 * `shelf` is `read`/`dnf`/`reading`/`wish`; when empty the server sniffs it from
 * the file name (`livelib-{user}-{pagename}-{date}.json`).
 * `resolve` defaults to TRUE: the metadata chain (Hardcover → Литрес → GB → OL)
 * runs in the background, so pages/series/editions arrive without a second
 * click. `resolve: false` sends an explicit `resolve=0` — the offline opt-out.
 */
export function importBooksLivelibFile({ file, username, shelf = '', resolve = true, signal } = {}) {
  const body = new FormData();
  body.append('username', username == null ? '' : String(username));
  if (shelf) body.append('shelf', String(shelf));
  body.append('resolve', resolve ? '1' : '0');
  // A File object keeps its name (used for the shelf sniffing and the audit).
  body.append('file', file, file && file.name ? file.name : 'livelib-export.json');
  return request('/api/books/import/livelib-file', { method: 'POST', body, signal });
}

/**
 * Connected book sources + their cache keys. The manual refresh needs the
 * LiveLib username / Hardcover userId even when the UI was opened in a new
 * browser and `localStorage` has no remembered account anymore.
 */
export function getBooksProfiles({ signal } = {}) {
  return request('/api/books/profiles', { signal });
}

export async function getBooksImportStatus(jobId, { source = '', signal } = {}) {
  try {
    return await request(`/api/books/import/status?id=${encodeURIComponent(jobId)}&jobId=${encodeURIComponent(jobId)}`, { signal });
  } catch (error) {
    // The architecture doc describes per-source status routes; the unified
    // route is the agreed contract. Fall back once if only the former exists.
    if (source && error && error.status === 404) {
      return request(
        `/api/books/import/${encodeURIComponent(source)}/status?id=${encodeURIComponent(jobId)}&jobId=${encodeURIComponent(jobId)}`,
        { signal },
      );
    }
    throw error;
  }
}
