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
 * Aggregated book payload. `sources` is the server-side source filter
 * ("livelib", "hardcover" or a comma-separated list); omitted = all connected.
 */
export function getBooksStats({ sources = '', includeMangaComics = null, signal } = {}) {
  const params = new URLSearchParams();
  if (sources) params.set('sources', sources);
  // Always spelled out: the backend default is "exclude", but sending it
  // explicitly keeps the toggle, the chips and the request in one state.
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

export function startBooksImportLivelib(username, { force = false, signal } = {}) {
  const body = { username };
  // `force: true` deliberately skips the 12 h LiveLib reuse window and
  // re-scrapes every page. Only the manual "Обновить профиль" button sets it.
  if (force) body.force = true;
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
