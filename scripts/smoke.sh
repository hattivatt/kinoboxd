#!/usr/bin/env bash
#
# kinoboxd smoke — one HTTP pass over the three heavy payloads.
#
# WHAT IT DOES
#   1. creates a tmp tree under /tmp/opencode/smoke-<pid> (all four cache
#      roots point there; the production app/cache* is never touched);
#   2. seeds the golden fixtures into cache-book/ and cache-games/
#      (`scripts/smoke-seed.js`);
#   3. starts `server/index.js` on a FREE port from 5000–5999 with every
#      network budget/kill switch off, and a preload that registers the
#      golden film upload in memory (`scripts/smoke-preload.js`);
#   4. waits for /api/health, then GETs:
#        /api/stats?uploadId=<seeded>        (films)
#        /api/books/stats?profile=livelib-golden
#        /api/games/stats?profile=steam-76561198000000001
#      printing status, bytes, gzip bytes and meta.buildMs;
#   5. compares the sizes with `test/golden/smoke-baseline.json` (±5%) when
#      that file exists, and kills the server / removes the tmp tree.
#
# REQUIREMENTS
#   - `curl` and `node` on PATH. No TMDB token is needed: the payloads come
#     from the golden fixtures.
#
# ENV
#   SMOKE_PORT=54xx        force the port (still must be free)
#   SMOKE_TMP=/tmp/...     force the tmp tree
#   SMOKE_UPDATE_BASELINE=1  rewrite test/golden/smoke-baseline.json
#   SMOKE_TIMEOUT=30       seconds to wait for /api/health
#
# EXIT
#   0 — every GET answered 200 and every size stayed inside the baseline;
#   1 — a non-200, a missing payload, or a size outside ±5%;
#   2 — setup failure (the server did not start).
#
# Auth is DISABLED for the run (`KINOBOXD_PASSWORD=` is forced empty) so the
# script does not need to log in; it never reads the real password.
#
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${SMOKE_TMP:-/tmp/opencode/smoke-$$}
TIMEOUT=${SMOKE_TIMEOUT:-30}
BASELINE="$ROOT/test/golden/smoke-baseline.json"
FILMS_PROFILE_UPLOAD_ID_FILE="$TMP/upload-id"
FAIL=0

log() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; FAIL=1; }

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# ---- 1. tmp tree -----------------------------------------------------
rm -rf "$TMP"
mkdir -p "$TMP/cache" "$TMP/cache-book" "$TMP/cache-games" "$TMP/state"
log "tmp: $TMP"

# ---- 2. seed fixtures ------------------------------------------------
if ! node "$ROOT/scripts/smoke-seed.js" "$TMP"; then
  log "FAIL: fixture seeding failed" >&2
  exit 2
fi

# ---- 3. free port from 5000-5999 ------------------------------------
PORT=$(node -e '
const net = require("net");
function probe(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(port)));
  });
}
(async () => {
  for (let i = 0; i < 200; i++) {
    const port = 5000 + Math.floor(Math.random() * 1000);
    const free = await probe(port);
    if (free) { console.log(free); return; }
  }
  process.exit(1);
})();
' 2>/dev/null) || {
  log "FAIL: could not pick a free port in 5000-5999" >&2
  exit 2
}
if [ -n "${SMOKE_PORT:-}" ]; then PORT=$SMOKE_PORT; fi
log "port: $PORT"

# ---- 4. start the server --------------------------------------------
NODE_OPTIONS="--require $ROOT/scripts/smoke-preload.js" \
PORT="$PORT" \
SMOKE_TMP="$TMP" \
KINOBOXD_PASSWORD= \
KINOBOXD_CACHE_DIR="$TMP/cache" \
KINOBOXD_CACHE_BOOK_DIR="$TMP/cache-book" \
KINOBOXD_CACHE_GAMES_DIR="$TMP/cache-games" \
KINOBOXD_STATE_DIR="$TMP/state" \
KINOBOXD_EPIC_TOKENS_DIR="$TMP/state/epic-tokens" \
KINOBOXD_STEAM_KEY_FILE=/dev/null \
KINOBOXD_MOBY_KEY_FILE=/dev/null \
KINOBOXD_GAMES_WD=0 \
KINOBOXD_BOOKS_WIKIDATA=0 \
KINOBOXD_GAMES_MOBY=0 \
GAMES_SECONDARY_LAZY_KICK=0 \
BOOKS_LITRES_BUDGET=0 \
BOOKS_GB_BUDGET=0 \
BOOKS_LIVELIB_CARD_BUDGET=0 \
GAMES_STORE_BUDGET=0 \
GAMES_SPY_BUDGET=0 \
GAMES_REVIEWS_BUDGET=0 \
GAMES_SECONDARY_BUDGET=0 \
GAMES_GOG_BUDGET=0 \
GAMES_FRANCHISE_BUDGET=0 \
GAMES_MOBY_BUDGET=0 \
GAMES_BASE_DETAILS_BUDGET=0 \
  node "$ROOT/server/index.js" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

