'use strict';

const gogCache = require('../gog-cache');
const gog = require('../gog');
const { round1 } = require('../../core/stats');

/** How many raw `sessions` answers one run keeps in `cache-games/debug/gog/`. */
const DEBUG_DUMP_LIMIT = 3;
const DEFAULT_RECHECK_ZERO_MS = 24 * 60 * 60 * 1000;

/**
 * Zero-hour rows are re-checked instead of being skipped forever: a 404 or a
 * wrong `{uid}` used to freeze «0 ч» permanently (01.11.2026). Bounded by the
 * same per-run budget, at most once per window.
 */
function recheckZeroMs() {
  const raw = Number(process.env.GAMES_GOG_RECHECK_ZERO_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RECHECK_ZERO_MS;
}

function playtimeTargets(products) {
  // Movies and DLC have no gameplay sessions; `category` is absent on some
  // rows, so unknown rows are kept (a 404 is a real zero).
  return (products || []).filter((product) => {
    if (!product || !product.gogGameId) return false;
    if (product.isMovie === true) return false;
    if (product.isGame === false && product.category !== 'game') return false;
    if (product.category === 'dlc' || product.category === 'movie') return false;
    if (product.isHidden === true) return false;
    return true;
  });
}

async function runPlaytimeStage(job, { tokenApi, tokenDoc, userKey, library, products, budget }) {
  job.stage = 'playtime';
  job.percent = 50;
  const prior = gogCache.getPlaytime(userKey);
  const priorMinutes =
    prior && prior.minutes && typeof prior.minutes === 'object' ? prior.minutes : {};
  const priorEntries =
    prior && prior.entries && typeof prior.entries === 'object' ? prior.entries : {};
  const targets = playtimeTargets(products);
  // The uid this run will use: a snapshot written with a different one has
  // untrustworthy zeros and is re-checked immediately.
  const currentUidSource = gog.gameplayUserId(tokenDoc).source;
  // Every id the token can offer, with its source: the decisive diagnostic
  // for a persisting «0.0 ч» (same number in `token:user_id` and
  // `userData:userId`, different `userData:galaxyUserId` → the order is the
  // remaining bug, not a missing field).
  const uidCandidates = gog.gameplayUserIdCandidates(tokenDoc);
  const minutes = job.force ? {} : { ...priorMinutes };
  const entries = job.force ? {} : { ...priorEntries };
  const errors = [];
  const stats = {
    requests: 0,
    ok: 0,
    notFound: 0,
    zero: 0,
    unparsed: 0,
    errors: 0,
    fields: {},
    uidSource: null,
    // Which numeric ids the token carries and which one the run used. Ids are
    // account labels, not secrets; no token value is included.
    uidCandidates,
    dump: [],
  };
  const sample = [];
  let requests = 0;
  let pending = 0;
  for (const product of targets) {
    const cached = Object.prototype.hasOwnProperty.call(priorMinutes, product.gogGameId);
    // A cached **zero** is not a final answer: a 404 or a wrong `{uid}` wrote
    // it and the 01.11.2026 fix would never reach those rows. Zero-hour games
    // are re-checked (bounded by the same budget), positive ones are reused.
    const cachedPositive = cached && Number(priorMinutes[product.gogGameId]) > 0;
    if (!job.force && cachedPositive) continue;
    if (!job.force && cached && Number(priorMinutes[product.gogGameId]) === 0) {
      // Re-check immediately when the previous snapshot is not trustworthy:
      //   - it was written with a different `{uid}` (the identity fix), or
      //   - the answer did not parse (`unparsed`).
      // Otherwise at most once per `GAMES_GOG_RECHECK_ZERO_MS` (24 h) so a
      // normal import does not hammer the endpoint with dozens of 404s.
      const entry = entries[product.gogGameId] || null;
      const identityChanged = Boolean(prior.uidSource) && prior.uidSource !== currentUidSource;
      const staleAnswer = !entry || entry.status === 'unparsed';
      if (!identityChanged && !staleAnswer) {
        const age = entry.at ? Date.now() - Date.parse(entry.at) : Infinity;
        if (Number.isFinite(age) && age < recheckZeroMs()) continue;
      }
    }
    if (requests >= budget) {
      pending = targets.length - requests - Object.keys(minutes).length;
      job.budgetExceeded = true;
      break;
    }
    const captureRaw = stats.dump.length < DEBUG_DUMP_LIMIT;
    try {
      const session = await tokenApi.getSessions(tokenDoc, product.gogGameId, {
        raw: captureRaw,
      });
      requests++;
      stats.requests++;
      stats.uidSource = stats.uidSource || session.uidSource || null;
      if (session.field) stats.fields[session.field] = (stats.fields[session.field] || 0) + 1;
      // A client that predates the `status` field (or a fake in a test) is
      // read through the old `found` boolean: `found:false` was a 404.
      const status =
        session.status || (session.found === false ? 'not_found' : 'ok');
      if (status === 'ok' && session.minutes != null) {
        stats.ok++;
        if (!(session.minutes > 0)) stats.zero++;
        minutes[product.gogGameId] = session.minutes;
        entries[product.gogGameId] = {
          minutes: session.minutes,
          status: 'ok',
          field: session.field || null,
          at: new Date().toISOString(),
        };
      } else if (status === 'not_found') {
        stats.notFound++;
        minutes[product.gogGameId] = 0;
        entries[product.gogGameId] = {
          minutes: 0,
          status: 'not_found',
          field: null,
          at: new Date().toISOString(),
        };
      } else {
        // 200 without a recognizable field: keep it pending, never a zero.
        stats.unparsed++;
        delete minutes[product.gogGameId];
        entries[product.gogGameId] = {
          minutes: null,
          status: 'unparsed',
          field: null,
          at: new Date().toISOString(),
        };
      }
      if (captureRaw) {
        const dumpDoc = {
          schemaVersion: 1,
          source: 'gog',
          kind: 'sessions-raw',
          gogGameId: String(product.gogGameId),
          title: product.title || null,
          capturedAt: new Date().toISOString(),
          uidSource: session.uidSource || null,
          httpStatus: session.httpStatus || null,
          status: session.status,
          field: session.field || null,
          minutes: session.minutes,
          // The token is never part of the dump: only the answer shape.
          urlShape: `gameplay.gog.com/games/{gogGameId}/users/{uid}/sessions`,
          raw: session.raw || null,
        };
        gogCache.writeDebugDump(String(product.gogGameId), dumpDoc);
        stats.dump.push(String(product.gogGameId));
      }
      if (sample.length < 5) {
        sample.push({
          name: product.title || null,
          gogGameId: String(product.gogGameId),
          hours: session.minutes == null ? null : round1(session.minutes / 60),
          status: session.status,
        });
      }
    } catch (err) {
      if (err && (err.code === 'gog_auth_expired' || err.code === 'gog_auth_required')) {
        throw err;
      }
      if (err && err.code === 'gog_rate_limited') throw err;
      stats.errors++;
      errors.push({
        gogGameId: product.gogGameId,
        code: (err && err.code) || 'gog_error',
        message: gog.maskSecrets((err && err.message) || 'playtime failed'),
      });
      requests++;
      stats.requests++;
    }
    const done = Object.keys(minutes).length;
    job.percent = Math.min(95, 50 + Math.floor((done / Math.max(1, targets.length)) * 45));
    job.playtimeGames = done;
    job.setProgress(done, targets.length);
  }
  if (pending < 0) pending = 0;
  job.playtimePending = pending;
  job.playtime = {
    ...stats,
    targets: targets.length,
    cached: Object.keys(minutes).length,
    pending,
    // `sample` is the first five works of this run: name + hours, so the job
    // summary answers «часы вообще пришли?» without opening the cache.
    sample,
  };
  gogCache.savePlaytime(userKey, {
    userKey,
    ownerProfile: tokenDoc.ownerProfile || null,
    fetchedAt: new Date().toISOString(),
    minutes,
    entries,
    fetchedGames: Object.keys(minutes).length,
    pendingGames: pending,
    budget,
    budgetExceeded: Boolean(job.budgetExceeded),
    uidSource: stats.uidSource,
    uidCandidates,
    fields: stats.fields,
    errors,
    libraryFingerprint: library ? library.fingerprint || null : null,
  });
  job.playtimeGames = Object.keys(minutes).length;
}

module.exports = {
  playtimeTargets,
  runPlaytimeStage,
};
