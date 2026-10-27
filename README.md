# kinoboxd — backend

Node.js/Express backend for KinoPoisk statistics with TMDB enrichment and an
optional Letterboxd archive attachment (package `kinoboxd`).

## Run

```bash
cd app
npm install
npm start          # http://localhost:3000  (PORT env overrides)
```

## Доступ из локальной сети

Сервер слушает на всех интерфейсах (`0.0.0.0`/`::`), поэтому с соседнего
компьютера в той же сети он открывается по IP этого ПК:

```
http://<IP-этого-ПК>:3000
```

IP можно узнать двумя способами:

* в выводе при старте сервера — он печатает все локальные IPv4-адреса:
  `[server]   → http://192.168.x.x:3000  (wlp1s0)`;
* командой `ip addr` (или `ip -4 addr`), смотреть `inet` у активного
  интерфейса (`wlan0`, `wlp1s0`, `enp...` и т.п.).

Если с другого устройства страница не открывается, скорее всего подключение
режет брандмауэр: проверь `sudo ufw status` (при необходимости
`sudo ufw allow 3000/tcp`) либо правила nftables (`sudo nft list ruleset`).
Также убедись, что оба устройства в одной подсети и на роутере не включена
изоляция клиентов (AP isolation).

TMDB read-access token (v4): set `TMDB_API_TOKEN` in the environment
(`TMDB_READ_ACCESS_TOKEN` works as an alias). For local development the
server also accepts a one-line `config/tmdb-token` file, which is
intentionally not committed. If neither is present, startup fails with
`TMDB-токен не найден: задай TMDB_API_TOKEN (read access token v4) в окружении`.

Hardcover Personal Access Token: `HARDCOVER_API_TOKEN` in the environment
(alias `HARDCOVER_READ_TOKEN`); the local fallback is
`config/hardcover-token`. As with TMDB, the environment wins over the file.
A missing Hardcover token only disables book imports/resolve — the server
still starts.

### Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `PORT` | HTTP-порт (по умолчанию `3000`) |
| `TMDB_API_TOKEN` | TMDB read access token v4 (алиас: `TMDB_READ_ACCESS_TOKEN`; локально также `config/tmdb-token`) |
| `KINOBOXD_PASSWORD` | Пароль для доступа к API. Если не задан/пустой — авторизация выключена, API открыто (дефолт для локальной разработки) |
| `KINOBOXD_STATE_DIR` | Каталог состояния в Nix-сборке (по умолчанию `$XDG_STATE_HOME/kinoboxd`) |
| `KINOBOXD_CACHE_DIR` | Переопределяет каталог кэша фильмов. По умолчанию `cache/` рядом с `server/` в исходниках и `$KINOBOXD_STATE_DIR/app/cache` в Nix-обёртке. Изменяет и `index.json`/`details/`, и `kp/` |
| `KINOBOXD_CACHE_BOOK_DIR` | Переопределяет каталог книжного кэша. По умолчанию `cache-book/` рядом с `cache/`, в Nix-обёртке — `$KINOBOXD_STATE_DIR/app/cache-book` |
| `HARDCOVER_API_TOKEN` | Hardcover Personal Access Token (алиас: `HARDCOVER_READ_TOKEN`; локально также `config/hardcover-token`) |
| `HARDCOVER_READ_TOKEN` | Алиас `HARDCOVER_API_TOKEN` |
| `TMDB_API_BASE` | Альтернативный хост TMDB API (например `https://api.tmdb.org/3`), если канонический `api.themoviedb.org` недоступен |
| `REMATCH_DRY_RUN` | `1` — показать изменения `cache/index.json` без записи |
| `REMATCH_CONCURRENCY` | Параллельность `rematch` (по умолчанию 8, максимум 16) |
| `DEBUG_RETRY` | `1` — логировать каждый транспортный retry TMDB (иначе только итоговые счётчики) |

### Пароль (опционально)

Если задан `KINOBOXD_PASSWORD`, все маршруты `/api/*`, кроме `/api/auth/*`,
требуют сессионную cookie. Сессии хранятся в памяти: перезапуск сервера
(в том числе после смены пароля) разлогинивает всех.

