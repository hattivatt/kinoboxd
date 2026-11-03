<!-- GENERATED FILE — do not edit by hand. Regenerate: node scripts/gen-contracts.js api -->
# HTTP API contract

Сгенерировано из объявлений роутов в `server/` (P9, план §3.5). Источник истины — сами роутеры: если таблица расходится с кодом, перегенерируй (`node scripts/gen-contracts.js`), а не правь файл.

Роутов: **67**. Тело ошибки всегда `{ error, code }` (`server/core/errors.js`); неизвестный query-параметр — 400 `unexpected_parameter` (`server/core/params.js`).

## Точки монтирования

| Файл | Префикс (app.use) |
| --- | --- |
| `server/auth.js` | `/api/auth` |
| `server/books/routes.js` | `/api/books` |
| `server/films/routes.js` | `/api` |
| `server/games/personnel/routes-personnel.js` | `/api/games` |
| `server/games/routes-epic.js` | `/api/games` |
| `server/games/routes-franchise.js` | `/api/games` |
| `server/games/routes-gog.js` | `/api/games/gog` |
| `server/games/routes.js` | `/api/games` |

`server/index.js` держит `/api/health` и SPA-catch-all; `server/auth.js` — `/api/auth/*`.

## Сводка

| Method | Path | Строгий query (assertOnlyParams) | Ошибки (status:code) | Источник |
| --- | --- | --- | --- | --- |
| GET | `*` | — | — | `server/index.js:93` |
| POST | `/api/attach/lbzip` | — | 400:file_required, 400:not_kinopoisk_import, 400:upload_id_required, 404:unknown_upload | `server/films/routes.js:202` |
| POST | `/api/auth/login` | — | 401:wrong_password | `server/auth.js:130` |
| POST | `/api/auth/logout` | — | — | `server/auth.js:149` |
| GET | `/api/auth/session` | — | — | `server/auth.js:155` |
| POST | `/api/books/import/hardcover` | — | — | `server/books/routes.js:233` |
| POST | `/api/books/import/livelib` | — | 400:username_required | `server/books/routes.js:208` |
| POST | `/api/books/import/livelib-file` | — | 400:upload_failed, 413:file_too_large | `server/books/routes.js:356` |
| DELETE | `/api/books/import/livelib/cookies` | — | 400:invalid_user_key, 400:user_key_required, 404:cookies_not_found, 409:livelib_import_running | `server/books/routes.js:539` |
| GET | `/api/books/import/status` | — | 400:job_id_required, 404:unknown_job | `server/books/routes.js:584` |
| GET | `/api/books/profiles` | — | — | `server/books/routes.js:135` |
| GET | `/api/books/stats` | `includeMangaComics`, `profile` | 400:invalid_include_manga | `server/books/routes.js:669` |
| GET | `/api/books/unmatched` | `profile` | — | `server/books/routes.js:834` |
| DELETE | `/api/books/work/flag` | — | 400:work_id_required | `server/books/routes.js:731` |
| POST | `/api/books/work/flag` | — | 400:manga_flag_required, 400:work_id_required | `server/books/routes.js:709` |
| POST | `/api/books/year-override` | `profile` | 400:invalid_year, 400:profile_required, 400:unknown_work, 400:work_id_required | `server/books/routes.js:762` |
| GET | `/api/compare` | — | — | `server/films/routes.js:319` |
| POST | `/api/enrich` | — | 400:upload_id_required, 404:unknown_upload | `server/films/routes.js:106` |
| GET | `/api/enrich/status` | — | 400:upload_id_required, 404:unknown_upload | `server/films/routes.js:124` |
| GET | `/api/games/achievements` | `appid`, `profile`, `refresh` | 400:invalid_appid | `server/games/routes.js:606` |
| POST | `/api/games/enrich` | — | 400:invalid_recheckDays | `server/games/routes.js:418` |
| GET | `/api/games/enrich/:jobId` | — | 404:unknown_job | `server/games/routes.js:504` |
| GET | `/api/games/enrich/status` | — | 400:job_id_required, 404:unknown_job | `server/games/routes.js:490` |
| POST | `/api/games/epic/auth` | — | — | `server/games/routes-epic.js:282` |
| GET | `/api/games/epic/auth-url` | — | — | `server/games/routes-epic.js:228` |
| DELETE | `/api/games/epic/auth/:authId` | — | 404:unknown_auth | `server/games/routes-epic.js:325` |
| GET | `/api/games/epic/auth/:authId` | — | 404:unknown_auth | `server/games/routes-epic.js:307` |
| POST | `/api/games/epic/connect` | — | 400:epic_code_required | `server/games/routes-epic.js:248` |
| POST | `/api/games/epic/disconnect` | — | 400:epic_account_required | `server/games/routes-epic.js:451` |
| GET | `/api/games/epic/exported` | `accountId`, `owner` | 400:owner_required | `server/games/routes-epic.js:419` |
| POST | `/api/games/epic/import` | `force` | — | `server/games/routes-epic.js:369` |
| GET | `/api/games/epic/import/:jobId` | — | 404:unknown_job | `server/games/routes-epic.js:402` |
| GET | `/api/games/epic/import/status` | `id` | 400:job_id_required, 404:unknown_job | `server/games/routes-epic.js:387` |
| POST | `/api/games/epic/refresh` | — | — | `server/games/routes-epic.js:378` |
| GET | `/api/games/epic/status` | `accountId`, `owner` | — | `server/games/routes-epic.js:166` |
| POST | `/api/games/franchise-enrich` | — | — | `server/games/routes-franchise.js:166` |
| GET | `/api/games/franchise-enrich/:jobId` | — | 404:unknown_job | `server/games/routes-franchise.js:200` |
| GET | `/api/games/franchise-enrich/status` | `id` | 400:job_id_required, 404:unknown_job | `server/games/routes-franchise.js:185` |
| GET | `/api/games/franchises` | `profile` | 400:profile_not_imported | `server/games/routes-franchise.js:145` |
| GET | `/api/games/game/:appid` | `profile` | 400:invalid_appid, 404:game_not_in_library | `server/games/routes.js:704` |
| POST | `/api/games/gog/auth` | `code`, `profile` | 400:gog_code_required | `server/games/routes-gog.js:95` |
| GET | `/api/games/gog/auth-url` | — | — | `server/games/routes-gog.js:76` |
| POST | `/api/games/gog/import` | `account`, `force`, `profile` | — | `server/games/routes-gog.js:168` |
| GET | `/api/games/gog/import/:jobId` | — | 404:unknown_job | `server/games/routes-gog.js:204` |
| GET | `/api/games/gog/import/status` | `id` | 400:job_id_required, 404:unknown_job | `server/games/routes-gog.js:189` |
| POST | `/api/games/gog/logout` | `account`, `profile` | — | `server/games/routes-gog.js:214` |
| GET | `/api/games/gog/status` | — | — | `server/games/routes-gog.js:119` |
| POST | `/api/games/import` | — | — | `server/games/routes.js:339` |
| GET | `/api/games/import/:jobId` | — | 404:unknown_job | `server/games/routes.js:399` |
| GET | `/api/games/import/status` | — | 400:job_id_required, 404:unknown_job | `server/games/routes.js:385` |
| POST | `/api/games/import/steam` | — | — | `server/games/routes.js:347` |
| POST | `/api/games/override` | — | — | `server/games/personnel/routes-personnel.js:219` |
| GET | `/api/games/personnel` | `limit`, `profile`, `role`, `sort` | 400:invalid_limit, 400:profile_not_imported | `server/games/personnel/routes-personnel.js:157` |
| GET | `/api/games/personnel/status` | `id` | 400:job_id_required, 404:unknown_job | `server/games/personnel/routes-personnel.js:204` |
| GET | `/api/games/profiles` | — | — | `server/games/routes.js:272` |
| POST | `/api/games/refresh` | — | — | `server/games/routes.js:361` |
| GET | `/api/games/secondary-details/status` | `profile` | — | `server/games/routes.js:527` |
| GET | `/api/games/stats` | `includeDlc`, `includeFree`, `minHours`, `profile` | 400:profile_not_imported | `server/games/routes.js:541` |
| GET | `/api/games/steam-art/:type/:appid` | `h` | — | `server/games/routes.js:692` |
| GET | `/api/health` | — | — | `server/index.js:74` |
| POST | `/api/import/kinopoisk` | — | 400:url_required | `server/films/routes.js:144` |
| GET | `/api/import/kinopoisk/status` | — | 400:upload_id_required, 404:unknown_kinopoisk_import, 404:unknown_upload | `server/films/routes.js:161` |
| POST | `/api/match` | — | 400:enrichment_not_finished, 400:invalid_kind, 400:invalid_tmdb_id, 400:slug_required, 400:upload_id_required, 404:not_unmatched, 404:unknown_film, 404:unknown_upload, 409:already_matched | `server/films/routes.js:374` |
| GET | `/api/profiles` | — | — | `server/films/routes.js:306` |
| GET | `/api/stats` | — | 400:enrichment_not_finished, 400:upload_id_required, 404:unknown_upload | `server/films/routes.js:264` |
| GET | `/api/tmdb/search` | — | 400:invalid_kind, 400:query_required | `server/films/routes.js:335` |
| POST | `/api/upload` | — | 400:file_required | `server/films/routes.js:78` |

