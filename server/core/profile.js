'use strict';

/**
 * Owner (profile) registry shared by the three domains (U8).
 *
 * Dependency direction is one-way: a domain registers here, this module never
 * imports a domain. The only import is `core/errors`, so the registry cannot
 * grow a require cycle and a domain router stays testable on its own.
 *
 * Contract
 * --------
 *   registerDomainProfiles(domain, listFn)
 *     `listFn()` is called on EVERY read — never at registration time. The
 *     switcher has to see the cache as it is right now, not as it was when the
 *     router module happened to be first required (a finished import must show
 *     up on the next GET, without a server restart).
 *
 *     It returns `{ profiles: Owner[], sources: Source[] }`. A bare array is
 *     accepted as "profiles only" and the sources are then derived from the
 *     owner records (see `deriveSources`).
 *
 *   Owner = {
 *     id,        // stable token, the `?profile=` value (`steam-7656…`)
 *     label,     // name typed by the owner; null when the domain has none
 *     primary: { source, userKey, status, updatedAt },
 *     enrichers: [{ source, userKey, status, updatedAt }],
 *     metrics,   // domain counters (the same object the legacy field carries)
 *     ...extras  // every legacy per-profile field, passed through untouched
 *   }
 *
 *   Source = { id, role: 'primary' | 'enricher', connected, state }
 *     state: 'ready' | 'expired' | 'missing'
 *
 *     `role` is not a guess: a source is `primary` when at least one owner has
 *     it as `primary`, otherwise `enricher`. Domains that want to advertise a
 *     source that is not connected yet send the list explicitly.
 *
 *   resolveOwnerOrThrow(domain, token, opts) -> Owner
 *     `profile_required`  — no token (missing or empty `?profile=`),
 *     `invalid_profile`   — repeated, CSV, whitespace or malformed token,
 *     `unknown_profile`   — a well-formed token that names no cached owner.
 *     The three codes are the ones `books/routes.js` and `games/routes.js`
 *     already answer with, so a route can adopt the helper without changing
 *     what the client (and its tests) see.
 *
 * `opts`:
 *   label     — the human name of the parameter in messages
 *               (`Query parameter "profile"` by default).
 *   pattern   — RegExp the token must match after the generic grammar check
 *               (`/^steam-\d{17}$/i`); a miss is `invalid_profile`.
 *   aliases   — `{ token: id }`, a `Map` or `(token) => id | null`; applied
 *               after the generic check, before the lookup.
 *   require   — `(owner) => boolean`; a false answer is `unknown_profile`
 *               (a cached document that cannot serve the request, e.g. a
 *               Steam profile without a library snapshot).
 *
 * Nothing here touches the caches, the network or the clock: the registry is a
 * pure lookup over what the domains hand it.
 */

const { HttpError } = require('./errors');

/** `source-userKey` grammar. No `/`, no `\`, no `..` — a token is not a path. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

/**
 * Owner ids come from the domain, not from a request: they are accepted as
 * long as they are a single line without path separators. A legacy profile
 * whose userKey is outside the import grammar must still be LISTED (dropping
 * it would hide data the user has); only `resolveOwnerOrThrow` is strict.
 */
const ID_RE = /^[^\s/\\\u0000-\u001f]{1,200}$/;

const STATUSES = Object.freeze(['connected', 'expired']);
const ROLES = Object.freeze(['primary', 'enricher']);
const STATES = Object.freeze(['ready', 'expired', 'missing']);

/** domain -> listFn. Registration order is preserved (diagnostics/tests). */
const registry = new Map();

function domainName(domain) {
  const name = String(domain == null ? '' : domain).trim();
  if (!name) throw new TypeError('[core/profile] domain name is required');
  return name;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value, where) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`[core/profile] ${where} must be a string or null`);
  }
  return value;
}

/**
 * Validate one `primary`/`enrichers[]` binding. A missing `status` means the
 * domain asserts a live connection (`connected`); anything else must be one of
 * the two known values, so a typo cannot leak an unknown status to the client.
 */
function normalizeBinding(binding, where) {
  if (!isPlainObject(binding)) {
    throw new TypeError(`[core/profile] ${where} must be an object`);
  }
  const source = String(binding.source == null ? '' : binding.source).trim();
  if (!source) throw new TypeError(`[core/profile] ${where}.source is required`);
  const status = binding.status == null ? 'connected' : String(binding.status);
  if (!STATUSES.includes(status)) {
    throw new TypeError(`[core/profile] ${where}.status must be one of ${STATUSES.join('|')}`);
  }
  return {
    source,
    userKey: optionalString(binding.userKey, `${where}.userKey`),
    status,
    updatedAt: optionalString(binding.updatedAt, `${where}.updatedAt`),
  };
}