```bash
KINOBOXD_PASSWORD=secret PORT=3000 npm start

curl -c jar -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"secret"}'
curl -b jar localhost:3000/api/stats?uploadId=...
```

`GET /api/auth/session` → `{ authRequired, authed }`, доступен всегда.
Статика (`public/`) намеренно не защищается: фронтенд сам решает, что
показывать, а данные всё равно приходят только через API.

Frontend static files live in `app/public` (`index.html` is served for all
non-API routes).

## Troubleshooting

Порт 3000 занят. Возможно, сервер уже запущен на http://localhost:3000, либо запусти с другим портом: PORT=3001 npm start

## API

| Method | Route | Description |
| --- | --- | --- |
| POST | `/api/import/kinopoisk` | `{ "url": "https://www.kinopoisk.ru/user/<id>/..." }`, starts a KinoPoisk import (or a delta refresh of a cached profile) |
| GET | `/api/import/kinopoisk/status?uploadId=...` | `{ stage, page, pageTotal, total, matched, failed, done, warning }` |
| POST | `/api/attach/lbzip?uploadId=...` | multipart/form-data, field `file` = Letterboxd ZIP; attaches the archive to the active KinoPoisk import (see below) |
| GET | `/api/stats?uploadId=...` | full statistics payload (400 until enrichment is done) |
| GET | `/api/profiles` | cached KinoPoisk profiles: `[{ kpUserId, nick, entries, attachedLb, ratedCount }]`, sorted by `entries` desc |
| GET | `/api/compare?a=<userId>&b=<userId>` | read-only comparison of two cached profiles (see below); 400 for the same id, 404 for an unknown profile |
| GET | `/api/tmdb/search?q=...&kind=movie\|tv\|all` | TMDB search for manual matching, `{ results: [{ id, kind, title, year, posterPath, voteAverage }] }` |
| POST | `/api/match` | `{ uploadId, slug, tmdbId, kind }` — attach a TMDB entry to an unmatched film; repeat of the same match is idempotent (`alreadyMatched`), a different rematch returns 409 |
| POST | `/api/auth/login` | `{ password }` → session cookie (only when `KINOBOXD_PASSWORD` is set) |
| POST | `/api/auth/logout` | drop the session and clear the cookie |
| GET | `/api/auth/session` | `{ authRequired, authed }` |
| GET | `/api/health` | liveness probe |

`/api/stats` also returns `summary.unmatchedCount` and a top-level
`unmatched: [{ slug, title, year }]` list — the films TMDB could not match
(or whose details are missing). `/api/match` accepts a `slug` from that list
and either `kind` (`movie`/`tv`), which is how a Letterboxd "film" that is
really a series (e.g. WandaVision) gets matched as TV. The cached index value
becomes `{ id, kind }`, and enrichment/stats honour that kind on the next run.

CSV files are located by basename anywhere inside the ZIP, so nested folders
work. `diary.csv` / `watched.csv` / `ratings.csv` are parsed with a proper
quoted-CSV parser.

## Profile comparison

`GET /api/compare?a=15702206&b=3063379` compares two **cached** KinoPoisk
profiles without touching KinoPoisk. It works after a server restart because
everything is rebuilt from the persistent caches: `cache/kp/{userId}.json`,
the shared TMDB `details/` + `index.json`, and `cache/profile-lb/{userId}.json`
when an attachment exists.

```json
{
  "a": { "kpUserId": "15702206", "nick": "Axis", "filmCount": 1376,
         "viewCount": 1377, "rewatchCount": 16, "hasAttachment": true,
         "ratedCount": 1376, "avgRating": 7.54, "totalMinutes": 147509,
         "dateFrom": "2019-01-27", "dateTo": "2026-10-25" },
  "b": { "...": "same shape" },
  "intersection": 1315, "uniqueA": 61, "uniqueB": 1154,
  "genres":    [{ "name": "Драма", "countA": 552, "countB": 855, "delta": -303 }],
  "actors":    [{ "name": "Johnny Depp", "countA": 22, "countB": 36, "delta": -14 }],
  "directors": [{ "name": "Alfred Hitchcock", "countA": 16, "countB": 16, "delta": 0 }],
  "ratings":   [{ "score": 10, "countA": 9, "countB": 116 }]
}
```

