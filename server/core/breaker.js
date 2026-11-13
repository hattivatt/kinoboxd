'use strict';

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

function toEpoch(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultEncode(entry) {
  return { until: entry.until, reason: entry.reason || 'blocked', at: entry.at };
}

function defaultDecode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const until = toEpoch(raw.until);
  if (until == null) return null;
  return {
    until,
    at: toEpoch(raw.at),
    reason: raw.reason == null ? null : String(raw.reason),
    code: raw.code == null ? null : raw.code,
    status: raw.status == null ? null : raw.status,
  };
}

function createBreaker(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const cooldownOf =
    typeof options.cooldownMs === 'function'
      ? options.cooldownMs
      : () => (options.cooldownMs == null ? DEFAULT_COOLDOWN_MS : Number(options.cooldownMs));
  const read = typeof options.read === 'function' ? options.read : null;
  const write = typeof options.write === 'function' ? options.write : null;
  const encode = typeof options.encode === 'function' ? options.encode : defaultEncode;
  const decode = typeof options.decode === 'function' ? options.decode : defaultDecode;
  const swallowWriteErrors = options.swallowWriteErrors !== false;
  let memory = {};

  function rawState() {
    if (!read) return memory;
    try {
      const state = read();
      return state && typeof state === 'object' ? state : {};
    } catch (err) {
      return {};
    }
  }

  function persist(state) {
    if (!write) {
      memory = state;
      return;
    }
    try {
      write(state);
    } catch (err) {
      if (!swallowWriteErrors) throw err;
    }
  }

  function state() {
    const raw = rawState();
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      const entry = decode(value);
      if (entry) out[key] = entry;
    }
    return out;
  }

  function replace(raw) {
    persist(raw && typeof raw === 'object' ? raw : {});
  }

  function entry(key, at) {
    const timestamp = at == null ? now() : Number(at);
    const raw = rawState();
    const value = raw[key];
    if (!value) return null;
    const decoded = decode(value);
    if (!decoded) return null;
    if (decoded.until <= timestamp) {
      delete raw[key];
      persist(raw);
      return null;
    }
    return decoded;
  }

  function isOpen(key, at) {
    return Boolean(entry(key, at));
  }

  function trip(key, details) {
    const opts = typeof details === 'string' ? { reason: details } : details || {};
    const timestamp = now();
    const windowMs = opts.untilMs == null ? Number(cooldownOf()) : Number(opts.untilMs);
    const record = {
      until: timestamp + (Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : DEFAULT_COOLDOWN_MS),
      at: timestamp,
      reason: opts.reason == null ? 'blocked' : String(opts.reason),
      code: opts.code == null ? null : opts.code,
      status: opts.status == null ? null : opts.status,
    };
    const raw = rawState();
    raw[key] = encode(record);
    persist(raw);
    return record;
  }

  function reset(key) {
    const raw = rawState();
    if (key == null) {
      persist({});
      return;
    }
    delete raw[key];
    persist(raw);
  }

  return {
    state,
    replace,
    entry,
    isOpen,
    trip,
    reset,
  };
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  createBreaker,
  toEpoch,
};
