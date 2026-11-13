<!-- GENERATED FILE — do not edit by hand. Regenerate: node scripts/gen-contracts.js api -->
# HTTP API contract

Сгенерировано из объявлений роутов в `server/` (P9, план §3.5). Источник истины — сами роутеры: если таблица расходится с кодом, перегенерируй (`node scripts/gen-contracts.js`), а не правь файл.

Роутов: **72**. Тело ошибки всегда `{ error, code }` (`server/core/errors.js`); неизвестный query-параметр — 400 `unexpected_parameter` (`server/core/params.js`).

## Точки монтирования

| Файл | Префикс (app.use) |
| --- | --- |
| `server/auth.js` | `/api/auth` |
| `server/books/routes-manual.js` | `/api/books` |
| `server/books/routes-stats.js` | `/api/books` |
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
| GET | `*` | — | — | `server/index.js:68` |
| POST | `/api/attach/lbzip` | — | 400:file_required, 400:not_kinopoisk_import, 400:upload_id_required, 404:unknown_profile, 404:unknown_upload | `server/films/routes.js:162` |
| POST | `/api/auth/login` | — | 401:wrong_password, 429:too_many_attempts | `server/auth.js:158` |
| POST | `/api/auth/logout` | — | — | `server/auth.js:184` |
| GET | `/api/auth/session` | — | — | `server/auth.js:190` |
| GET | `/api/books/audit` | `profile` | — | `server/books/routes-manual.js:193` |
| POST | `/api/books/import/hardcover` | — | — | `server/books/routes.js:136` |
| POST | `/api/books/import/livelib` | — | 400:username_required | `server/books/routes.js:113` |
| POST | `/api/books/import/livelib-file` | — | 400:upload_failed, 413:file_too_large | `server/books/routes.js:189` |
| DELETE | `/api/books/import/livelib/cookies` | — | 400:invalid_user_key, 400:user_key_required, 404:cookies_not_found, 409:livelib_import_running | `server/books/routes.js:341` |
| GET | `/api/books/import/status` | — | 400:job_id_required, 404:unknown_job | `server/books/routes.js:385` |
| DELETE | `/api/books/link` | — | 400:book_id_required, 400:invalid_book_id, 400:profile_required | `server/books/routes-manual.js:167` |
| POST | `/api/books/link` | — | 400:book_id_required, 400:invalid_book_id, 400:invalid_work_id, 400:profile_required, 400:work_id_required, 404:unknown_book | `server/books/routes-manual.js:121` |
| GET | `/api/books/profiles` | — | — | `server/books/routes.js:68` |
| DELETE | `/api/books/series-override` | — | 400:invalid_work_id, 400:profile_required, 400:work_id_required | `server/books/routes-manual.js:95` |
| POST | `/api/books/series-override` | — | 400:invalid_series, 400:invalid_work_id, 400:profile_required, 400:work_id_required | `server/books/routes-manual.js:20` |
| GET | `/api/books/stats` | `includeMangaComics`, `profile` | 400:invalid_include_manga | `server/books/routes-stats.js:15` |
| GET | `/api/books/unmatched` | `profile` | — | `server/books/routes-stats.js:37` |
| DELETE | `/api/books/work/flag` | — | 400:work_id_required | `server/books/routes.js:422` |
| POST | `/api/books/work/flag` | — | 400:manga_flag_required, 400:work_id_required | `server/books/routes.js:401` |
| POST | `/api/books/year-override` | — | 400:invalid_year, 400:profile_required, 400:unknown_work, 400:work_id_required | `server/books/routes.js:438` |
| GET | `/api/compare` | — | — | `server/films/routes.js:277` |
| POST | `/api/enrich` | — | 400:upload_id_required, 404:unknown_upload | `server/films/routes.js:83` |
| GET | `/api/enrich/status` | — | 400:upload_id_required, 404:unknown_upload | `server/films/routes.js:101` |
| GET | `/api/games/achievements` | `appid`, `profile`, `refresh` | 400:invalid_appid | `server/games/endpoints/achievements.js:17` |
| POST | `/api/games/enrich` | — | 400:invalid_recheckDays | `server/games/endpoints/enrich.js:12` |
| GET | `/api/games/enrich/:jobId` | — | 404:unknown_job | `server/games/endpoints/enrich.js:91` |
| GET | `/api/games/enrich/status` | — | 400:job_id_required, 404:unknown_job | `server/games/endpoints/enrich.js:77` |
| POST | `/api/games/epic/auth` | — | — | `server/games/endpoints/epic/auth.js:64` |
| GET | `/api/games/epic/auth-url` | — | — | `server/games/endpoints/epic/auth.js:11` |
| DELETE | `/api/games/epic/auth/:authId` | — | 404:unknown_auth | `server/games/endpoints/epic/auth.js:105` |
| GET | `/api/games/epic/auth/:authId` | — | 404:unknown_auth | `server/games/endpoints/epic/auth.js:89` |
| POST | `/api/games/epic/connect` | — | 400:epic_code_required | `server/games/endpoints/epic/auth.js:30` |
| POST | `/api/games/epic/disconnect` | — | 400:epic_account_required | `server/games/endpoints/epic/disconnect.js:12` |
| GET | `/api/games/epic/exported` | `accountId`, `owner` | 400:owner_required | `server/games/endpoints/epic/exported.js:11` |
| POST | `/api/games/epic/import` | `force` | — | `server/games/endpoints/epic/import.js:39` |
| GET | `/api/games/epic/import/:jobId` | — | 404:unknown_job | `server/games/endpoints/epic/import.js:72` |
| GET | `/api/games/epic/import/status` | `id` | 400:job_id_required, 404:unknown_job | `server/games/endpoints/epic/import.js:57` |
| POST | `/api/games/epic/refresh` | — | — | `server/games/endpoints/epic/import.js:48` |
| GET | `/api/games/epic/status` | `accountId`, `owner` | — | `server/games/endpoints/epic/status.js:12` |
| POST | `/api/games/franchise-enrich` | — | — | `server/games/routes-franchise.js:138` |
| GET | `/api/games/franchise-enrich/:jobId` | — | 404:unknown_job | `server/games/routes-franchise.js:172` |
| GET | `/api/games/franchise-enrich/status` | `id` | 400:job_id_required, 404:unknown_job | `server/games/routes-franchise.js:157` |
| GET | `/api/games/franchises` | `profile` | 400:profile_not_imported | `server/games/routes-franchise.js:117` |
| GET | `/api/games/game/:appid` | `profile` | 400:invalid_appid, 404:game_not_in_library | `server/games/endpoints/game.js:29` |
| POST | `/api/games/gog/auth` | `code`, `profile` | 400:gog_code_required | `server/games/routes-gog.js:76` |
| GET | `/api/games/gog/auth-url` | — | — | `server/games/routes-gog.js:58` |
| POST | `/api/games/gog/import` | `account`, `force`, `profile` | — | `server/games/routes-gog.js:141` |
| GET | `/api/games/gog/import/:jobId` | — | 404:unknown_job | `server/games/routes-gog.js:177` |
| GET | `/api/games/gog/import/status` | `id` | 400:job_id_required, 404:unknown_job | `server/games/routes-gog.js:162` |
| POST | `/api/games/gog/logout` | `account`, `profile` | — | `server/games/routes-gog.js:187` |
| GET | `/api/games/gog/status` | — | — | `server/games/routes-gog.js:100` |
| POST | `/api/games/import` | — | — | `server/games/endpoints/import.js:50` |
| GET | `/api/games/import/:jobId` | — | 404:unknown_job | `server/games/endpoints/import.js:104` |
| GET | `/api/games/import/status` | — | 400:job_id_required, 404:unknown_job | `server/games/endpoints/import.js:90` |
| POST | `/api/games/import/steam` | — | — | `server/games/endpoints/import.js:58` |
| POST | `/api/games/override` | — | — | `server/games/personnel/routes-personnel.js:180` |
| GET | `/api/games/personnel` | `limit`, `profile`, `role`, `sort` | 400:invalid_limit, 400:profile_not_imported | `server/games/personnel/routes-personnel.js:121` |
| GET | `/api/games/personnel/status` | `id` | 400:job_id_required, 404:unknown_job | `server/games/personnel/routes-personnel.js:165` |
| GET | `/api/games/profiles` | — | — | `server/games/endpoints/profiles.js:100` |
| POST | `/api/games/refresh` | — | — | `server/games/endpoints/import.js:66` |
| GET | `/api/games/secondary-details/status` | `profile` | — | `server/games/endpoints/stats.js:12` |
| GET | `/api/games/stats` | `includeDlc`, `includeFree`, `minHours`, `profile` | 400:profile_not_imported | `server/games/endpoints/stats.js:26` |
| GET | `/api/games/steam-art/:type/:appid` | `h` | — | `server/games/endpoints/game.js:17` |
| GET | `/api/health` | — | — | `server/index.js:51` |
| POST | `/api/import/kinopoisk` | — | 400:url_required | `server/films/routes.js:117` |
| GET | `/api/import/kinopoisk/status` | — | 400:upload_id_required, 404:unknown_kinopoisk_import, 404:unknown_upload | `server/films/routes.js:134` |
| POST | `/api/match` | — | 400:enrichment_not_finished, 400:invalid_kind, 400:invalid_tmdb_id, 400:slug_required, 400:upload_id_required, 404:not_unmatched, 404:unknown_film, 404:unknown_upload, 409:already_matched | `server/films/routes.js:320` |
| GET | `/api/profiles` | — | — | `server/films/routes.js:269` |
| GET | `/api/stats` | — | 400:enrichment_not_finished, 400:upload_id_required, 404:unknown_upload | `server/films/routes.js:239` |
| GET | `/api/tmdb/search` | — | 400:invalid_kind, 400:query_required | `server/films/routes.js:289` |
| POST | `/api/upload` | — | 400:file_required | `server/films/routes.js:55` |