## Детали

### `GET *`

- файл: `server/index.js:93`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/attach/lbzip`

- файл: `server/films/routes.js:202`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `uploadId` — см. модуль
- ошибка `400` `file_required`: 'No file received. Send the Letterboxd ZIP as multipart/form-data field "file".'
- ошибка `400` `not_kinopoisk_import`: 'Letterboxd archives can only be attached to a KinoPoisk import.'
- ошибка `400` `upload_id_required`: 'Body must contain "uploadId".'
- ошибка `404` `unknown_upload`: 'Unknown uploadId. Start the KinoPoisk import again.'
- описание: Attach a Letterboxd export to the active KinoPoisk import. multipart/form-data: field `file` (ZIP), `uploadId` query or body field. The server resolves `kpUserId` from the KinoPoisk job, parses diary.csv / watched.csv /…

### `POST /api/auth/login`

- файл: `server/auth.js:130`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `401` `wrong_password`: wrong_password

### `POST /api/auth/logout`

- файл: `server/auth.js:149`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/auth/session`

- файл: `server/auth.js:155`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/books/import/hardcover`

- файл: `server/books/routes.js:233`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `force` — см. модуль
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)
- описание: POST /api/books/import/hardcover { userId?, force? } — defaults to the token owner.

### `POST /api/books/import/livelib`

- файл: `server/books/routes.js:208`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `deep`, `force` — см. модуль
- ошибка `400` `username_required`: 'Body must contain "username" (LiveLib reader name or profile URL).'
- описание: POST /api/books/import/livelib { username, force?, deep?, cookieHeader? } LEGACY scrape path. It is no longer reachable from the UI (28.10.2026): a LiveLib profile is created and refreshed from a `livelib-backup` export…

### `POST /api/books/import/livelib-file`

- файл: `server/books/routes.js:356`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `upload_failed`: `Не удалось принять файл: ${uploadError.message}`
- ошибка `413` `file_too_large`: `Файл больше ${Math.round(FILE_IMPORT_MAX_BYTES / (1024 * 1024))} МБ.`
- описание: POST /api/books/import/livelib-file — multipart file required JSON (or CSV) export of livelib-backup username required when the profile is new; LiveLib reader name (aliases: `userKey`, `profileKey` = `livelib-<name>`) s…

### `DELETE /api/books/import/livelib/cookies`

- файл: `server/books/routes.js:539`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `sourceUserKey`, `userKey` — см. модуль
- ошибка `400` `invalid_user_key`: 'Query parameter "userKey" must be 1-120 chars of letters, digits, ".", "_" or "-".'
- ошибка `400` `user_key_required`: 'Query parameter "userKey" is required (LiveLib reader name).'
- ошибка `404` `cookies_not_found`: `No stored LiveLib cookies for "${userKey}".`
- ошибка `409` `livelib_import_running`: 'A LiveLib import of this profile is running — wait for it to finish before removing the cookies.'
- описание: DELETE /api/books/import/livelib/cookies?userKey=Margaret The counterpart of the cookie paste: the stored header is a secret the user handed us for one retry, so it must be removable without shell access to the cache di…

### `GET /api/books/import/status`

- файл: `server/books/routes.js:584`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `id` — см. модуль
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown import job id.'
- описание: GET /api/books/import/status?id=...

### `GET /api/books/profiles`

- файл: `server/books/routes.js:135`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)
- описание: GET /api/books/profiles — cached source profiles for the switcher/badges. Each entry carries: - `key` — the exact `?profile=` token (`livelib-Margaret`), - `sourceKey` — the minimal provider-qualified key for docs (`liv…

