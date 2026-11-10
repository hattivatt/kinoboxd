'use strict';

const { HttpError } = require('../../../upload');
const gameCache = require('../../game-cache');
const epicCache = require('../../epic-cache');

function assertOnlyParams(req, allowed, endpoint) {
  const keys = Object.keys(req.query || {});
  const extra = keys.filter((key) => !allowed.includes(key));
  if (!extra.length) return;
  throw new HttpError(
    400,
    `Unexpected query parameter(s) for ${endpoint}: ${extra.map((key) => `"${key}"`).join(', ')}. ` +
      `Accepted: ${allowed.map((key) => `"${key}"`).join(', ')}.`,
    'unexpected_parameter'
  );
}

const OWNER_RE = /^steam-(\d{17})$/;
const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,80}$/;

function parseOwner(raw, { requireProfile = false } = {}) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  const match = OWNER_RE.exec(value);
  if (!match) {
    throw new HttpError(
      400,
      `"owner" must be "steam-<steamid64>", got: ${value}.`,
      'invalid_owner'
    );
  }
  if (requireProfile && !gameCache.getProfile(match[1])) {
    throw new HttpError(
      400,
      `"owner": Steam-профиль ${value} ещё не импортирован. Сначала импортируйте Steam-библиотеку.`,
      'unknown_owner'
    );
  }
  return `steam-${match[1]}`;
}

function parseAccountId(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  if (!ACCOUNT_RE.test(value)) {
    throw new HttpError(
      400,
      `"accountId": некорректный Epic accountId: ${value}.`,
      'epic_invalid_account'
    );
  }
  return value;
}

function parseBool(value, name, fallback = false) {
  if (value == null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new HttpError(400, `Parameter "${name}" must be 0 or 1.`, `invalid_${name}`);
}

function resolveAccount({ accountId, owner }, { requireProfile = false } = {}) {
  const parsedOwner = parseOwner(owner, { requireProfile });
  const parsedAccount = parseAccountId(accountId);
  if (parsedAccount) return { accountId: parsedAccount, owner: parsedOwner };
  if (parsedOwner) {
    const bound = epicCache.epicAccountForOwner(parsedOwner);
    if (!bound) {
      throw new HttpError(
        400,
        `У владельца ${parsedOwner} нет подключённого Epic-аккаунта.`,
        'epic_not_connected'
      );
    }
    return { accountId: bound, owner: parsedOwner };
  }
  return { accountId: null, owner: null };
}

module.exports = {
  assertOnlyParams,
  parseOwner,
  parseAccountId,
  parseBool,
  resolveAccount,
};