## Детали

### `GET *`

- файл: `server/index.js:68`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/attach/lbzip`

- файл: `server/films/routes.js:162`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `kpUserId`, `uploadId` — см. модуль
- ошибка `400` `file_required`: 'No file received. Send the Letterboxd ZIP as multipart/form-data field "file".'
- ошибка `400` `not_kinopoisk_import`: 'Letterboxd archives can only be attached to a KinoPoisk import.'
- ошибка `400` `upload_id_required`: 'Body must contain "uploadId".'
- ошибка `404` `unknown_profile`: 'No cached KinoPoisk profile for this kpUserId. Import the profile first.'
- ошибка `404` `unknown_upload`: 'Unknown uploadId. Start the KinoPoisk import again.'

### `POST /api/auth/login`

- файл: `server/auth.js:158`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `401` `wrong_password`: wrong_password
- ошибка `429` `too_many_attempts`: too_many_attempts

### `POST /api/auth/logout`

- файл: `server/auth.js:184`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/auth/session`

- файл: `server/auth.js:190`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/books/audit`

- файл: `server/books/routes-manual.js:193`
- query (строгий список): `profile`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/books/import/hardcover`

- файл: `server/books/routes.js:136`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `force` — см. модуль
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/books/import/livelib`

- файл: `server/books/routes.js:113`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `deep`, `force` — см. модуль
- ошибка `400` `username_required`: 'Body must contain "username" (LiveLib reader name or profile URL).'

### `POST /api/books/import/livelib-file`

- файл: `server/books/routes.js:189`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `upload_failed`: `Не удалось принять файл: ${uploadError.message}`
- ошибка `413` `file_too_large`: `Файл больше ${Math.round(FILE_IMPORT_MAX_BYTES / (1024 * 1024))} МБ.`

### `DELETE /api/books/import/livelib/cookies`

- файл: `server/books/routes.js:341`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `sourceUserKey`, `userKey` — см. модуль
- ошибка `400` `invalid_user_key`: 'Query parameter "userKey" must be 1-120 chars of letters, digits, ".", "_" or "-".'
- ошибка `400` `user_key_required`: 'Query parameter "userKey" is required (LiveLib reader name).'
- ошибка `404` `cookies_not_found`: `No stored LiveLib cookies for "${userKey}".`
- ошибка `409` `livelib_import_running`: 'A LiveLib import of this profile is running — wait for it to finish before removing the cookies.'

### `GET /api/books/import/status`

- файл: `server/books/routes.js:385`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `id` — см. модуль
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown import job id.'

### `DELETE /api/books/link`

- файл: `server/books/routes-manual.js:167`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `book_id_required`: 'Body must contain "bookId".'
- ошибка `400` `invalid_book_id`: `Body field "bookId" must be at most ${MAX_BOOK_ID} characters.`
- ошибка `400` `profile_required`: 'Body must contain "profile".'

### `POST /api/books/link`

- файл: `server/books/routes-manual.js:121`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `book_id_required`: 'Body must contain "bookId".'
- ошибка `400` `invalid_book_id`: `Body field "bookId" must be at most ${MAX_BOOK_ID} characters.`
- ошибка `400` `invalid_work_id`: 'Body field "workId" must look like "hc:<id>", "lr:<id>", "gb:<id>" or "ol:<id>".'
- ошибка `400` `profile_required`: 'Body must contain "profile".'
- ошибка `400` `work_id_required`: 'Body must contain "workId".'
- ошибка `404` `unknown_book`: `Book "${bookId}" is not part of profile ${profile.source}-${profile.userKey}.`

### `GET /api/books/profiles`

- файл: `server/books/routes.js:68`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `DELETE /api/books/series-override`

- файл: `server/books/routes-manual.js:95`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `invalid_work_id`: `Body field "workId" must be at most ${MAX_WORK_ID} characters.`
- ошибка `400` `profile_required`: 'Body must contain "profile".'
- ошибка `400` `work_id_required`: 'Body must contain "workId".'

### `POST /api/books/series-override`

- файл: `server/books/routes-manual.js:20`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `invalid_series`: 'Body field "series" must be an array of { name, position } objects ([] clears the series list).'
- ошибка `400` `invalid_work_id`: `Body field "workId" must be at most ${MAX_WORK_ID} characters.`
- ошибка `400` `profile_required`: 'Body must contain "profile".'
- ошибка `400` `work_id_required`: 'Body must contain "workId".'

### `GET /api/books/stats`

- файл: `server/books/routes-stats.js:15`
- query (строгий список): `includeMangaComics`, `profile`
- ошибка `400` `invalid_include_manga`: must be 0 or 1.

### `GET /api/books/unmatched`

- файл: `server/books/routes-stats.js:37`
- query (строгий список): `profile`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `DELETE /api/books/work/flag`

- файл: `server/books/routes.js:422`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `workId` — см. модуль
- ошибка `400` `work_id_required`: 'Query parameter "workId" is required.'

### `POST /api/books/work/flag`

- файл: `server/books/routes.js:401`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `manga_flag_required`: 'Body must contain "mangaComics" as a boolean (true = hide, false = show).'
- ошибка `400` `work_id_required`: 'Body must contain "workId".'

### `POST /api/books/year-override`

- файл: `server/books/routes.js:438`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `invalid_year`: `Body field "year" must be an integer in ${YEAR_OVERRIDE_MIN}..${YEAR_OVERRIDE_MAX} ` + 'or null to remove the correction.'
- ошибка `400` `profile_required`: 'Body must contain "profile".'
- ошибка `400` `unknown_work`: `Work "${workId}" is not part of profile ${selected.source}-${selected.userKey}.`
- ошибка `400` `work_id_required`: 'Body must contain "workId".'

### `GET /api/compare`

- файл: `server/films/routes.js:277`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `a`, `b` — см. модуль
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/enrich`