READY=0
i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  log "FAIL: server did not become ready on port $PORT" >&2
  log "--- server.log ---" >&2
  sed -n '1,40p' "$TMP/server.log" >&2 || true
  exit 2
fi

# ---- 5. probes -------------------------------------------------------
# measure <name> <path>
#   prints: name status bytes gzip buildMs
measure() {
  name=$1
  route=$2
  body="$TMP/$name.json"
  raw="$TMP/$name.raw"
  : >"$body"
  : >"$raw"
  status=$(curl -sS --compressed -o "$body" -w '%{http_code}' --max-time 60 \
    "http://127.0.0.1:$PORT$route" 2>/dev/null || echo "000")
  bytes=$(wc -c <"$body" | tr -d ' ')
  gzip_bytes=$(curl -sS -H 'Accept-Encoding: gzip' -o "$raw" -w '%{size_download}' \
    --max-time 60 "http://127.0.0.1:$PORT$route" 2>/dev/null || echo "0")
  build_ms=$(node -e '
const fs = require("fs");
try {
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const value = doc && doc.meta && doc.meta.buildMs;
  process.stdout.write(value == null ? "-" : String(value));
} catch (err) {
  process.stdout.write("-");
}
' "$body" 2>/dev/null || echo "-")
  printf '%-6s status=%s bytes=%s gzip=%s buildMs=%s\n' \
    "$name" "$status" "$bytes" "$gzip_bytes" "$build_ms"
  [ "$status" = "200" ] || fail "$name: HTTP $status"
  [ "$bytes" -gt 100 ] || fail "$name: empty payload ($bytes B)"
}

UPLOAD_ID=""
if [ -f "$FILMS_PROFILE_UPLOAD_ID_FILE" ]; then
  UPLOAD_ID=$(cat "$FILMS_PROFILE_UPLOAD_ID_FILE")
fi
if [ -n "$UPLOAD_ID" ]; then
  measure films "/api/stats?uploadId=$UPLOAD_ID"
else
  log "films  status=SKIP (preload did not seed an upload; see $TMP/server.log)"
fi
measure books "/api/books/stats?profile=livelib-golden"
measure games "/api/games/stats?profile=steam-76561198000000001"

# ---- 6. baseline (±5%) ----------------------------------------------
node -e '
const fs = require("fs");
const path = require("path");
const file = process.argv[1];
const tmp = process.argv[2];
const update = process.env.SMOKE_UPDATE_BASELINE === "1";
const domains = ["films", "books", "games"];
const current = {};
for (const domain of domains) {
  const body = path.join(tmp, domain + ".json");
  if (!fs.existsSync(body)) continue;
  const raw = fs.readFileSync(body, "utf8");
  let buildMs = null;
  try {
    const doc = JSON.parse(raw);
    buildMs = doc && doc.meta && doc.meta.buildMs != null ? doc.meta.buildMs : null;
  } catch (err) {
    buildMs = null;
  }
  current[domain] = { bytes: Buffer.byteLength(raw, "utf8") };
}
if (update) {
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
  console.log("baseline updated: " + file);
  process.exit(0);
}
if (!fs.existsSync(file)) {
  console.log("baseline: " + file + " absent — sizes are informational this run");
  process.exit(0);
}
const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
let bad = 0;
for (const domain of domains) {
  if (!current[domain] || !baseline[domain]) continue;
  const now = current[domain].bytes;
  const was = baseline[domain].bytes;
  const delta = (now - was) / was;
  const pct = (delta * 100).toFixed(1);
  const ok = Math.abs(delta) <= 0.05;
  console.log(
    "baseline " + domain + ": " + was + " B -> " + now + " B (" +
    (delta >= 0 ? "+" : "") + pct + "%) " + (ok ? "ok" : "OUT OF ±5%")
  );
  if (!ok) bad += 1;
}
process.exit(bad === 0 ? 0 : 1);
' "$BASELINE" "$TMP" || FAIL=1

if [ "$FAIL" -ne 0 ]; then
  log "SMOKE FAILED"
  exit 1
fi
log "SMOKE OK"
exit 0