### `GET /api/books/stats`

- файл: `server/books/routes.js:669`
- query (строгий список): `includeMangaComics`, `profile`
- ошибка `400` `invalid_include_manga`: 'Query parameter "includeMangaComics" must be 0 or 1 (default 0).'
- описание: GET /api/books/stats?profile=livelib-Margaret&includeMangaComics=0|1 `profile` is mandatory and single: the payload is built from that profile's events only (no union with another account/service). Any other query param…

### `GET /api/books/unmatched`

- файл: `server/books/routes.js:834`
- query (строгий список): `profile`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)
- описание: GET /api/books/unmatched?profile=livelib-Margaret (single profile).

### `DELETE /api/books/work/flag`

- файл: `server/books/routes.js:731`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `workId` — см. модуль
- ошибка `400` `work_id_required`: 'Query parameter "workId" is required.'
- описание: DELETE /api/books/work/flag?workId=… — remove the override (idempotent).

### `POST /api/books/work/flag`

- файл: `server/books/routes.js:709`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `manga_flag_required`: 'Body must contain "mangaComics" as a boolean (true = hide, false = show).'
- ошибка `400` `work_id_required`: 'Body must contain "workId".'
- описание: POST /api/books/work/flag { workId, mangaComics } Upsert the per-work manual manga/comics override. The body is intentionally strict: `true` = hide as manga/comics, `false` = show again.