- файл: `server/films/routes.js:83`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `upload_id_required`: 'Body must contain "uploadId".'
- ошибка `404` `unknown_upload`: 'Unknown uploadId. Upload the ZIP again.'

### `GET /api/enrich/status`

- файл: `server/films/routes.js:101`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `uploadId` — см. модуль
- ошибка `400` `upload_id_required`: 'Query parameter "uploadId" is required.'
- ошибка `404` `unknown_upload`: 'Unknown uploadId. Upload the ZIP again.'

### `GET /api/games/achievements`

- файл: `server/games/endpoints/achievements.js:17`
- query (строгий список): `appid`, `profile`, `refresh`
- ошибка `400` `invalid_appid`: 'Query parameter "appid" must be a positive integer.'

### `POST /api/games/enrich`

- файл: `server/games/endpoints/enrich.js:12`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `force`, `phase`, `phases`, `profile`, `recheckDays` — см. модуль
- ошибка `400` `invalid_recheckDays`: 'Parameter "recheckDays" must be a non-negative number of days.'

### `GET /api/games/enrich/:jobId`

- файл: `server/games/endpoints/enrich.js:91`
- path-параметры: `jobId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_job`: 'Unknown enrich job id.'

### `GET /api/games/enrich/status`

- файл: `server/games/endpoints/enrich.js:77`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `id` — см. модуль
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown enrich job id.'