/**
 * Validate one owner record. Extra keys (the legacy per-profile fields) are
 * copied through untouched — this is what makes the unified form additive
 * instead of a second, parallel payload.
 */
function normalizeOwner(domain, owner) {
  if (!isPlainObject(owner)) {
    throw new TypeError(`[core/profile] ${domain}: an owner record must be an object`);
  }
  const id = String(owner.id == null ? '' : owner.id).trim();
  if (!id) throw new TypeError(`[core/profile] ${domain}: owner.id is required`);
  if (!ID_RE.test(id)) {
    throw new TypeError(`[core/profile] ${domain}: owner.id is not a single-line id: ${id}`);
  }
  const label = optionalString(owner.label, `${domain}.${id}.label`);
  const primary = normalizeBinding(owner.primary, `${domain}.${id}.primary`);
  const enrichers = owner.enrichers == null ? [] : owner.enrichers;
  if (!Array.isArray(enrichers)) {
    throw new TypeError(`[core/profile] ${domain}.${id}.enrichers must be an array`);
  }
  const metrics = owner.metrics == null ? {} : owner.metrics;
  if (!isPlainObject(metrics)) {
    throw new TypeError(`[core/profile] ${domain}.${id}.metrics must be an object`);
  }
  return {
    ...owner,
    id,
    label,
    primary,
    enrichers: enrichers.map((entry, index) =>
      normalizeBinding(entry, `${domain}.${id}.enrichers[${index}]`)
    ),
    metrics,
  };
}

/**
 * Default `sources` when a domain sends only owners: one entry per source that
 * actually appears, `primary` winning over `enricher`, `expired` only when
 * every binding of that source is expired.
 */
function deriveSources(profiles) {
  const byId = new Map();
  const touch = (source, role, status) => {
    const entry = byId.get(source) || {
      id: source,
      role: 'enricher',
      connected: true,
      state: 'ready',
      seen: { primary: false, connected: false, expired: false },
    };
    if (role === 'primary') entry.seen.primary = true;
    if (status === 'expired') entry.seen.expired = true;
    else entry.seen.connected = true;
    byId.set(source, entry);
  };
  for (const owner of profiles) {
    touch(owner.primary.source, 'primary', owner.primary.status);
    for (const enricher of owner.enrichers) touch(enricher.source, 'enricher', enricher.status);
  }
  return [...byId.values()].map((entry) => ({
    id: entry.id,
    role: entry.seen.primary ? 'primary' : 'enricher',
    connected: true,
    state: entry.seen.connected ? 'ready' : 'expired',
  }));
}

function normalizeSource(domain, source) {
  if (!isPlainObject(source)) {
    throw new TypeError(`[core/profile] ${domain}: a source record must be an object`);
  }
  const id = String(source.id == null ? '' : source.id).trim();
  if (!id) throw new TypeError(`[core/profile] ${domain}: source.id is required`);
  const role = source.role == null ? 'enricher' : String(source.role);
  if (!ROLES.includes(role)) {
    throw new TypeError(`[core/profile] ${domain}: source "${id}".role must be one of ${ROLES.join('|')}`);
  }
  const state = source.state == null ? (source.connected ? 'ready' : 'missing') : String(source.state);
  if (!STATES.includes(state)) {
    throw new TypeError(`[core/profile] ${domain}: source "${id}".state must be one of ${STATES.join('|')}`);
  }
  return {
    id,
    role,
    connected: Boolean(source.connected),
    state,
    ...(source.label == null ? {} : { label: String(source.label) }),
  };
}

/** Normalize whatever the domain returned into `{ profiles, sources }`. */
function normalizeSnapshot(domain, raw) {
  const input = Array.isArray(raw) ? { profiles: raw } : raw;
  if (!isPlainObject(input)) {
    throw new TypeError(`[core/profile] ${domain}: listFn must return an object or an array`);
  }
  const owners = input.profiles == null ? [] : input.profiles;
  if (!Array.isArray(owners)) {
    throw new TypeError(`[core/profile] ${domain}: listFn().profiles must be an array`);
  }
  if (input.sources != null && !Array.isArray(input.sources)) {
    throw new TypeError(`[core/profile] ${domain}: listFn().sources must be an array`);
  }
  const profiles = owners.map((owner) => normalizeOwner(domain, owner));
  const seen = new Set();
  for (const owner of profiles) {
    if (seen.has(owner.id)) {
      throw new Error(`[core/profile] ${domain}: duplicate owner id "${owner.id}"`);
    }
    seen.add(owner.id);
  }
  const sources =
    input.sources == null
      ? deriveSources(profiles)
      : (Array.isArray(input.sources) ? input.sources : []).map((source) =>
          normalizeSource(domain, source)
        );
  return { profiles, sources };
}

