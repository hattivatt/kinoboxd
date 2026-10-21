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
    const code = payload && typeof payload === 'object' ? payload.error : '';
    // The backend protects every /api/* route once a password is configured.
    // Any protected call may discover that the cookie expired — let the app
    // switch to the login view instead of surfacing a generic 401.
    if (response.status === 401 && code === 'auth_required' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kinoboxd:auth-required'));
    }
    throw new ApiError(
      describe(payload, `Сервер ответил ${response.status}`),
      { status: response.status, payload },
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

export function uploadZip(file, { signal } = {}) {
  const form = new FormData();
  form.append('file', file, file.name);
  return request('/api/upload', { method: 'POST', body: form, signal });
}

export function startEnrich(uploadId, { signal } = {}) {
  return request('/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
    signal,
  });
}

export function getEnrichStatus(uploadId, { signal } = {}) {
  return request(`/api/enrich/status?uploadId=${encodeURIComponent(uploadId)}`, { signal });
}

export function getStats(uploadId, { signal } = {}) {
  return request(`/api/stats?uploadId=${encodeURIComponent(uploadId)}`, { signal });
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