### `POST /api/games/epic/auth`

- файл: `server/games/endpoints/epic/auth.js:64`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/epic/auth-url`

- файл: `server/games/endpoints/epic/auth.js:11`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `DELETE /api/games/epic/auth/:authId`

- файл: `server/games/endpoints/epic/auth.js:105`
- path-параметры: `authId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_auth`: 'Unknown Epic auth session.'

### `GET /api/games/epic/auth/:authId`

- файл: `server/games/endpoints/epic/auth.js:89`
- path-параметры: `authId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_auth`: 'Unknown Epic auth session.'

### `POST /api/games/epic/connect`

- файл: `server/games/endpoints/epic/auth.js:30`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `code` — см. модуль
- ошибка `400` `epic_code_required`: 'Body must contain "code" — the one-time code from the Epic login redirect ' + '(epicgames.com/id/api/redirect?code=…).'

### `POST /api/games/epic/disconnect`

- файл: `server/games/endpoints/epic/disconnect.js:12`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `epic_account_required`: 'Body must contain "accountId" or "owner" (steam-<steamid64>).'

### `GET /api/games/epic/exported`

- файл: `server/games/endpoints/epic/exported.js:11`
- query (строгий список): `accountId`, `owner`
- ошибка `400` `owner_required`: 'Query parameter "owner" (steam-<steamid64>) or "accountId" is required.'

### `POST /api/games/epic/import`

- файл: `server/games/endpoints/epic/import.js:39`
- query (строгий список): `force`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/epic/import/:jobId`

