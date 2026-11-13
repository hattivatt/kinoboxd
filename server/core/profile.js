'use strict';

const { HttpError } = require('./errors');

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

const ID_RE = /^[^\s/\\\u0000-\u001f]{1,200}$/;

const STATUSES = Object.freeze(['connected', 'expired']);
const ROLES = Object.freeze(['primary', 'enricher']);
const STATES = Object.freeze(['ready', 'expired', 'missing']);

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
  deriveSources,
};