* `intersection` is the number of shared **TMDB ids** (matched films).
* `uniqueA` / `uniqueB` are `filmCount - intersection`, so they include films
  that TMDB could not match. Films without a TMDB id can never be shared.
* `genres` is the top 12 by `countA + countB` (TMDB genres plus derived
  categories, exactly the merged `/api/stats` genre list). `actors` (counted
  significant roles) and `directors` are top 10 by the same sum. `delta` is
  `countA - countB`, so negative values favour profile B.
* `avgRating` is the mean KinoPoisk rating on the native 1–10 scale;
  `totalMinutes` comes from the cached TMDB runtimes (same as
  `summary.totalMinutes` on the dashboard). `viewCount` is the number of
  viewings including rewatches (`summary.viewCount`); with an attachment it is
  larger than `filmCount`, without one it is the one-viewing-per-film proxy and
  equals `filmCount`. `rewatchCount` counts the attached diary rewatch events.

The endpoint builds `kp.buildDataset()` + an ephemeral enrich map and reuses
`stats.buildStats(upload, jobOverride)`; the override keeps the fake job out of
the live enrich registry, so the normal `/api/stats` flow is unchanged.
`X-Compare-Ms` reports the server-side compute time. The first call for a
profile pair is ~1.5 s on a 1.4k/2.5k profile pair, subsequent calls are
~50 ms (the derived model is cached until the profile file's mtime/size
changes). Payload is ~2.8 KB.

## Letterboxd attachment (KinoPoisk profiles)

Letterboxd is not a profile source anymore: it is an attachment to the active
KinoPoisk profile. The backend keeps it in `cache/profile-lb/{kpUserId}.json`
and re-reads that file on every `/api/stats` build, so it survives restarts,
re-imports and delta refreshes without a re-attach.

```bash
curl -X POST "http://localhost:3000/api/attach/lbzip?uploadId=$UPLOAD_ID" \
  -F "file=@letterboxd-export.zip"
```

The endpoint requires the `uploadId` of a live KinoPoisk import (the server
resolves `kpUserId` from that job), a valid ZIP and both `diary.csv` and
`watched.csv`; otherwise it returns 400. Re-posting replaces the whole
attachment atomically (idempotent — no duplicate events).

Response (extra fields are informational):

```json
{
  "attached": true,
  "fileName": "letterboxd-export.zip",
  "events": 1371,
  "diaryEvents": 385,
  "watchedEvents": 986,
  "rewatchCount": 16,
  "matched": 1324,
  "matchedFilms": 1323,
  "films": 1370,
  "watchlist": 72,
  "learnedLinks": 9
}
```

Data model:

```json
{
  "attachedAt": "2026-10-26T08:17:40.916Z",
  "fileName": "letterboxd-export.zip",
  "events": [{
    "tmdbId": 630,
    "lbSlug": "29Xu",
    "title": "The Wizard of Oz",
    "year": 1939,
    "rating": 4,
    "watchDate": "2024-11-22",
    "rewatch": false,
    "source": "diary"
  }],
  "watchlist": [{ "lbSlug": "NKc", "title": "Rio", "year": 2011, "listedAt": "2024-12-20" }]
}
```

* `events` keeps every dated archive event: diary rows (real `Watched Date`,
  fallback `Date`) plus one `watched.csv` fallback event for films that have no
  diary row. The latter survive for the future watchlist/rewatch UI but are
  **not** used for the timeline or `watchedDate` (their date is the export
  date, not a real viewing).
* Every film is matched through the shared TMDB matcher (`server/tmdb.js`,
  strict + broad rules) after checking `cache/index.json`; a known miss is not
  re-requested. Matched events also teach the global `cache/lb-links.json`
  mapping (`first wins`).
