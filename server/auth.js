'use strict';

/**
 * Optional password protection.
 *
 *   KINOBOXD_PASSWORD unset/empty  -> auth is disabled, every route is open
 *                                     (the default for local development).
 *   KINOBOXD_PASSWORD set          -> every /api route except /api/auth/*
 *                                     requires a session cookie.
 *
 * Sessions live in memory only: restarting the process (or changing the
 * password and restarting) invalidates all of them.
 */

const crypto = require('crypto');
const express = require('express');

const COOKIE_NAME = 'kinoboxd_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const PASSWORD =
  typeof process.env.KINOBOXD_PASSWORD === 'string' ? process.env.KINOBOXD_PASSWORD : '';
const authRequired = PASSWORD.trim().length > 0;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

// Hashing both sides makes the buffers the same length, so timingSafeEqual
// never throws and does not leak the password length.
const passwordHash = authRequired ? sha256(PASSWORD) : null;

function verifyPassword(candidate) {
  if (!authRequired) return true;
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  return crypto.timingSafeEqual(sha256(candidate), passwordHash);
}

/* ------------------------------------------------------------------ */
/* Cookies (manual parse — no extra dependency)                        */
/* ------------------------------------------------------------------ */

function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length === 0) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch (err) {
      // keep the raw value
    }
    out[name] = value;
  }
  return out;
}

function attachCookies(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  next();
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

const sessions = new Map();

function sweepSessions(now = Date.now()) {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sweepSessions(now);
  sessions.set(token, { createdAt: now, expiresAt: now + SESSION_TTL_MS });
  return token;
}

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_TRACKED = 1000;

function createLoginLimiter(options = {}) {
  const maxFailures = options.maxFailures || LOGIN_MAX_FAILURES;
  const windowMs = options.windowMs || LOGIN_WINDOW_MS;
  const maxTracked = options.maxTracked || LOGIN_MAX_TRACKED;
  const now = options.now || Date.now;
  const failures = new Map();

  function live(key) {
    const entry = failures.get(key);
    if (!entry) return null;
    if (entry.resetAt <= now()) {
      failures.delete(key);
      return null;
    }
    return entry;
  }

  function retryAfterMs(key) {
    const entry = live(key);
    if (!entry || entry.count < maxFailures) return 0;
    return entry.resetAt - now();
  }

  function fail(key) {
    const entry = live(key);
    if (entry) {
      entry.count += 1;
      return;
    }
    if (failures.size >= maxTracked) {
      for (const tracked of failures.keys()) {
        if (!live(tracked)) continue;
        failures.delete(tracked);
        break;
      }
    }
    failures.set(key, { count: 1, resetAt: now() + windowMs });
  }

  function succeed(key) {
    failures.delete(key);
  }

  return { retryAfterMs, fail, succeed, size: () => failures.size };
}

const loginLimiter = createLoginLimiter();

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function sessionToken(req) {
  const cookies = req.cookies || parseCookies(req.headers.cookie);
  return cookies[COOKIE_NAME] || null;
}

function isAuthed(req) {
  if (!authRequired) return true;
  return getSession(sessionToken(req)) !== null;
}

function isAuthRoute(originalUrl) {
  const path = String(originalUrl || '').split('?')[0];
  return path === '/api/auth' || path.startsWith('/api/auth/');
}

/**
 * Gate for every API route. Registered before the routes and skipped for
 * /api/auth/* so that login/logout/session stay reachable.
 */
function requireAuth(req, res, next) {
  if (!authRequired) return next();
  if (isAuthRoute(req.originalUrl)) return next();
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'auth_required', code: 'auth_required' });
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const router = express.Router();

router.post('/login', (req, res) => {
  if (!authRequired) {
    // Auth disabled: nothing to log in to, but do not error out clients.
    return res.status(200).json({ ok: true, authRequired: false, authed: true });
  }
  const clientKey = req.ip || 'unknown';
  const waitMs = loginLimiter.retryAfterMs(clientKey);
  if (waitMs > 0) {
    res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
    return res.status(429).json({ error: 'too_many_attempts', code: 'too_many_attempts' });
  }
  const password = req.body && req.body.password;
  if (!verifyPassword(password)) {
    loginLimiter.fail(clientKey);
    return res.status(401).json({ error: 'wrong_password', code: 'wrong_password' });
  }
  loginLimiter.succeed(clientKey);
  const token = createSession();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
  return res.status(200).json({ ok: true, authRequired: true, authed: true });
});

router.post('/logout', (req, res) => {
  destroySession(sessionToken(req));
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', path: '/' });
  return res.status(200).json({ ok: true, authed: false });
});

router.get('/session', (req, res) => {
  res.status(200).json({ authRequired, authed: isAuthed(req) });
});

module.exports = {
  COOKIE_NAME,
  authRequired,
  attachCookies,
  requireAuth,
  router,
  isAuthed,
  verifyPassword,
  createSession,
  getSession,
  parseCookies,
  sweepSessions,
  createLoginLimiter,
  loginLimiter,
};
