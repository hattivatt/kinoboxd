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

The cache is global and persisted before/after restart. A second Letterboxd
upload with overlapping films performs no TMDB requests (a KinoPoisk import
still checks the profile's newest page, see above).

TMDB requests are capped at 12 concurrent; HTTP 429 is retried up to 5 times
with `Retry-After`/exponential backoff.

## Note on Letterboxd slugs

`diary.csv` in real exports contains per-user short links
(`boxd.it/85jq3H` → `letterboxd.com/<user>/film/...`) while `watched.csv`
contains canonical links (`boxd.it/29Xu` → `letterboxd.com/film/...`) for the
same film. Taking the last URI segment literally would count the same film
twice. Diary/ratings rows are therefore merged into the watched film with the
same normalized title+year when possible; otherwise the URI slug is used.