* The whole archive is stored, including films outside the current KinoPoisk
  set. Stats only apply events whose `tmdbId` belongs to a KinoPoisk film, so a
  later delta refresh integrates new films automatically.

Stats changes for a KinoPoisk profile with an attachment:

* `filmsIndex[slug].watchedDate` = latest diary `watchDate` of that TMDB film;
  films without a diary event keep the KinoPoisk rating date as a proxy.
* `timeline` months use the real watch dates; each diary event is one viewing,
  so rewatches add extra rows. KinoPoisk films without an event contribute one
  proxy viewing in the rating month. `watched` counts every viewing;
  `rated` counts viewings of films that have a KinoPoisk rating;
  `rewatchCount` counts only diary events with `Rewatch=true` (the rating-date
  proxy has no rewatch signal).
* `summary.viewCount` = `sum(timeline.watched)`, the total viewings including
  rewatches. Without an attachment it equals `summary.filmCount`.
* `rewatches` = `[{ slug, count }]` for KinoPoisk films with at least **two
  diary events marked `Rewatch=true`** (`count` = number of such events).
* `summary.rewatchCount` counts all archive events with `rewatch=true`;
  `summary.attachedLb = { fileName, attachedAt, events, ratedEvents }`, where
  `events`/`ratedEvents` are the diary events actually applied to the
  KinoPoisk film set (and how many belong to rated films).
* `watchDays = [{ date: "YYYY-MM-DD", count, rewatchCount, slugs: [filmSlug, …] }]`
  is the day-level view of exactly the same events that feed `timeline`:
  `sum(watchDays.count) === sum(timeline.watched)` by construction. Diary
  events contribute one entry per viewing (a rewatch repeats the slug);
  `rewatchCount` counts the diary rewatch events of that day (0 for
  proxy-only days). A KinoPoisk film without a diary event contributes one
  proxy viewing on its rating date. Without an attachment every film
  contributes that proxy, so the sum equals `summary.filmCount`. `slugs` is
  what the calendar day modal lists; the array is omitted in the compact
  mental model above but always present (one entry per viewing).
* `recentlyWatched = [{ date, slug, rewatch }]` — the newest 15 viewings,
  newest first (`rewatch` is `null` for the KinoPoisk rating-date proxy).
* `streaks = { current, best, lastWatchDate, bestDates: [from, to] }` — runs
  of consecutive calendar days with at least one viewing. `current` is the
  run ending at the latest viewing, independent of today's date; the UI adds
  the softer "last watch was N days ago" hint. All dates are UTC `YYYY-MM-DD`
  strings: a 00:30 MSK rating is stored by KinoPoisk as the previous UTC day.

`POST /api/upload` and `/api/enrich` still exist for backwards compatibility
with old clients/tests, but the web UI no longer creates standalone Letterboxd
profiles. Legacy `type:'lb'` profiles are deleted from IndexedDB on boot.

## KinoPoisk: delta refresh

A profile that was already scraped is cached in `cache/kp/{userId}.json`.
The next import does not blindly replay that file: it first compares it with
KinoPoisk (one page of `perpage/200`, sorted by rating date, newest first) and
downloads only the missing votes.

Pipeline stages reported by `/api/import/kinopoisk/status`:

`refresh` → `enrich` → `done` (the fast path; 1 KinoPoisk request)
`refresh` → `scrape` → `enrich` → `done` (fallback re-scrape)
`refresh` → `enrich` → `done` with `warning` (KinoPoisk unavailable, stale cache used)

Rules:

* novelty is decided by `kpId` set membership, not by `.num` (the numbering
  shifts whenever a rating is added); new entries are prepended in
  `ratedAt`-descending order so the entry schema stays identical to a full
  scrape;
* if page 1 is entirely unknown (very stale cache), pages 2..5 are fetched
  until an entry from the cache appears (`REFRESH_MAX_PAGES = 5`);
* if KinoPoisk reports fewer records than the cache, or cache + new would
  exceed the reported total (ratings were deleted), the import falls back to
  a full re-scrape; the same happens when no intersection is found within the
  5-page cap;