### `POST /api/books/year-override`

- файл: `server/books/routes.js:762`
- query (строгий список): `profile`
- ошибка `400` `invalid_year`: `Body field "year" must be an integer in ${YEAR_OVERRIDE_MIN}..${YEAR_OVERRIDE_MAX} ` + 'or null to remove the correction.'
- ошибка `400` `profile_required`: 'Body must contain "profile".'
- ошибка `400` `unknown_work`: `Work "${workId}" is not part of profile ${selected.source}-${selected.userKey}.`
- ошибка `400` `work_id_required`: 'Body must contain "workId".'

### `GET /api/compare`

- файл: `server/films/routes.js:319`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `a`, `b` — см. модуль
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)
- описание: Read-only comparison of two cached KinoPoisk profiles. All numbers come from the persistent caches (profile + TMDB details + Letterboxd attachment); no live KinoPoisk request is made.

### `POST /api/enrich`

- файл: `server/films/routes.js:106`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `upload_id_required`: 'Body must contain "uploadId".'
- ошибка `404` `unknown_upload`: 'Unknown uploadId. Upload the ZIP again.'

### `GET /api/enrich/status`

- файл: `server/films/routes.js:124`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `uploadId` — см. модуль
- ошибка `400` `upload_id_required`: 'Query parameter "uploadId" is required.'
- ошибка `404` `unknown_upload`: 'Unknown uploadId. Upload the ZIP again.'

### `GET /api/games/achievements`

- файл: `server/games/routes.js:606`
- query (строгий список): `appid`, `profile`, `refresh`
- ошибка `400` `invalid_appid`: 'Query parameter "appid" must be a positive integer.'

### `POST /api/games/enrich`

