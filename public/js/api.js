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
    throw new ApiError(
      describe(payload, `Сервер ответил ${response.status}`),
      { status: response.status, payload },
    );
  }
  return payload;
}

export function uploadZip(file) {
  const form = new FormData();
  form.append('file', file, file.name);
  return request('/api/upload', { method: 'POST', body: form });
}

export function startEnrich(uploadId) {
  return request('/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  });
}

export function getEnrichStatus(uploadId) {
  return request(`/api/enrich/status?uploadId=${encodeURIComponent(uploadId)}`);
}

export function getStats(uploadId) {
  return request(`/api/stats?uploadId=${encodeURIComponent(uploadId)}`);
}

export function startKinopoiskImport(url) {
  return request('/api/import/kinopoisk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

export function getKinopoiskStatus(uploadId) {
  return request(`/api/import/kinopoisk/status?uploadId=${encodeURIComponent(uploadId)}`);
}