* if the refresh itself fails (captcha, network, parser), the import still
  succeeds from the stale cache and adds `warning` to the status; `error` is
  only set for a genuinely failed full scrape;
* without a cached profile the import starts directly in `scrape` (old
  behaviour). KinoPoisk requests stay serialized across imports, and
  concurrent imports of the same user share one job.

## Cache

* `cache/index.json` — `"normalized title|year"` → TMDB id, `false`
  (definitively not found, e.g. TV series that TMDB `/search/movie` can't
  return), or `{ id, kind }` for a manual match.
* `cache/details/{tmdbId}.json` — `{ details, credits }`.
* `cache/kp/{userId}.json` — `{ fetchedAt, kpNick, entries }` of a KinoPoisk
  profile. Kept in sync with KinoPoisk by the delta refresh described above.
* `cache/profile-lb/{kpUserId}.json` — persistent Letterboxd attachment
  (events, watchlist, file metadata) described above. Replaced atomically on
  re-attach; independent of the in-memory `uploadId`.
* `cache/lb-links.json` — global `"tmdbId"` → `{ lbUri, kind }` mapping learned
  from every enriched Letterboxd upload and every attachment event.
  Letterboxd links cannot be derived from a TMDB id, so KinoPoisk (and any
  other source) films pick up the `boxd.it` link of the same TMDB film from
  this file. The first learned URI wins; the mapping survives restarts and is
  independent of the upload that taught it.
* `cache/wd-tags.json` — Wikidata enrichment (see below). Written by the
  `backfill:wikidata` CLI; the running server reloads it on the next stats
  build when its mtime/size changed, so no restart is needed.

