'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_STALE_MS = 60 * 60 * 1000;
const DEFAULT_POLL_MS = 1000;

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function createLock(options = {}) {
  const filePath = options.path;
  if (!filePath) throw new Error('createLock: "path" is required');
  const name = options.name || 'lock';
  const defaultOwner = options.owner || name;
  const defaultStaleMs = Number.isFinite(Number(options.staleMs))
    ? Number(options.staleMs)
    : DEFAULT_STALE_MS;
  const defaultPollMs = Number.isFinite(Number(options.pollMs))
    ? Number(options.pollMs)
    : DEFAULT_POLL_MS;

  function read() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : null;
    } catch (err) {
      return null;
    }
  }

  function isLocked(callOptions = {}) {
    const now = callOptions.now == null ? Date.now() : Number(callOptions.now);
    const staleMs = Number.isFinite(Number(callOptions.staleMs))
      ? Number(callOptions.staleMs)
      : defaultStaleMs;
    const current = read();
    if (!current) return false;
    const startedAt = Date.parse(String(current.startedAt || ''));
    const age = Number.isFinite(startedAt) ? now - startedAt : Infinity;
    if (age > staleMs) return false;
    if (current.pid == null) return false;
    if (Number(current.pid) === process.pid) return true;
    return pidAlive(current.pid);
  }

  function tryAcquire(owner) {
    if (isLocked()) return null;
    const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`;
    const payload = {
      schemaVersion: 1,
      token,
      pid: process.pid,
      owner: String(owner || defaultOwner),
      startedAt: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const fd = fs.openSync(filePath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        if (isLocked()) return null;
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkErr) {
          return null;
        }
        return tryAcquire(owner);
      }
      return null;
    }
  }

  async function acquire(callOptions = {}) {
    const owner = callOptions.owner || defaultOwner;
    const waitMs = Number.isFinite(Number(callOptions.waitMs))
      ? Math.max(0, Number(callOptions.waitMs))
      : 0;
    const pollMs = Number.isFinite(Number(callOptions.pollMs))
      ? Math.max(50, Number(callOptions.pollMs))
      : defaultPollMs;
    const sleep = callOptions.sleep || sleepDefault;
    const started = Date.now();
    for (;;) {
      const token = tryAcquire(owner);
      if (token) return { ok: true, token, waitedMs: Date.now() - started };
      if (Date.now() - started >= waitMs) {
        return { ok: false, token: null, waitedMs: Date.now() - started };
      }
      await sleep(Math.min(pollMs, Math.max(1, waitMs - (Date.now() - started))));
    }
  }

  function release(token) {
    if (!token) return false;
    const current = read();
    if (!current || current.token !== token) return false;
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      return false;
    }
  }

  function clear() {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
    }
  }

  return {
    name,
    path: filePath,
    staleMs: defaultStaleMs,
    pollMs: defaultPollMs,
    read,
    isLocked,
    tryAcquire,
    acquire,
    release,
    clear,
  };
}

module.exports = {
  DEFAULT_STALE_MS,
  DEFAULT_POLL_MS,
  createLock,
  pidAlive,
  sleepDefault,
};