- файл: `server/games/routes.js:418`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `force`, `phase`, `phases`, `profile`, `recheckDays` — см. модуль
- ошибка `400` `invalid_recheckDays`: 'Parameter "recheckDays" must be a non-negative number of days.'
- описание: `POST /api/games/enrich` — fetch metadata for the library of one profile. Body: `{ profile, force?, phases?, recheckDays? }` (query fallback for curl). `phases` is `details` | `spy` | `reviews` | `all` (comma-separated…

### `GET /api/games/enrich/:jobId`

- файл: `server/games/routes.js:504`
- path-параметры: `jobId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_job`: 'Unknown enrich job id.'

### `GET /api/games/enrich/status`

- файл: `server/games/routes.js:490`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `id` — см. модуль
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown enrich job id.'

### `POST /api/games/epic/auth`

- файл: `server/games/routes-epic.js:282`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/epic/auth-url`

- файл: `server/games/routes-epic.js:228`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)
- описание: Login URL for the authorization-code flow. No network call: the client id is public and the page is the official Epic login. The user copies the `code` from the redirect page and posts it to `/epic/connect`.

### `DELETE /api/games/epic/auth/:authId`

- файл: `server/games/routes-epic.js:325`
- path-параметры: `authId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_auth`: 'Unknown Epic auth session.'

### `GET /api/games/epic/auth/:authId`

- файл: `server/games/routes-epic.js:307`
- path-параметры: `authId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_auth`: 'Unknown Epic auth session.'

### `POST /api/games/epic/connect`

- файл: `server/games/routes-epic.js:248`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `code` — см. модуль
- ошибка `400` `epic_code_required`: 'Body must contain "code" — the one-time code from the Epic login redirect ' + '(epicgames.com/id/api/redirect?code=…).'

### `POST /api/games/epic/disconnect`

- файл: `server/games/routes-epic.js:451`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `epic_account_required`: 'Body must contain "accountId" or "owner" (steam-<steamid64>).'
- описание: ------------------------- disconnect -------------------------

### `GET /api/games/epic/exported`

- файл: `server/games/routes-epic.js:419`
- query (строгий список): `accountId`, `owner`
- ошибка `400` `owner_required`: 'Query parameter "owner" (steam-<steamid64>) or "accountId" is required.'
- описание: The isolated contract for the M6c integration: one entry per Epic game, with `workKey`/`steamAppId` deliberately `null` (the union is built by the integration round, not here). `hoursBySource` stays split.

### `POST /api/games/epic/import`

- файл: `server/games/routes-epic.js:369`
- query (строгий список): `force`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/epic/import/:jobId`

- файл: `server/games/routes-epic.js:402`
- path-параметры: `jobId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_job`: 'Unknown Epic import job id.'

### `GET /api/games/epic/import/status`

- файл: `server/games/routes-epic.js:387`
- query (строгий список): `id`
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown Epic import job id.'

### `POST /api/games/epic/refresh`

- файл: `server/games/routes-epic.js:378`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/epic/status`

- файл: `server/games/routes-epic.js:166`
- query (строгий список): `accountId`, `owner`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)
- описание: --------------------------- status ---------------------------

### `POST /api/games/franchise-enrich`

- файл: `server/games/routes-franchise.js:166`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `force`, `profile` — см. модуль
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/franchise-enrich/:jobId`

- файл: `server/games/routes-franchise.js:200`
- path-параметры: `jobId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_job`: 'Unknown franchise job id.'

### `GET /api/games/franchise-enrich/status`

- файл: `server/games/routes-franchise.js:185`
- query (строгий список): `id`
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown franchise job id.'

### `GET /api/games/franchises`

- файл: `server/games/routes-franchise.js:145`
- query (строгий список): `profile`
- ошибка `400` `profile_not_imported`: `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`

### `GET /api/games/game/:appid`

- файл: `server/games/routes.js:704`
- path-параметры: `appid`
- query (строгий список): `profile`
- ошибка `400` `invalid_appid`: 'Path parameter "appid" must be a positive integer.'
- ошибка `404` `game_not_in_library`: `App ${appid} is not in the ${scope.parsed.key} library.`

### `POST /api/games/gog/auth`

- файл: `server/games/routes-gog.js:95`
- query (строгий список): `code`, `profile`
- ошибка `400` `gog_code_required`: 'Body must contain "code" — the one-time code from the GOG login redirect.'

### `GET /api/games/gog/auth-url`

- файл: `server/games/routes-gog.js:76`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/games/gog/import`

- файл: `server/games/routes-gog.js:168`
- query (строгий список): `account`, `force`, `profile`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/gog/import/:jobId`

- файл: `server/games/routes-gog.js:204`
- path-параметры: `jobId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_job`: 'Unknown GOG import job id.'

### `GET /api/games/gog/import/status`

- файл: `server/games/routes-gog.js:189`
- query (строгий список): `id`
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown GOG import job id.'

### `POST /api/games/gog/logout`

- файл: `server/games/routes-gog.js:214`
- query (строгий список): `account`, `profile`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/gog/status`

- файл: `server/games/routes-gog.js:119`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/games/import`

- файл: `server/games/routes.js:339`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/import/:jobId`

- файл: `server/games/routes.js:399`
- path-параметры: `jobId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_job`: 'Unknown import job id.'

### `GET /api/games/import/status`

- файл: `server/games/routes.js:385`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `id` — см. модуль
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown import job id.'

### `POST /api/games/import/steam`

- файл: `server/games/routes.js:347`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/games/override`

- файл: `server/games/personnel/routes-personnel.js:219`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/personnel`

- файл: `server/games/personnel/routes-personnel.js:157`
- query (строгий список): `limit`, `profile`, `role`, `sort`
- ошибка `400` `invalid_limit`: 'Query parameter "limit" must be an integer between 1 and 50.'
- ошибка `400` `profile_not_imported`: `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`

### `GET /api/games/personnel/status`

- файл: `server/games/personnel/routes-personnel.js:204`
- query (строгий список): `id`
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown personnel job id.'

### `GET /api/games/profiles`

- файл: `server/games/routes.js:272`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)
- описание: ------------------------- profiles -------------------------

### `POST /api/games/refresh`

- файл: `server/games/routes.js:361`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `profile` — см. модуль
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)
- описание: `POST /api/games/refresh` — re-read the library/achievements of an already imported profile (ИГРЫ-АРХИТЕКТУРА §5). Always `force`: a manual refresh exists to bypass the TTLs, so it never returns the cached snapshot. Bod…

### `GET /api/games/secondary-details/status`

- файл: `server/games/routes.js:527`
- query (строгий список): `profile`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)
- описание: `GET /api/games/secondary-details/status?profile=…` — the owner-facing diagnostic for «вне Steam» metadata (M6d). Answers only from the cache and the job/breaker state, never with a network request: { resolved, total, r…

### `GET /api/games/stats`

- файл: `server/games/routes.js:541`
- query (строгий список): `includeDlc`, `includeFree`, `minHours`, `profile`
- ошибка `400` `profile_not_imported`: `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`

### `GET /api/games/steam-art/:type/:appid`

- файл: `server/games/routes.js:692`
- path-параметры: `type`, `appid`
- query (строгий список): `h`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)
- описание: Steam art CDN proxy (fix-round 02.11.2026, ИГРЫ §8.2 artwork). The owner's ISP blocks the Steam CDN in Vietnam; the server relays the public asset. The upstream URL is built from type/appid/hash, never from client input…

### `GET /api/health`

- файл: `server/index.js:74`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/import/kinopoisk`

- файл: `server/films/routes.js:144`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `url_required`: 'Body must contain "url" (a KinoPoisk user profile or votes URL).'
- описание: KinoPoisk import

### `GET /api/import/kinopoisk/status`

- файл: `server/films/routes.js:161`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `uploadId` — см. модуль
- ошибка `400` `upload_id_required`: 'Query parameter "uploadId" is required.'
- ошибка `404` `unknown_kinopoisk_import`: 'This uploadId is not a KinoPoisk import.'
- ошибка `404` `unknown_upload`: 'Unknown uploadId. Start the KinoPoisk import again.'

### `POST /api/match`

- файл: `server/films/routes.js:374`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `enrichment_not_finished`: 'Enrichment is not finished yet. Poll /api/enrich/status.'
- ошибка `400` `invalid_kind`: 'Body field "kind" must be "movie" or "tv".'
- ошибка `400` `invalid_tmdb_id`: 'Body field "tmdbId" must be a positive integer.'
- ошибка `400` `slug_required`: 'Body must contain "slug".'
- ошибка `400` `upload_id_required`: 'Body must contain "uploadId".'
- ошибка `404` `not_unmatched`: 'This film is not in the unmatched list.'
- ошибка `404` `unknown_film`: 'Unknown film slug for this upload.'
- ошибка `404` `unknown_upload`: 'Unknown uploadId. Upload the ZIP again.'
- ошибка `409` `already_matched`: 'This film is already matched to another TMDB entry.'
- описание: Attach a TMDB id chosen by the user to a film. - Unmatched film: creates the match. - Matched film with the same id/kind: idempotent 200 `alreadyMatched`. - Matched film with a different id/kind: re-match (details are f…

### `GET /api/profiles`

- файл: `server/films/routes.js:306`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)
- описание: Cached KinoPoisk profiles (one per cache/kp/{userId}.json). The list is independent of the browser registry and survives server restarts, so the comparison screen can always use it. The payload stays a flat array (the c…

### `GET /api/stats`

- файл: `server/films/routes.js:264`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `uploadId` — см. модуль
- ошибка `400` `enrichment_not_finished`
- ошибка `400` `upload_id_required`: 'Query parameter "uploadId" is required.'
- ошибка `404` `unknown_upload`: 'Unknown uploadId. Upload the ZIP again.'
- описание: Dashboard payload

### `GET /api/tmdb/search`

- файл: `server/films/routes.js:335`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `kind`, `q` — см. модуль
- ошибка `400` `invalid_kind`: 'Query parameter "kind" must be "movie", "tv" or "all".'
- ошибка `400` `query_required`: 'Query parameter "q" is required.'
- описание: Manual TMDB matching

### `POST /api/upload`

- файл: `server/films/routes.js:78`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `file_required`: 'No file received. Send the Letterboxd export as multipart/form-data field "file".'
- описание: Letterboxd upload + enrichment