/**
 * Register a domain's lazy lister. Throws on a duplicate registration: two
 * modules claiming one domain is a wiring bug, not a fallback. Tests that need
 * to re-register call `unregisterDomainProfiles(domain)` first.
 */
function registerDomainProfiles(domain, listFn) {
  const name = domainName(domain);
  if (typeof listFn !== 'function') {
    throw new TypeError(`[core/profile] ${name}: listFn must be a function`);
  }
  if (registry.has(name)) {
    throw new Error(`[core/profile] domain "${name}" is already registered`);
  }
  registry.set(name, listFn);
  return listFn;
}

/** Test/diagnostic helper: forget one domain (or every domain). */
function unregisterDomainProfiles(domain) {
  if (domain == null) {
    registry.clear();
    return;
  }
  registry.delete(domainName(domain));
}

function listRegisteredDomains() {
  return [...registry.keys()];
}

function lister(domain) {
  const name = domainName(domain);
  const listFn = registry.get(name);
  if (!listFn) {
    throw new Error(
      `[core/profile] domain "${name}" is not registered (registered: ` +
        `${listRegisteredDomains().join(', ') || '(none)'})`
    );
  }
  return listFn;
}

/** One read: a single `listFn()` call feeds both `profiles` and `sources`. */
function snapshot(domain) {
  const name = domainName(domain);
  return normalizeSnapshot(name, lister(name)());
}

function listOwners(domain) {
  return snapshot(domain).profiles;
}

function listSources(domain) {
  return snapshot(domain).sources;
}

/**
 * Split the raw query value into candidate tokens. A repeated parameter
 * (`?profile=a&profile=b`) arrives as an array; a CSV arrives as one string.
 * Empty parts are ignored, exactly like `books/stats.parseProfileParam`, so
 * `?profile=a&profile=` still counts as one token.
 */
function readToken(raw) {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const parts = [];
  for (const value of values) {
    for (const part of String(value == null ? '' : value).split(',')) {
      const token = part.trim();
      if (token) parts.push(token);
    }
  }
  return parts;
}

function aliasOf(aliases, token) {
  if (!aliases) return null;
  if (typeof aliases === 'function') return aliases(token) || null;
  if (aliases instanceof Map) return aliases.get(token) || aliases.get(token.toLowerCase()) || null;
  if (typeof aliases === 'object') {
    return aliases[token] || aliases[token.toLowerCase()] || null;
  }
  return null;
}

/**
 * Resolve `?profile=` to exactly one registered owner.
 *
 * @param {string} domain
 * @param {string|string[]|undefined} token  raw `req.query.profile`
 * @param {object} [opts]  see the module contract
 * @returns {object} the owner record (with the legacy fields)
 */
function resolveOwnerOrThrow(domain, token, opts = {}) {
  const { profiles } = snapshot(domain);
  const label = opts.label || 'Query parameter "profile"';
  const available = profiles.map((owner) => owner.id);
  const availableText = available.length ? available.join(', ') : '(none)';

  const parts = readToken(token);
  if (parts.length === 0) {
    throw new HttpError(
      400,
      `${label} is required: exactly one profile token "<source>-<userKey>". ` +
        `Available: ${availableText}.`,
      'profile_required'
    );
  }
  if (parts.length > 1) {
    throw new HttpError(
      400,
      `${label} accepts exactly ONE profile, got: ${parts.join(', ')}. ` +
        `Available: ${availableText}.`,
      'invalid_profile'
    );
  }

  const value = parts[0];
  const shapeMiss = opts.pattern ? !opts.pattern.test(value) : false;
  if (!TOKEN_RE.test(value) || value.includes('..') || shapeMiss) {
    throw new HttpError(
      400,
      `${label}: expected "<source>-<userKey>", got: ${value}. Available: ${availableText}.`,
      'invalid_profile'
    );
  }

  const alias = aliasOf(opts.aliases, value);
  const wanted = alias || value;
  const found =
    profiles.find((owner) => owner.id === wanted) ||
    profiles.find((owner) => owner.id.toLowerCase() === wanted.toLowerCase());

  if (!found || (typeof opts.require === 'function' && !opts.require(found))) {
    throw new HttpError(
      400,
      `${label}: not a cached profile: ${value}. Available: ${availableText}.`,
      'unknown_profile'
    );
  }
  return found;
}

module.exports = {
  TOKEN_RE,
  STATUSES,
  ROLES,
  STATES,
  registerDomainProfiles,
  unregisterDomainProfiles,
  listRegisteredDomains,
  snapshot,
  listOwners,
  listSources,
  resolveOwnerOrThrow,
  // exported for domains that only have owners to report
  deriveSources,
};
