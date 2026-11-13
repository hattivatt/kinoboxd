'use strict';

const MAX_HEADER_LENGTH = 8192;
const MAX_COOKIES = 80;

const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

class CookieError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CookieError';
    this.code = code || 'cookie_error';
  }
}

function normalizeCookieHeader(raw) {
  const parts = [];
  const push = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const entry of value) push(entry);
      return;
    }
    if (typeof value === 'object') {
      for (const [name, entryValue] of Object.entries(value)) {
        if (entryValue == null) continue;
        parts.push(`${name}=${entryValue}`);
      }
      return;
    }
    let text = String(value).trim();
    if (!text) return;
    text = text.replace(/^cookie\s*:\s*/i, '');
    parts.push(text);
  };
  push(raw);

  if (parts.length === 0) {
    throw new CookieError(
      'Cookie header пустой: ожидается "Cookie: name=value; name2=value2".',
      'invalid_cookie_header'
    );
  }
  const joined = parts.join('; ');
  if (/[\u0000-\u001f\u007f]/.test(joined)) {
    throw new CookieError(
      'Cookie header содержит управляющие символы (перевод строки/табуляция).',
      'invalid_cookie_header'
    );
  }
  if (joined.length > MAX_HEADER_LENGTH) {
    throw new CookieError(
      `Cookie header длиннее ${MAX_HEADER_LENGTH} символов.`,
      'invalid_cookie_header'
    );
  }

  const pairs = new Map();
  for (const chunk of joined.split(';')) {
    const piece = chunk.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq < 1) {
      throw new CookieError(
        'Cookie header: каждая пара должна быть в формате name=value.',
        'invalid_cookie_header'
      );
    }
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (!COOKIE_NAME_RE.test(name)) {
      throw new CookieError(
        'Cookie header: имя cookie содержит недопустимые символы.',
        'invalid_cookie_header'
      );
    }
    pairs.set(name, value);
  }
  if (pairs.size === 0) {
    throw new CookieError('Cookie header не содержит ни одной пары.', 'invalid_cookie_header');
  }
  if (pairs.size > MAX_COOKIES) {
    throw new CookieError(
      `Cookie header содержит больше ${MAX_COOKIES} cookie — похоже, вставлено лишнее.`,
      'invalid_cookie_header'
    );
  }
  return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function parseCookieHeader(header) {
  const jar = new Map();
  if (!header) return jar;
  const text = String(header).replace(/^\s*cookie\s*:\s*/i, '');
  for (const chunk of text.split(';')) {
    const piece = chunk.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq < 1) continue;
    jar.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  return jar;
}

function countCookies(header) {
  return parseCookieHeader(header).size;
}

module.exports = {
  MAX_HEADER_LENGTH,
  MAX_COOKIES,
  COOKIE_NAME_RE,
  CookieError,
  normalizeCookieHeader,
  parseCookieHeader,
  countCookies,
};
