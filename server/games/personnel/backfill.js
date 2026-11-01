'use strict';

/**
 * Manual/live driver for the games personnel layer (ИГРЫ §3.9:
 * `kinoboxd-games-personnel`, monthly). Not wired into a systemd unit in this
 * round — deploy files are the orchestrator's, and the M3 brief forbids
 * touching them.
 *
 *   node server/games/personnel/backfill.js --profile=steam-<steamid64>
 *        [--limit=200] [--force] [--json]
 *
 * What it does: for every library game that already has `details/<appid>.json`
 * it fetches Wikidata credits (batched, ≤450 per query; `P1733` resolves the
 * game item when `links/<appid>.json` has no QID) and, only if a MobyGames key
 * is configured, per-game Moby credits (1.1 s pause, `GAMES_MOBY_BUDGET`).
 * Results are written to `cache-games/personnel/<appid>.json`, including a
 * 90-day negative cache for «no credits».
 *
 * The same `personnel.lock` the server's on-demand job uses is taken first
 * (`GAMES_PERSONNEL_LOCK_WAIT_MS`, default 0): the CLI and a route-triggered
 * pass must not spend the WDQS budget twice or race the same documents.
 *
 * The report never contains a token: Moby status reports `source` only.
 * Exit codes: 0 = ran, 1 = bad usage/unknown profile, 2 = WDQS disabled and
 * Moby not configured (nothing could be fetched), 3 = `personnel.lock` is held
 * by another pass (skipped, 0 requests).
 */

const gameCache = require('../game-cache');
const personnel = require('./personnel');
const wikidata = require('./wikidata');
const moby = require('./moby');
const lock = require('./lock');

function parseArgs(argv) {
  const out = { profileKey: null, limit: 200, force: false, json: false };
  for (const arg of argv) {
    if (arg === '--force') out.force = true;
    else if (arg === '--json') out.json = true;
    else if (arg.startsWith('--profile=')) out.profileKey = arg.slice('--profile='.length).trim();
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.slice('--limit='.length));
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return (
    'Usage: node server/games/personnel/backfill.js --profile=steam-<steamid64> ' +
    '[--limit=200] [--force] [--json]'
  );
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.profileKey) {
    console.error(usage());
    return 1;
  }
  const parsed = gameCache.parseProfileToken(args.profileKey);
  if (!parsed || !gameCache.getLibrary(parsed.userKey)) {
    console.error(
      `Unknown or not imported games profile: ${args.profileKey}. ` +
        `Available: ${gameCache.listProfiles().map((entry) => entry.key).join(', ') || '(none)'}`
    );
    return 1;
  }
  const wdOn = wikidata.wikidataEnabled();
  const mobyOn = moby.mobyEnabled();
  if (!wdOn && !mobyOn) {
    console.error(
      'Nothing to do: Wikidata is disabled (KINOBOXD_GAMES_WD=off) and MobyGames has no key.'
    );
    return 2;
  }
  const lockWaitMs = (() => {
    const raw = Number(process.env.GAMES_PERSONNEL_LOCK_WAIT_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  })();
  const held = await lock.acquireLock({ owner: 'games-personnel-backfill', waitMs: lockWaitMs });
  if (!held.ok) {
    console.error(
      '[games-personnel] personnel.lock is held by another pass (server job?) — ' +
        'skipped, 0 requests. Retry later or raise GAMES_PERSONNEL_LOCK_WAIT_MS.'
    );
    return 3;
  }
  let report;
  try {
    report = await personnel.enrichPersonnel({
      profileKey: parsed.key,
      limit: args.limit,
      force: args.force,
    });
  } finally {
    lock.releaseLock(held.token);
  }
  const summary = {
    ...report,
    wikidata: { enabled: wdOn },
    mobygames: moby.mobyKeyInfo(),
  };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `[games-personnel] ${report.profile}: games=${report.games} updated=${report.updated} ` +
        `fresh=${report.skippedFresh} pendingDetails=${report.pendingDetails} ` +
        `wdQueries=${report.wdQueries}${report.wdSkipped ? ` wdSkipped=${report.wdSkipped}` : ''} ` +
        `mobyRequests=${report.mobyRequests} ` +
        `mobygames=${mobyOn ? moby.mobyKeyInfo().source : 'no-key'}`
    );
    if (report.mobyErrors.length) {
      console.log(`[games-personnel] moby errors: ${report.mobyErrors.join(', ')}`);
    }
    if (report.errors.length) {
      console.log(`[games-personnel] wd errors: ${report.errors.join(', ')}`);
    }
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[games-personnel] ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    });
}

module.exports = { main, parseArgs, usage };
