'use strict';

/**
 * Strict request parameter parsing.
 *
 * House rule (`AGENTS.md` §6): an unknown query parameter or an unparsable
 * value is a 400 with a stable code, never a silent ignore. These helpers were
 * duplicated in `books/routes.js` and `games/routes.js`; the messages and the
 * codes are kept identical to the originals so existing clients and tests do
 * not see a behaviour change.
 */

const { HttpError } = require('./errors');

const TRUE_VALUES = ['1', 'true', 'yes', 'on'];
const FALSE_VALUES = ['0', 'false', 'no', 'off'];

function isBlank(raw) {
  return raw == null || String(raw).trim() === '';
}

/**
 * The endpoint accepts exactly the listed query parameters. Anything else is a
 * client bug (a stale build still sending a retired parameter, or a typo), and
 * silently ignoring it would make the payload look like it honoured a filter
 * it never applied.
 */
function assertOnlyParams(req, allowed, endpoint) {
  const keys = Object.keys(req.query || {});
  const extra = keys.filter((key) => !allowed.includes(key));
  if (!extra.length) return;
  const list = extra.map((key) => `"${key}"`).join(', ');
  throw new HttpError(
    400,
    `Unexpected query parameter(s) for ${endpoint}: ${list}. ` +
      `Accepted: ${allowed.map((key) => `"${key}"`).join(', ')}.`,
    'unexpected_parameter'
  );
}

/**
 * Parse a 0/1 flag. `fallback` is returned for a missing/empty value; an
 * unrecognised value is a 400, never the fallback.
 */
function parseBoolean(raw, options = {}) {
  const name = options.name || 'flag';
  const fallback = options.fallback === undefined ? false : options.fallback;
  const code = options.code || `invalid_${name}`;
  const label = options.label || 'Query parameter';
  if (isBlank(raw)) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.includes(value)) return true;
  if (FALSE_VALUES.includes(value)) return false;
  throw new HttpError(400, `${label} "${name}" must be 0 or 1.`, code);
}

/** Query-parameter form: `invalid_<name>` and "Query parameter ...". */
function parseBoolParam(raw, name, fallback) {
  return parseBoolean(raw, { name, fallback, label: 'Query parameter' });
}

/**
 * `minHours`: -1 = every game (0-hour backlog included), 0 = only played
 * works (the endpoint default), N>=1 = works with at least N hours. Anything
 * else (fraction, < -1, text) is a 400, never a silent ignore.
 */
function parseMinHours(raw, fallback = 0) {
  if (isBlank(raw)) return fallback;
  const value = String(raw).trim();
  const message =
    'Query parameter "minHours" must be an integer >= -1 (-1 = all games, 0 = played only).';
  if (!/^-?\d+$/.test(value)) throw new HttpError(400, message, 'invalid_minHours');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < -1) {
    throw new HttpError(400, message, 'invalid_minHours');
  }
  return parsed;
}

/**
 * Integer parameter with an explicit range. `fallback` (default `null`) is
 * returned for a missing/empty value.
 */
function parseInteger(raw, options = {}) {
  const name = options.name || 'value';
  const code = options.code || `invalid_${name}`;
  const fallback = options.fallback === undefined ? null : options.fallback;
  const min = options.min === undefined ? null : options.min;
  const max = options.max === undefined ? null : options.max;
  const message = options.message || `Query parameter "${name}" must be an integer.`;
  if (isBlank(raw)) return fallback;
  const value = String(raw).trim();
  if (!/^-?\d+$/.test(value)) throw new HttpError(400, message, code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, message, code);
  if (min != null && parsed < min) throw new HttpError(400, message, code);
  if (max != null && parsed > max) throw new HttpError(400, message, code);
  return parsed;
}

/** One of a fixed list of values (case-insensitive); anything else is a 400. */
function parseEnum(raw, name, allowed, fallback = null) {
  if (isBlank(raw)) return fallback;
  const value = String(raw).trim().toLowerCase();
  const list = allowed.map((entry) => String(entry).toLowerCase());
  if (list.includes(value)) return allowed[list.indexOf(value)];
  throw new HttpError(
    400,
    `Query parameter "${name}" must be one of: ${allowed.join(', ')}.`,
    `invalid_${name}`
  );
}

module.exports = {
  TRUE_VALUES,
  FALSE_VALUES,
  isBlank,
  assertOnlyParams,
  parseBoolean,
  parseBoolParam,
  parseMinHours,
  parseInteger,
  parseEnum,
};
