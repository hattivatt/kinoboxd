'use strict';

/**
 * `server/core/profile.js` — the owner (profile) registry (U8).
 *
 * Pinned here:
 *   - a domain registers ONE lazy lister: it is not called at registration
 *     time and is called on EVERY read, so a finished import shows up on the
 *     next `GET /api/{domain}/profiles` without a restart;
 *   - the snapshot is validated (a token-shaped `id`, one `primary`, typed
 *     `enrichers`/`metrics`) and the legacy per-profile fields are copied
 *     through untouched — that is what makes the unified form additive;
 *   - `sources` is either declared by the domain or derived from the owners
 *     (`primary` wins over `enricher`, `expired` only when every binding of
 *     that source is expired);
 *   - `resolveOwnerOrThrow` answers the same three codes as the domain routers
 *     (`profile_required` / `invalid_profile` / `unknown_profile`) and refuses
 *     a token that is a path (`../`, `/`), a CSV or a repeated parameter.
 *
 * The registry has no cache/network dependency of its own, so this test
 * registers fake domains and never touches a tmp cache.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const profile = require('../server/core/profile');

const { HttpError } = require('../server/core/errors');

/** A minimal valid owner. */
function owner(id, extra = {}) {
  return {
    id,
    label: null,
    primary: { source: id.split('-')[0], userKey: id.split('-').slice(1).join('-') },
    enrichers: [],
    metrics: {},
    ...extra,
  };
}

function withDomain(name, listFn, fn) {
  profile.registerDomainProfiles(name, listFn);
  try {
    return fn();
  } finally {
    profile.unregisterDomainProfiles(name);
  }
}

