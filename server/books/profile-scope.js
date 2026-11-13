'use strict';

const { HttpError } = require('../core/errors');
const { resolveProfileScope, PROFILE_SOURCES } = require('./stats');

function resolveProfileTokenOrThrow(token, label = 'Profile') {
  const scope = resolveProfileScope(token);
  const available = scope.availableProfileKeys;
  const availableText = available.length ? available.join(', ') : '(none)';
  if (!scope.explicit || scope.empty) {
    throw new HttpError(
      400,
      `${label} is required: exactly one source-userKey token ` +
        `(${PROFILE_SOURCES.join('|')}). Available: ${availableText}.`,
      'profile_required'
    );
  }
  if (scope.multi) {
    throw new HttpError(
      400,
      `${label} accepts exactly ONE profile (source-userKey); ` +
        `a books profile is one source + one account. Available: ${availableText}.`,
      'invalid_profile'
    );
  }
  if (scope.malformed.length > 0) {
    throw new HttpError(
      400,
      `${label}: expected "source-userKey" tokens ` +
        `(${PROFILE_SOURCES.join('|')}), got: ${scope.malformed.join(', ')}.`,
      'invalid_profile'
    );
  }
  if (scope.unknown.length > 0) {
    throw new HttpError(
      400,
      `${label}: not a cached profile: ${scope.unknown.join(', ')}. ` +
        `Available: ${availableText}.`,
      'unknown_profile'
    );
  }
  if (scope.selected.length !== 1) {
    throw new HttpError(
      400,
      `${label} must name one cached profile. Available: ${availableText}.`,
      'invalid_profile'
    );
  }
  return scope;
}

function resolveProfileScopeOrThrow(req) {
  return resolveProfileTokenOrThrow(req.query.profile, 'Query parameter "profile"');
}

module.exports = { resolveProfileTokenOrThrow, resolveProfileScopeOrThrow };