- файл: `server/games/endpoints/epic/import.js:72`
- path-параметры: `jobId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_job`: 'Unknown Epic import job id.'

### `GET /api/games/epic/import/status`

- файл: `server/games/endpoints/epic/import.js:57`
- query (строгий список): `id`
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown Epic import job id.'

### `POST /api/games/epic/refresh`

- файл: `server/games/endpoints/epic/import.js:48`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/epic/status`

- файл: `server/games/endpoints/epic/status.js:12`
- query (строгий список): `accountId`, `owner`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/games/franchise-enrich`

- файл: `server/games/routes-franchise.js:138`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `force`, `profile` — см. модуль
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/franchise-enrich/:jobId`

- файл: `server/games/routes-franchise.js:172`
- path-параметры: `jobId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_job`: 'Unknown franchise job id.'

### `GET /api/games/franchise-enrich/status`

- файл: `server/games/routes-franchise.js:157`
- query (строгий список): `id`
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown franchise job id.'

### `GET /api/games/franchises`

- файл: `server/games/routes-franchise.js:117`
- query (строгий список): `profile`
- ошибка `400` `profile_not_imported`: `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`

### `GET /api/games/game/:appid`

- файл: `server/games/endpoints/game.js:29`
- path-параметры: `appid`
- query (строгий список): `profile`
- ошибка `400` `invalid_appid`: 'Path parameter "appid" must be a positive integer.'
- ошибка `404` `game_not_in_library`: `App ${appid} is not in the ${scope.parsed.key} library.`

### `POST /api/games/gog/auth`

- файл: `server/games/routes-gog.js:76`
- query (строгий список): `code`, `profile`
- ошибка `400` `gog_code_required`: 'Body must contain "code" — the one-time code from the GOG login redirect.'

### `GET /api/games/gog/auth-url`

- файл: `server/games/routes-gog.js:58`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/games/gog/import`