The cache is global and persisted before/after restart. Re-attaching a
Letterboxd archive with overlapping films performs no TMDB requests; films
already known to the index resolve from the cache (a KinoPoisk import still
checks the profile's newest page, see above).

TMDB requests are capped at 12 concurrent; HTTP 429 is retried up to 5 times
with `Retry-After`/exponential backoff. Transport failures (`fetch failed`,
connection resets, timeouts) and 5xx responses are retried four times with a
1/2/4/8 s backoff; `DEBUG_RETRY=1` logs each retry, otherwise only the
aggregate counters are printed at the end of an import/backfill run. Every
KinoPoisk import also retries its transport-failed films once after the main
pass (`retriedSuccesses` in the `done:` line), so a flaky endpoint no longer
leaves a tail of false negatives.

### Nix-сборка: штампы и канонический кэш

Nix-store read-only, поэтому обёртки из `package.nix` и `flake.nix` не
запускают сервер прямо из store. При каждом запуске создаётся **штамп** —
записываемая копия `server/` для конкретной версии кода:

```
$KINOBOXD_STATE_DIR/app/
  cache/                    кэш фильмов   (KINOBOXD_CACHE_DIR)
  cache-book/               кэш книг      (KINOBOXD_CACHE_BOOK_DIR)
  server@<store-hash>/      штамп текущей версии
    server/                 копия server/ из store (режим u+rw)
    public -> store/...     симлинк
    node_modules -> store/... симлинк
    config -> $state/app/config  симлинк (fallback config/{tmdb,hardcover}-token)
```

* Штамп принадлежит ровно одной версии и никогда не переиспользуется:
  обновление пакета создаёт новый каталог, старый остаётся нетронутым.
  Прежняя схема копировала `server/` прямо в `app/server` и наследовала
  read-only режимы store (`0444`/`0555`), из-за чего следующее обновление
  падало с
  `cp: cannot remove '.../app/server/books/book-cache.js': Permission denied`.
* Кэши не зависят от копии кода и переживают смену версии: обновление
  пакета не требует миграции, сервер и `kinoboxd-backfill` всегда смотрят в
  `$KINOBOXD_STATE_DIR/app/cache` (или в явный `KINOBOXD_CACHE_DIR`).
* Каталог `$KINOBOXD_STATE_DIR/app/server` от старых запусков больше не
  используется. Он безвреден, но его можно удалить (вместе со старыми
  штампами — активный штамп пересоздастся при следующем запуске):

  ```bash
  rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/kinoboxd/app/server"
  rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/kinoboxd/app/server@"*
  ```

  Если state принадлежит другому пользователю (сервис запускался от root),
  те же команды — через `sudo`. Если штамп не удаётся обновить, обёртка
  пишет в stderr подсказку с конкретным путём `rm -rf`.

### Re-matching the whole cache

`npm run rematch` (or `kinoboxd-backfill rematch`) re-runs the current TMDB
matcher over every entry in `cache/index.json`:

* values like `{ "id": 123, "kind": "movie" }` are **manual matches and are
  never touched** (they are counted as `skipped-manual` in the summary);
* automatic integer values are searched again; `false` misses are retried;
* a changed id is written atomically to the index and its details are fetched
  if they are not cached yet; old details files are left in place;
* a transport error keeps the existing value, so a flaky network cannot turn
  a good match into `false`;
* an existing automatic id is never downgraded to `false` just because the
  title/year key alone yields no confident match (`unconfirmed`), and a
  candidate more than two years outside the key's release window is ignored
  (`year-guarded`). This keeps remakes and obscure namesakes from breaking a
  previously correct match.

The key supplies the title/year (`tv|` marks a series); cached KinoPoisk
profiles supply the localized title and the real media kind when available.
Useful environment variables: `REMATCH_DRY_RUN=1` (log changes without
writing), `REMATCH_CONCURRENCY=8` and `TMDB_API_BASE` (alternate API host).
The summary prints total keys, skipped manual entries, re-evaluated keys,
changed/unchanged/still-failed counts, unconfirmed/year-guarded skips,
refetched details and TMDB retry counters. On NixOS add `"rematch"` to
`services.kinoboxd.backfillTargets` (the module enum includes it) and start
`kinoboxd-backfill` manually; the oneshot is not triggered automatically.

## Wikidata

`npm run backfill:wikidata` enriches every cached film with curated Wikidata
signals from the Wikidata Query Service. It is a separate, resumable CLI; the
server never queries WDQS at request time.

* Lookup is by IMDb id (`P345`), 450 ids per batch (6 batches for this cache).
  Films without an IMDb id fall back to a TMDB-id (`P4947`) query.
* Fetched properties: genres `P136`, color `P462`, film movements `P135`,
  based-on works `P144` plus the `P31` type of each source work.
* WDQS is rate-limited aggressively during outages. HTTP 429/5xx are retried
  up to 8 times with `Retry-After`/exponential backoff capped at 60 s. Every
  successful batch is flushed to `cache/wd-tags.json`, so an interrupted run
  leaves valid partial data; rerun the command to resume. Already checked ids
  (including "not found") are skipped. `WIKIDATA_REFRESH=1` forces a refetch.
* The file is a flat two-index store (same tag object under both keys):
  `{ "version": 1, "updatedAt": "...", "labels": {...},
     "imdb": { "tt…": tag }, "tmdb": { "…": tag } }`.
  A tag is `{ found, item, items, genres, colors, movements,
  basedOn, basedTypes, basedClasses, checkedAt }`; `basedClasses` is one of
  `remake | book | comic | play | video-game`. Multiple Wikidata items sharing
  one IMDb id are merged rather than letting the last row win.
* P144 classes use the priority `remake > book > comic > play > video-game`.
  The source-type labels are fetched once from the Wikidata API and cached in
  the same file.

Merged taxonomy rules (`server/taxonomy.js`):

* **Чёрно-белые**: TMDB keyword OR (`P462 = Q838368` AND NOT `Q22006653`).
  The color exclusion matters: ~43 corpus films are tagged both black-and-white
  and color, so the naive P462 rule would add ~35 false positives.
* **Немые**: TMDB keyword OR `P136 = Q226730` (silent film).
* **Фильм-нуар**: TMDB keyword OR (`P136 = Q185867` AND year ≤ 1965). The
  year guard keeps modern noirs out of the classic period; neo-noir is its own
  category below.
* **Нео-нуар**: TMDB keyword OR `P136 = Q2421031`.
* **Джалло**: TMDB keyword OR `P136 = Q1332055`. Keyword and Wikidata
  currently identify exactly the same two corpus films; `american giallo` is
  deliberately not an alias (it would pull in Basic Instinct / Malignant).
* **Спагетти-вестерн**: TMDB keyword `spaghetti western` (alias `italo
  western`) OR `P136 = Q212781`. Both signals currently identify the same six
  corpus films.
* **Слэшер**: TMDB keyword `slasher` OR `P136 = Q853630` (42 films in the
  2623-film corpus; the 14 Wikidata-only additions are slasher/giallo
  classics or slasher-adjacent, no false-positive cut).
* **Зомби**: TMDB keyword `zombie` OR `P136 = Q3072049` (46 films). Two
  Wikidata-only tags are borderline (Pirates 4's undead crew, Corpse Bride's
  skeletons) but only one is a clear outlier, below the agreed cut-off.
* **Киберпанк**: TMDB keyword `cyberpunk` OR `P136 = Q174526` (37 films).
  `biopunk` is deliberately not an alias (its only hit, Silent Hill, is not
  cyberpunk).
* **Боди-хоррор**: TMDB keyword `body horror` OR `P136 = Q3641550` (20 films;
  the single Wikidata tag is already keyword-matched).
* **Готический хоррор**: TMDB keyword `gothic horror` only (15 films). The
  broader Wikidata item Q114413232 would widen the bucket to 23 borderline
  titles, so it is not wired; the generic `gothic` keyword is also excluded.
* **Кайдзю**: TMDB keyword `kaiju` OR `P136 = Q1065444` (14 films; the one
  Wikidata-only title is King Kong 1933). `giant monster` is not an alias
  (would add Ghostbusters, Evolution, The Mist).
* **Фолк-хоррор**: TMDB keyword `folk horror` only (11 films); Q104902646 has
  no P136 uses in the current Wikidata cache.
* **Мокьюментари**: TMDB keyword `mockumentary` (aliases `fake documentary`,
  `faux documentary`, `pseudo documentary`) OR `P136 = Q459435` (18 films).
  Per the user's decision, faux/pseudo documentary count as mockumentary even
  though in this corpus they are mostly found-footage spellings; found footage
  is not a separate category and stays outside the taxonomy. Q3272147 (found
  footage film) is still not used. Known keyword FP: Gia (1998).
* **Новая Голливуд**: TMDB keyword OR `P135 = Q377616`.
* **Pre-Code Голливуд** (new period): `P135 = Q3408764`. TMDB has no matching
  keyword in this corpus.
* **Origins**: TMDB keyword classification always wins. Only when it yields
  `original` does P144 override it with a source-based subtype. This raises
  non-original coverage from ~40.9% to ~50.6% (2618-film cache).
* Other periods (French New Wave, Italian Neorealism, Japanese New Wave,
  Soviet Avant-Garde, German Expressionism) stay keyword-only.

`wd-tags.json` ids and Q-ids never leak into `/api/stats`: the payload schema
is unchanged, and the Wikidata layer only affects the counts inside the
existing `genres` / `origins` / `periods` buckets.

## Note on Letterboxd archives

`diary.csv` in real exports contains per-user short links
(`boxd.it/85jq3H` → `letterboxd.com/<user>/film/...`) while `watched.csv`
contains canonical links (`boxd.it/29Xu` → `letterboxd.com/film/...`) for the
same film. Taking the last URI segment literally would count the same film
twice. Diary/ratings rows are therefore merged into the watched film with the
same normalized title+year when possible; otherwise the URI slug is used.
Attachment events keep the archive's own slug (`lbSlug`) and are mapped to
KinoPoisk films by TMDB id, not by slug.

Timeline fallback for KinoPoisk films without a diary event is the month of the
KinoPoisk rating date (`ratedAt`). It is a proxy: a rating date is not
necessarily a viewing date. This is intentionally marked in the UI text and
kept only so the timeline still covers the whole KinoPoisk profile.
