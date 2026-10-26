# kinoboxd — backend

Node.js/Express backend for Letterboxd and KinoPoisk statistics with TMDB
enrichment (package `kinoboxd`).

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

### Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `PORT` | HTTP-порт (по умолчанию `3000`) |
| `TMDB_API_TOKEN` | TMDB read access token v4 (алиас: `TMDB_READ_ACCESS_TOKEN`; локально также `config/tmdb-token`) |
| `KINOBOXD_PASSWORD` | Пароль для доступа к API. Если не задан/пустой — авторизация выключена, API открыто (дефолт для локальной разработки) |
| `KINOBOXD_STATE_DIR` | Каталог состояния в Nix-сборке (по умолчанию `$XDG_STATE_HOME/kinoboxd`) |
| `KINOBOXD_CACHE_DIR` | Переопределяет каталог кэша (по умолчанию `app/cache`). Удобно для тестов/нестандартной раскладки; изменяет и `index.json`/`details/`, и `kp/` |

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
| POST | `/api/upload` | multipart/form-data, field `file` = Letterboxd ZIP |
| POST | `/api/enrich` | `{ "uploadId": "..." }`, starts background enrichment |
| GET | `/api/enrich/status?uploadId=...` | `{ total, matched, failed, done }` |
| POST | `/api/import/kinopoisk` | `{ "url": "https://www.kinopoisk.ru/user/<id>/..." }`, starts a KinoPoisk import (or a delta refresh of a cached profile) |
| GET | `/api/import/kinopoisk/status?uploadId=...` | `{ stage, page, pageTotal, total, matched, failed, done, warning }` |
| GET | `/api/stats?uploadId=...` | full statistics payload (400 until enrichment is done) |
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
* `cache/lb-links.json` — global `"tmdbId"` → `{ lbUri, kind }` mapping learned
  from every enriched Letterboxd upload. Letterboxd links cannot be derived
  from a TMDB id, so KinoPoisk (and any other source) films pick up the
  `boxd.it` link of the same TMDB film from this file. The first learned URI
  wins; the mapping survives restarts and is independent of the upload that
  taught it.
* `cache/wd-tags.json` — Wikidata enrichment (see below). Written by the
  `backfill:wikidata` CLI; the running server reloads it on the next stats
  build when its mtime/size changed, so no restart is needed.

The cache is global and persisted before/after restart. A second Letterboxd
upload with overlapping films performs no TMDB requests (a KinoPoisk import
still checks the profile's newest page, see above).

TMDB requests are capped at 12 concurrent; HTTP 429 is retried up to 5 times
with `Retry-After`/exponential backoff.

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

## Note on Letterboxd slugs

`diary.csv` in real exports contains per-user short links
(`boxd.it/85jq3H` → `letterboxd.com/<user>/film/...`) while `watched.csv`
contains canonical links (`boxd.it/29Xu` → `letterboxd.com/film/...`) for the
same film. Taking the last URI segment literally would count the same film
twice. Diary/ratings rows are therefore merged into the watched film with the
same normalized title+year when possible; otherwise the URI slug is used.