function httpError(predicate) {
  return (err) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${err && err.stack}`);
    return predicate(err);
  };
}

test('registration is lazy and every read sees the current cache', () => {
  let calls = 0;
  let rows = [owner('steam-76561198000000001')];

  withDomain(
    'core-profile-lazy',
    () => {
      calls += 1;
      return { profiles: rows };
    },
    () => {
      assert.equal(calls, 0, 'listFn must not run at registration time');
      assert.equal(profile.listOwners('core-profile-lazy').length, 1);
      assert.equal(calls, 1);

      // A finished import: the next read must see it without re-registering.
      rows = [...rows, owner('steam-76561198000000002')];
      const ids = profile.listOwners('core-profile-lazy').map((entry) => entry.id);
      assert.deepEqual(ids, ['steam-76561198000000001', 'steam-76561198000000002']);
      assert.equal(calls, 2);
    }
  );
});

test('snapshot keeps the legacy fields and fills the unified ones', () => {
  withDomain(
    'core-profile-shape',
    () => ({
      profiles: [
        {
          ...owner('livelib-Margaret'),
          // legacy domain fields, passed through untouched
          key: 'livelib-Margaret',
          summary: { eventCount: 3 },
          metrics: undefined,
        },
      ],
    }),
    () => {
      const [entry] = profile.listOwners('core-profile-shape');
      assert.equal(entry.key, 'livelib-Margaret');
      assert.deepEqual(entry.summary, { eventCount: 3 });
      assert.equal(entry.label, null, 'a missing label is null, not undefined');
      assert.deepEqual(entry.metrics, {}, 'a missing metrics is an empty object');
      assert.deepEqual(entry.primary, {
        source: 'livelib',
        userKey: 'Margaret',
        status: 'connected',
        updatedAt: null,
      });
      assert.deepEqual(entry.enrichers, []);
    }
  );
});

test('an invalid owner record fails fast instead of leaking a half-form', () => {
  const cases = [
    ['a path is not a token', { ...owner('livelib-Margaret'), id: '../etc/passwd' }],
    ['an empty id', { ...owner('livelib-Margaret'), id: '  ' }],
    ['a missing primary', { ...owner('livelib-Margaret'), primary: null }],
    ['an unknown status', { ...owner('livelib-Margaret'), primary: { source: 'livelib', status: 'nope' } }],
    ['enrichers that are not an array', { ...owner('livelib-Margaret'), enrichers: 'gog' }],
    ['metrics that are not an object', { ...owner('livelib-Margaret'), metrics: 42 }],
    ['a non-string label', { ...owner('livelib-Margaret'), label: 7 }],
  ];
  for (const [label, record] of cases) {
    assert.throws(
      () =>
        withDomain('core-profile-bad', () => ({ profiles: [record] }), () =>
          profile.listOwners('core-profile-bad')
        ),
      TypeError,
      label
    );
  }

  assert.throws(
    () =>
      withDomain('core-profile-dup', () => ({ profiles: [owner('steam-1'), owner('steam-1')] }), () =>
        profile.listOwners('core-profile-dup')
      ),
    /duplicate owner id/,
    'two owners with one id would make resolveOwnerOrThrow ambiguous'
  );
});

test('sources are derived from the owners when the domain sends only a list', () => {
  const rows = [
    {
      ...owner('steam-1'),
      enrichers: [
        { source: 'gog', userKey: '42', status: 'expired' },
        { source: 'epic', userKey: 'acc-1' },
      ],
    },
    {
      ...owner('steam-2'),
      enrichers: [{ source: 'gog', userKey: '43' }],
    },
  ];
  withDomain('core-profile-derived', () => rows, () => {
    assert.deepEqual(profile.listSources('core-profile-derived'), [
      { id: 'steam', role: 'primary', connected: true, state: 'ready' },
      { id: 'gog', role: 'enricher', connected: true, state: 'ready' },
      { id: 'epic', role: 'enricher', connected: true, state: 'ready' },
    ]);

    // Only expired GOG bindings -> the source itself is expired.
    profile.unregisterDomainProfiles('core-profile-derived');
    profile.registerDomainProfiles('core-profile-derived', () => [rows[0]]);
    const [gog] = profile.listSources('core-profile-derived').filter((entry) => entry.id === 'gog');
    assert.equal(gog.state, 'expired');
    assert.equal(gog.connected, true, 'an expired binding is still a binding');
  });
});

test('a declared sources table wins over the derived one', () => {
  withDomain(
    'core-profile-declared',
    () => ({
      profiles: [owner('steam-1')],
      sources: [
        { id: 'steam', role: 'primary', connected: true, state: 'ready' },
        { id: 'gog', role: 'enricher', connected: false, state: 'missing' },
      ],
    }),
    () => {
      assert.deepEqual(profile.listSources('core-profile-declared'), [
        { id: 'steam', role: 'primary', connected: true, state: 'ready' },
        { id: 'gog', role: 'enricher', connected: false, state: 'missing' },
      ]);
    }
  );

  assert.throws(
    () =>
      withDomain(
        'core-profile-bad-source',
        () => ({ profiles: [], sources: [{ id: 'gog', role: 'secondary' }] }),
        () => profile.listSources('core-profile-bad-source')
      ),
    TypeError,
    'only primary|enricher are roles'
  );
});

test('resolveOwnerOrThrow: exact id, case-insensitive key, alias and pattern', () => {
  const rows = [owner('steam-76561198000000001'), owner('livelib-Margaret')];
  withDomain('core-profile-resolve', () => rows, () => {
    assert.equal(
      profile.resolveOwnerOrThrow('core-profile-resolve', 'steam-76561198000000001').id,
      'steam-76561198000000001'
    );
    // A client may lower-case the token; the canonical id comes back.
    assert.equal(
      profile.resolveOwnerOrThrow('core-profile-resolve', 'LIVELIB-margaret').id,
      'livelib-Margaret'
    );
    // The `?profile=` array form with one value is still one token.
    assert.equal(
      profile.resolveOwnerOrThrow('core-profile-resolve', ['livelib-Margaret', '']).id,
      'livelib-Margaret'
    );
    // Aliases (the films endpoint takes a bare kpUserId) resolve first.
    assert.equal(
      profile.resolveOwnerOrThrow('core-profile-resolve', 'kp:1', {
        aliases: { 'kp:1': 'steam-76561198000000001' },
      }).id,
      'steam-76561198000000001'
    );
    assert.equal(
      profile.resolveOwnerOrThrow('core-profile-resolve', 'x', {
        aliases: (token) => (token === 'x' ? 'livelib-Margaret' : null),
      }).id,
      'livelib-Margaret'
    );
    // A per-domain shape check keeps `invalid_profile` for a foreign token.
    assert.throws(
      () =>
        profile.resolveOwnerOrThrow('core-profile-resolve', 'livelib-Margaret', {
          pattern: /^steam-\d{17}$/i,
        }),
      httpError((err) => err.code === 'invalid_profile' && err.status === 400)
    );
    // `require` is how a route keeps refusing a cached-but-unusable owner.
    assert.throws(
      () => profile.resolveOwnerOrThrow('core-profile-resolve', 'livelib-Margaret', { require: () => false }),
      httpError((err) => err.code === 'unknown_profile')
    );
  });
});

test('resolveOwnerOrThrow: profile_required / invalid_profile / unknown_profile', () => {
  const rows = [owner('steam-76561198000000001')];
  withDomain('core-profile-codes', () => rows, () => {
    const required = [
      undefined,
      null,
      '',
      '   ',
      [],
      [''],
    ];
    for (const raw of required) {
      assert.throws(
        () => profile.resolveOwnerOrThrow('core-profile-codes', raw),
        httpError(
          (err) =>
            err.code === 'profile_required' &&
            err.status === 400 &&
            err.message.includes('steam-76561198000000001')
        ),
        `expected profile_required for ${JSON.stringify(raw)}`
      );
    }

    const malformed = [
      ['a repeated parameter', ['steam-76561198000000001', 'steam-76561198000000002']],
      ['a CSV', 'steam-76561198000000001,steam-76561198000000002'],
      ['whitespace inside the token', 'steam 1'],
      ['a semicolon list', 'steam-1;steam-2'],
      ['a path', '../cache/kp/1.json'],
      ['a slash', 'steam/1'],
      ['a dot-dot key', 'livelib-..'],
      ['an over-long token', `steam-${'1'.repeat(200)}`],
    ];
    for (const [label, raw] of malformed) {
      assert.throws(
        () => profile.resolveOwnerOrThrow('core-profile-codes', raw),
        httpError((err) => err.code === 'invalid_profile' && err.status === 400),
        label
      );
    }

    assert.throws(
      () => profile.resolveOwnerOrThrow('core-profile-codes', 'steam-76561198000000009'),
      httpError(
        (err) =>
          err.code === 'unknown_profile' &&
          err.status === 400 &&
          err.message.includes('steam-76561198000000009') &&
          err.message.includes('steam-76561198000000001')
      )
    );
  });
});

test('the error body is the documented { error, code } shape', () => {
  withDomain('core-profile-body', () => [], () => {
    let caught = null;
    try {
      profile.resolveOwnerOrThrow('core-profile-body', undefined);
    } catch (err) {
      caught = err;
    }
    assert.equal(caught.code, 'profile_required');
    assert.equal(caught.status, 400);
    assert.equal(typeof caught.message, 'string');
    // `respondError` renders exactly these two fields.
    assert.deepEqual(Object.keys({ error: caught.message, code: caught.code }), ['error', 'code']);
  });
});

test('a legacy non-ASCII owner id is listed, not dropped', () => {
  // The import grammar is ASCII, but an older cache may hold another userKey.
  // Listing it is harmless; resolving it stays strict (`invalid_profile`).
  withDomain(
    'core-profile-legacy',
    () => ({ profiles: [owner('livelib-Маргарита')] }),
    () => {
      assert.equal(profile.listOwners('core-profile-legacy')[0].id, 'livelib-Маргарита');
      assert.throws(
        () => profile.resolveOwnerOrThrow('core-profile-legacy', 'livelib-Маргарита'),
        httpError((err) => err.code === 'invalid_profile')
      );
    }
  );
});

test('a domain is registered once; an unknown domain is a wiring error', () => {
  const listFn = () => ({ profiles: [] });
  profile.registerDomainProfiles('core-profile-once', listFn);
  try {
    assert.throws(() => profile.registerDomainProfiles('core-profile-once', listFn), /already registered/);
    assert.ok(profile.listRegisteredDomains().includes('core-profile-once'));
  } finally {
    profile.unregisterDomainProfiles('core-profile-once');
  }

  assert.equal(profile.listRegisteredDomains().includes('core-profile-once'), false);
  assert.throws(() => profile.listOwners('core-profile-unknown'), /is not registered/);
  assert.throws(() => profile.resolveOwnerOrThrow('core-profile-unknown', 'steam-1'), /is not registered/);
  assert.throws(() => profile.registerDomainProfiles('', listFn), TypeError);
  assert.throws(() => profile.registerDomainProfiles('x', 'nope'), TypeError);
});
