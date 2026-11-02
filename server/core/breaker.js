'use strict';

/**
 * Source breaker: one implementation for every "stop asking this host for
 * 30 minutes after 403/429" rule.
 *
 * Two modes, same contract:
 *
 *   - **memory** (books providers): no `read`/`write`, state lives in the
 *     object for the process lifetime. `isOpen()`/`trip()`/`reset()` are the
 *     old module-local `breakerUntil` in a reusable form.
 *   - **persisted** (games): `read()`/`write(state)` are supplied by the
 *     domain cache, so the exact file and the exact entry format stay where
 *     they were (`state/games/games-breaker.json` and friends). A restart must
 *     not lose an open breaker, so the default encode/decode is the epoch
 *     `{ until, reason, at }` shape the games cache has always written.
 *     Sources with a different on-disk shape (secondary-details uses ISO
 *     strings plus `code`/`status`) pass `encode`/`decode`.
 *
 * Keys are hosts (`steamcommunity.com`, `store.steampowered.com`,
 * `api.steampowered.com/IUserReviewsService`, `api.gog.com`) or a single
 * source id for memory breakers.
 */

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

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number|(() => number)} [options.cooldownMs] default 30 min
 * @param {() => object} [options.read] persisted state reader
 * @param {(state: object) => void} [options.write] persisted state writer
 * @param {(entry: object) => object} [options.encode] in-memory -> on-disk
 * @param {(raw: object) => object|null} [options.decode] on-disk -> in-memory
 * @param {boolean} [options.swallowWriteErrors=true]
 */
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
      /* best-effort: an unwritable state dir must not hide the real error */
    }
  }

  /** Decoded state: `{ [key]: { until, at, reason, code, status } }`. */
  function state() {
    const raw = rawState();
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      const entry = decode(value);
      if (entry) out[key] = entry;
    }
    return out;
  }

  /** Replace the persisted state verbatim (tests/diagnostics). */
  function replace(raw) {
    persist(raw && typeof raw === 'object' ? raw : {});
  }

  /**
   * The live entry for `key`, or `null`. An expired entry is removed (and the
   * removal persisted), which is what the games sources always did.
   */
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

  /**
   * Open the breaker for `key`.
   * @param {string} key host or source id
   * @param {string|{reason?:string, code?:string, status?:number, untilMs?:number}} [details]
   */
  function trip(key, details) {
    const opts = typeof details === 'string' ? { reason: details } : details || {};
    const timestamp = now();
    const windowMs = opts.untilMs == null ? Number(cooldownOf()) : Number(opts.untilMs);
    const record = {
      until: timestamp + (Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_COOLDOWN_MS),
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

  /** Close one breaker (`key`) or all of them (`key == null`). */
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