- файл: `server/games/routes-gog.js:141`
- query (строгий список): `account`, `force`, `profile`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/gog/import/:jobId`

- файл: `server/games/routes-gog.js:177`
- path-параметры: `jobId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_job`: 'Unknown GOG import job id.'

### `GET /api/games/gog/import/status`

- файл: `server/games/routes-gog.js:162`
- query (строгий список): `id`
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown GOG import job id.'

### `POST /api/games/gog/logout`

- файл: `server/games/routes-gog.js:187`
- query (строгий список): `account`, `profile`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/gog/status`

- файл: `server/games/routes-gog.js:100`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/games/import`

- файл: `server/games/endpoints/import.js:50`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/import/:jobId`

- файл: `server/games/endpoints/import.js:104`
- path-параметры: `jobId`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `404` `unknown_job`: 'Unknown import job id.'

### `GET /api/games/import/status`

- файл: `server/games/endpoints/import.js:90`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `id` — см. модуль
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown import job id.'

### `POST /api/games/import/steam`

- файл: `server/games/endpoints/import.js:58`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/games/override`

- файл: `server/games/personnel/routes-personnel.js:180`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/personnel`

- файл: `server/games/personnel/routes-personnel.js:121`
- query (строгий список): `limit`, `profile`, `role`, `sort`
- ошибка `400` `invalid_limit`: 'Query parameter "limit" must be an integer between 1 and 50.'
- ошибка `400` `profile_not_imported`: `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`

### `GET /api/games/personnel/status`

- файл: `server/games/personnel/routes-personnel.js:165`
- query (строгий список): `id`
- ошибка `400` `job_id_required`: 'Query parameter "id" is required.'
- ошибка `404` `unknown_job`: 'Unknown personnel job id.'

### `GET /api/games/profiles`

- файл: `server/games/endpoints/profiles.js:100`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/games/refresh`

- файл: `server/games/endpoints/import.js:66`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `profile` — см. модуль
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/secondary-details/status`

- файл: `server/games/endpoints/stats.js:12`
- query (строгий список): `profile`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/games/stats`

- файл: `server/games/endpoints/stats.js:26`
- query (строгий список): `includeDlc`, `includeFree`, `minHours`, `profile`
- ошибка `400` `profile_not_imported`: `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`

### `GET /api/games/steam-art/:type/:appid`

- файл: `server/games/endpoints/game.js:17`
- path-параметры: `type`, `appid`
- query (строгий список): `h`
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/health`

- файл: `server/index.js:51`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `POST /api/import/kinopoisk`

- файл: `server/films/routes.js:117`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `url_required`: 'Body must contain "url" (a KinoPoisk user profile or votes URL).'

### `GET /api/import/kinopoisk/status`

- файл: `server/films/routes.js:134`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `uploadId` — см. модуль
- ошибка `400` `upload_id_required`: 'Query parameter "uploadId" is required.'
- ошибка `404` `unknown_kinopoisk_import`: 'This uploadId is not a KinoPoisk import.'
- ошибка `404` `unknown_upload`: 'Unknown uploadId. Start the KinoPoisk import again.'

### `POST /api/match`

- файл: `server/films/routes.js:320`
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

### `GET /api/profiles`

- файл: `server/films/routes.js:269`
- query: — (строгого `assertOnlyParams` нет)
- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)

### `GET /api/stats`

- файл: `server/films/routes.js:239`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `kpUserId`, `uploadId` — см. модуль
- ошибка `400` `enrichment_not_finished`
- ошибка `400` `upload_id_required`: 'Query parameter "uploadId" is required.'
- ошибка `404` `unknown_upload`: 'Unknown uploadId. Upload the ZIP again.'

### `GET /api/tmdb/search`

- файл: `server/films/routes.js:289`
- query: — (строгого `assertOnlyParams` нет)
- query, читаемый без строгой проверки: `kind`, `q` — см. модуль
- ошибка `400` `invalid_kind`: 'Query parameter "kind" must be "movie", "tv" or "all".'
- ошибка `400` `query_required`: 'Query parameter "q" is required.'

### `POST /api/upload`

- файл: `server/films/routes.js:55`
- query: — (строгого `assertOnlyParams` нет)
- ошибка `400` `file_required`: 'No file received. Send the Letterboxd export as multipart/form-data field "file".'

