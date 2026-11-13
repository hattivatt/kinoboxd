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

export function attachLbZip(uploadId, file, { kpUserId = '', signal } = {}) {
  const form = new FormData();
  if (uploadId) form.append('uploadId', uploadId);
  if (kpUserId) form.append('kpUserId', String(kpUserId));
  form.append('file', file, file.name || 'letterboxd-export.zip');
  return request('/api/attach/lbzip', { method: 'POST', body: form, signal });
}

export function getStats(uploadId, { kpUserId = '', signal } = {}) {
  const params = new URLSearchParams({ uploadId: String(uploadId || '') });
  if (kpUserId) params.set('kpUserId', String(kpUserId));
  return request(`/api/stats?${params.toString()}`, { signal });
}

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

export function getBooksStats({ profile = '', includeMangaComics = null, signal } = {}) {
  const params = new URLSearchParams();
  if (profile) params.set('profile', profile);
  if (includeMangaComics != null) {
    params.set('includeMangaComics', includeMangaComics ? '1' : '0');
  }
  const query = params.toString();
  return request(`/api/books/stats${query ? `?${query}` : ''}`, { signal });
}

export function setBookMangaFlag(workId, mangaComics, { signal } = {}) {
  return request('/api/books/work/flag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workId, mangaComics: Boolean(mangaComics) }),
    signal,
  });
}

export function clearBookMangaFlag(workId, { signal } = {}) {
  return request(`/api/books/work/flag?workId=${encodeURIComponent(workId)}`, {
    method: 'DELETE',
    signal,
  });
}

export function setBookYearOverride(profile, workId, year, { signal } = {}) {
  return request('/api/books/year-override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile,
      workId,
      year: year == null ? null : Number(year),
    }),
    signal,
  });
}

export function startBooksImportLivelib(username, { force = false, deep = false, cookieHeader = '', signal } = {}) {
  const body = { username };
  if (force) body.force = true;
  if (deep) body.deep = deep;
  if (cookieHeader) body.cookieHeader = cookieHeader;
  return request('/api/books/import/livelib', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

export function startBooksImportHardcover(userId, { force = false, signal } = {}) {
  const body = userId != null && userId !== '' ? { userId } : {};
  if (force) body.force = true;
  return request('/api/books/import/hardcover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

export function importBooksLivelibFile({ file, username, shelf = '', resolve = true, signal } = {}) {
  const body = new FormData();
  body.append('username', username == null ? '' : String(username));
  if (shelf) body.append('shelf', String(shelf));
  body.append('resolve', resolve ? '1' : '0');
  body.append('file', file, file && file.name ? file.name : 'livelib-export.json');
  return request('/api/books/import/livelib-file', { method: 'POST', body, signal });
}

export function getBooksProfiles({ signal } = {}) {
  return request('/api/books/profiles', { signal });
}

export async function getBooksImportStatus(jobId, { source = '', signal } = {}) {
  try {
    return await request(`/api/books/import/status?id=${encodeURIComponent(jobId)}&jobId=${encodeURIComponent(jobId)}`, { signal });
  } catch (error) {
    if (source && error && error.status === 404) {
      return request(
        `/api/books/import/${encodeURIComponent(source)}/status?id=${encodeURIComponent(jobId)}&jobId=${encodeURIComponent(jobId)}`,
        { signal },
      );
    }
    throw error;
  }
}

export function getGamesStats({ profile = '', includeFree = null, includeDlc = null, minHours = null, signal } = {}) {
  const params = new URLSearchParams();
  if (profile) params.set('profile', profile);
  if (includeFree != null) params.set('includeFree', includeFree ? '1' : '0');
  if (includeDlc != null) params.set('includeDlc', includeDlc ? '1' : '0');
  if (minHours != null) params.set('minHours', String(minHours));
  const query = params.toString();
  return request(`/api/games/stats${query ? `?${query}` : ''}`, { signal });
}

export function getGamesProfiles({ signal } = {}) {
  return request('/api/games/profiles', { signal });
}

export function startGamesImportSteam({ steamid64 = '', vanityUrl = '', label = '', signal } = {}) {
  const body = {};
  if (steamid64) body.steamid64 = String(steamid64);
  if (vanityUrl) body.vanityUrl = String(vanityUrl);
  if (label) body.label = String(label);
  return request('/api/games/import/steam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

export function getGamesImportStatus(jobId, { profile = '', signal } = {}) {
  const params = new URLSearchParams();
  const id = jobId ? String(jobId) : '';
  if (id) {
    params.set('id', id);
    params.set('jobId', id);
  }
  if (profile) params.set('profile', profile);
  const query = params.toString();
  return request(`/api/games/import/status${query ? `?${query}` : ''}`, { signal });
}

export function startGamesRefresh({ profile = '', signal } = {}) {
  return request('/api/games/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile ? { profile } : {}),
    signal,
  });
}

export function getGameDetails(appid, { profile = '', signal } = {}) {
  const params = new URLSearchParams();
  if (profile) params.set('profile', profile);
  const query = params.toString();
  return request(`/api/games/game/${encodeURIComponent(appid)}${query ? `?${query}` : ''}`, { signal });
}

export function getGamesPersonnel({ profile = '', role = '', limit = 50, signal } = {}) {
  const params = new URLSearchParams();
  if (profile) params.set('profile', profile);
  if (role) params.set('role', role);
  if (limit != null) params.set('limit', String(limit));
  const query = params.toString();
  return request(`/api/games/personnel${query ? `?${query}` : ''}`, { signal });
}

export function getGamesFranchises({ profile = '', signal } = {}) {
  const params = new URLSearchParams();
  if (profile) params.set('profile', profile);
  const query = params.toString();
  return request(`/api/games/franchises${query ? `?${query}` : ''}`, { signal });
}

export function getGamesEnrichStatus({ profile = '', signal } = {}) {
  const params = new URLSearchParams();
  if (profile) params.set('profile', profile);
  const query = params.toString();
  return request(`/api/games/enrich/status${query ? `?${query}` : ''}`, { signal });
}

export function getGamesGogAuthUrl({ signal } = {}) {
  return request('/api/games/gog/auth-url', { signal });
}

export function connectGamesGog({ code = '', profile = '', signal } = {}) {
  const body = { code: String(code || '') };
  if (profile) body.profile = String(profile);
  return request('/api/games/gog/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

export function getGamesGogStatus({ signal } = {}) {
  return request('/api/games/gog/status', { signal });
}

export function startGamesGogImport({ account = '', profile = '', force = false, signal } = {}) {
  const body = {};
  if (account) body.account = String(account);
  if (profile) body.profile = String(profile);
  if (force) body.force = true;
  return request('/api/games/gog/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

export function getGamesGogImportStatus(jobId, { signal } = {}) {
  const params = new URLSearchParams();
  if (jobId) params.set('id', String(jobId));
  const query = params.toString();
  return request(`/api/games/gog/import/status${query ? `?${query}` : ''}`, { signal });
}

export function logoutGamesGog({ account = '', profile = '', signal } = {}) {
  const body = {};
  if (account) body.account = String(account);
  if (profile) body.profile = String(profile);
  return request('/api/games/gog/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}
