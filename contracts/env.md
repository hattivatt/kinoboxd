<!-- GENERATED FILE — do not edit by hand. Regenerate: node scripts/gen-contracts.js env -->
# Environment contract

Все имена переменных окружения, которые читает сервер (P9, план §3.5). Источник — `process.env.*`, поля `*Env` таблицы `server/core/sources.js` и алиасы `server/config.js`.

Имён: **119**. Конвенция таблицы источников: `0` = «выключено», пустое/незаданное значение = значение по умолчанию (`server/core/sources.js`). Секреты не эхоятся: в отчётах только имя и источник.

## Секреты и алиасы (`server/config.js`)

| Секрет | Env-имена (первое — основное) | Dev-фоллбек |
| --- | --- | --- |
| `tmdb` | `TMDB_API_TOKEN`, `TMDB_READ_ACCESS_TOKEN` | `config/tmdb-token` |
| `hardcover` | `HARDCOVER_API_TOKEN`, `HARDCOVER_READ_TOKEN` | `config/hardcover-token` |
| `gbooks` | `GB_API_KEY`, `BOOKS_GOOGLE_API_KEY` | `config/gbooks-token` |
| `steam` | `STEAM_API_KEY` | `config/steam-token` |
| `steamgriddb` | `STEAMGRIDDB_API_KEY` | `config/steamgriddb-token` |
| ``server/games/personnel/moby.js` (key_ENV_KEYS)` | `MOBYGAMES_API_KEY`, `MOBY_API_KEY` | `app/config/moby-token` |

## Все переменные

| Имя | По умолчанию | Где объявлено/используется | Назначение |
| --- | --- | --- | --- |
| `BACKFILL_CONCURRENCY` | `8` (server/backfill.js) | `server/backfill.js:53` | Math.min(16, Number(process.env.BACKFILL_CONCURRENCY) \|\| 8) |
| `BACKFILL_TARGET` | см. файл | `server/backfill.js:74` | const TARGET = normalizeTarget(process.argv[2] \|\| process.env.BACKFILL_TARGET); |
| `BOOKS_BACKFILL_LIMIT` | см. файл | `server/books/stats/coverage.js:163` | const backfillLimit = Number(process.env.BOOKS_BACKFILL_LIMIT); |
| `BOOKS_GB_BUDGET` | budget = 300 (0 = off) (`googlebooks`) | `server/core/sources.js` (googlebooks) | const source = createSourceClient({ name: NAME, budgetEnv: 'BOOKS_GB_BUDGET' }); |
| `BOOKS_LITRES_BUDGET` | budget = 200 (0 = off) (`litres`) | `server/core/sources.js` (litres) | const litresBudget = resolve.createLitresBudget(process.env.BOOKS_LITRES_BUDGET); |
| `BOOKS_LIVELIB_CARD_BUDGET` | budget = 300 (0 = off) (`livelib`) | `server/core/sources.js` (livelib) | const cardBudget = resolve.createCardBudget(process.env.BOOKS_LIVELIB_CARD_BUDGET); |
| `BOOKS_RESOLVE_LOCK_WAIT_MS` | см. файл | `server/books/import.js:160` | One resolve pass at a time across processes: the scheduled `kinoboxd-resolve-books` oneshot takes the same `cache-book/resolve.lock`. Both spend the Литрес budget and write links/details, so running them in parallel wou… |
| `DEBUG_BROAD` | см. файл | `server/tmdb.js:626` | if (process.env.DEBUG_BROAD) { |
| `DEBUG_REMATCH` | см. файл | `server/rematch.js:240` | The new id is still valid; a later enrich/backfill can fetch details. |
| `DEBUG_RETRY` | см. файл | `server/tmdb.js:129` | if (process.env.DEBUG_RETRY) { |
| `EPIC_CLIENT_ID` | `process.env.GAMES_EPIC_CLIENT_ID` (server/games/epic.js) | `server/games/epic.js:145` | const envId = process.env.EPIC_CLIENT_ID \|\| process.env.GAMES_EPIC_CLIENT_ID; |
| `EPIC_CLIENT_SECRET` | `process.env.GAMES_EPIC_CLIENT_SECRET` (server/games/epic.js) | `server/games/epic.js:146` | const envSecret = process.env.EPIC_CLIENT_SECRET \|\| process.env.GAMES_EPIC_CLIENT_SECRET; |
| `GAMES_ACHIEVEMENTS_TTL_MS` | см. файл | `server/games/game-cache.js:191` | const raw = Number(process.env.GAMES_ACHIEVEMENTS_TTL_MS); |
| `GAMES_ART_TTL_MS` | ttlMs = 15552000000 ms (180 d) (`steamBrowse`) | `server/core/sources.js` (steamBrowse) | ttlEnv: 'GAMES_ART_TTL_MS', |
| `GAMES_BASE_DETAILS_BUDGET` | `20 (DEFAULT_BASE_DETAILS_BUDGET)` (server/games/franchise.js) | `server/games/franchise.js:1315` | return budgetLimitFromEnv('GAMES_BASE_DETAILS_BUDGET', DEFAULT_BASE_DETAILS_BUDGET); |
| `GAMES_BROWSE_BREAKER_MS` | breakerMs = 1800000 ms (30 min) (`steamBrowse`) | `server/core/sources.js` (steamBrowse) | breakerEnv: 'GAMES_BROWSE_BREAKER_MS', |
| `GAMES_BROWSE_BUDGET` | budget = 340 (0 = off) (`steamBrowse`) | `server/core/sources.js` (steamBrowse) | budgetEnv: 'GAMES_BROWSE_BUDGET', |
| `GAMES_BROWSE_PAUSE_MS` | pauseMs = 150 ms (`steamBrowse`) | `server/core/sources.js` (steamBrowse) | The per-asset hash of the new-schema vertical capsule is published only by the store-frontend method `IStoreBrowseService/GetItems` (no key). One request per appid per 180-day resolve, 150 ms apart. |
| `GAMES_BROWSE_TIMEOUT_MS` | timeoutMs = 20000 ms (20 s) (`steamBrowse`) | `server/core/sources.js` (steamBrowse) | timeoutEnv: 'GAMES_BROWSE_TIMEOUT_MS', |
| `GAMES_EPIC_ACCOUNT_HOST` | `account-public-service-prod03.ol.epicgames.com (ACCOUNT_HOST)` (server/games/sources/epic-requests.js) | `server/games/sources/epic-requests.js:85` | const accountHost = options.accountHost \|\| process.env.GAMES_EPIC_ACCOUNT_HOST \|\| ACCOUNT_HOST; |
| `GAMES_EPIC_BREAKER_MS` | breakerMs = 1800000 ms (30 min) (`epic`) | `server/core/sources.js` (epic) | breakerEnv: 'GAMES_EPIC_BREAKER_MS', |
| `GAMES_EPIC_CATALOG_HOST` | `catalog-public-service-prod06.ol.epicgames.com (CATALOG_HOST)` (server/games/sources/epic-requests.js) | `server/games/sources/epic-requests.js:100` | catalogHost: options.catalogHost \|\| process.env.GAMES_EPIC_CATALOG_HOST \|\| CATALOG_HOST, |
| `GAMES_EPIC_CATALOG_TTL_MS` | `15552000000 ms (180 d) (CATALOG_TTL_MS)` (server/games/epic-cache.js) | `server/games/epic-cache.js:521` | return envTtl('GAMES_EPIC_CATALOG_TTL_MS', CATALOG_TTL_MS); |
| `GAMES_EPIC_CLIENT_ID` | см. файл | `server/games/epic.js:145` | const envId = process.env.EPIC_CLIENT_ID \|\| process.env.GAMES_EPIC_CLIENT_ID; |
| `GAMES_EPIC_CLIENT_SECRET` | см. файл | `server/games/epic.js:146` | const envSecret = process.env.EPIC_CLIENT_SECRET \|\| process.env.GAMES_EPIC_CLIENT_SECRET; |
| `GAMES_EPIC_COUNTRY` | `'US'` (server/games/sources/epic-requests.js) | `server/games/sources/epic-requests.js:105` | country: options.country \|\| process.env.GAMES_EPIC_COUNTRY \|\| 'US', |
| `GAMES_EPIC_ENTITLEMENT_HOST` | `entitlement-public-service-prod08.ol.epicgames.com (ENTITLEMENT_HOST)` (server/games/sources/epic-requests.js) | `server/games/sources/epic-requests.js:102` | options.entitlementHost \|\| process.env.GAMES_EPIC_ENTITLEMENT_HOST \|\| ENTITLEMENT_HOST, |
| `GAMES_EPIC_LIBRARY_HOST` | `library-service.live.use1a.on.epicgames.com (LIBRARY_HOST)` (server/games/sources/epic-requests.js) | `server/games/sources/epic-requests.js:99` | libraryHost: options.libraryHost \|\| process.env.GAMES_EPIC_LIBRARY_HOST \|\| LIBRARY_HOST, |
| `GAMES_EPIC_LIBRARY_TTL_MS` | `86400000 ms (1 d) (LIBRARY_TTL_MS)` (server/games/epic-cache.js) | `server/games/epic-cache.js:513` | return envTtl('GAMES_EPIC_LIBRARY_TTL_MS', LIBRARY_TTL_MS); |
| `GAMES_EPIC_LOCALE` | `'en-US'` (server/games/sources/epic-requests.js) | `server/games/sources/epic-requests.js:106` | locale: options.locale \|\| process.env.GAMES_EPIC_LOCALE \|\| 'en-US', |
| `GAMES_EPIC_PAUSE_MS` | pauseMs = 300 ms (`epic`) | `server/core/sources.js` (epic) | pauseEnv: 'GAMES_EPIC_PAUSE_MS', |
| `GAMES_EPIC_PLAYTIME_TTL_MS` | `86400000 ms (1 d) (PLAYTIME_TTL_MS)` (server/games/epic-cache.js) | `server/games/epic-cache.js:517` | return envTtl('GAMES_EPIC_PLAYTIME_TTL_MS', PLAYTIME_TTL_MS); |
| `GAMES_EPIC_PRODUCTMAPPING_TTL_MS` | `604800000 ms (7 d) (PRODUCT_MAPPING_TTL_MS)` (server/games/epic-cache.js) | `server/games/epic-cache.js:525` | return envTtl('GAMES_EPIC_PRODUCTMAPPING_TTL_MS', PRODUCT_MAPPING_TTL_MS); |
| `GAMES_EPIC_STORE_CONTENT_HOST` | `store-content.ak.epicgames.com (STORE_CONTENT_HOST)` (server/games/sources/epic-requests.js) | `server/games/sources/epic-requests.js:104` | options.storeContentHost \|\| process.env.GAMES_EPIC_STORE_CONTENT_HOST \|\| STORE_CONTENT_HOST, |
| `GAMES_EPIC_TIMEOUT_MS` | timeoutMs = 20000 ms (20 s) (`epic`) | `server/core/sources.js` (epic) | timeoutEnv: 'GAMES_EPIC_TIMEOUT_MS', |
| `GAMES_FRANCHISE_BUDGET` | budget = 450 (0 = off) (`wikidataFranchise`) | `server/core/sources.js` (wikidataFranchise) | budgetEnv: 'GAMES_FRANCHISE_BUDGET', |
| `GAMES_FRANCHISE_TTL_DAYS` | ttlMs = 7776000000 ms (90 d) (env in days) (`wikidataFranchise`) | `server/core/sources.js` (wikidataFranchise) | ttlEnv: 'GAMES_FRANCHISE_TTL_DAYS', |
| `GAMES_GLOBAL_TTL_MS` | см. файл | `server/games/game-cache.js:196` | const raw = Number(process.env.GAMES_GLOBAL_TTL_MS); |
| `GAMES_GOG_BREAKER_MS` | breakerMs = 1800000 ms (30 min) (`gog`) | `server/core/sources.js` (gog) | breakerEnv: 'GAMES_GOG_BREAKER_MS', |
| `GAMES_GOG_BUDGET` | budget = 200 (0 = off) (`gog`) | `server/core/sources.js` (gog) | budgetEnv: 'GAMES_GOG_BUDGET', |
| `GAMES_GOG_LIBRARY_PAUSE_MS` | pauseMs = 400 ms (`gog`) | `server/core/sources.js` (gog) | pauseEnv: 'GAMES_GOG_LIBRARY_PAUSE_MS', |
| `GAMES_GOG_LIBRARY_TTL_MS` | `86400000 ms (1 d) (LIBRARY_TTL_MS)` (server/games/gog-cache.js) | `server/games/gog-cache.js:125` | return envMs('GAMES_GOG_LIBRARY_TTL_MS', LIBRARY_TTL_MS); |
| `GAMES_GOG_PLAYTIME_PAUSE_MS` | playtimePauseMs = 500 ms (`gog`) | `server/core/sources.js` (gog) | playtimePauseEnv: 'GAMES_GOG_PLAYTIME_PAUSE_MS', |
| `GAMES_GOG_PLAYTIME_TTL_MS` | `86400000 ms (1 d) (PLAYTIME_TTL_MS)` (server/games/gog-cache.js) | `server/games/gog-cache.js:129` | return envMs('GAMES_GOG_PLAYTIME_TTL_MS', PLAYTIME_TTL_MS); |
| `GAMES_GOG_RECHECK_ZERO_MS` | см. файл | `server/games/gog-import.js:76` | const raw = Number(process.env.GAMES_GOG_RECHECK_ZERO_MS); |
| `GAMES_GOG_REFRESH_MARGIN_MS` | `300000 ms (5 min) (DEFAULT_REFRESH_MARGIN_MS)` (server/games/gog-cache.js) | `server/games/gog-cache.js:141` | return envMs('GAMES_GOG_REFRESH_MARGIN_MS', DEFAULT_REFRESH_MARGIN_MS); |
| `GAMES_GOG_TIMEOUT_MS` | timeoutMs = 20000 ms (20 s) (`gog`) | `server/core/sources.js` (gog) | timeoutEnv: 'GAMES_GOG_TIMEOUT_MS', |
| `GAMES_LIBRARY_TTL_MS` | см. файл | `server/games/game-cache.js:186` | const raw = Number(process.env.GAMES_LIBRARY_TTL_MS); |
| `GAMES_MOBY_BUDGET` | budget = 100 (0 = off) (`moby`) | `server/core/sources.js` (moby) | budgetEnv: 'GAMES_MOBY_BUDGET', |
| `GAMES_MOBY_PAUSE_MS` | pauseMs = 1100 ms (`moby`) | `server/core/sources.js` (moby) | pauseEnv: 'GAMES_MOBY_PAUSE_MS', |
| `GAMES_PERSONNEL_LOCK_WAIT_MS` | см. файл | `server/games/personnel/backfill.js:82` | const raw = Number(process.env.GAMES_PERSONNEL_LOCK_WAIT_MS); |
| `GAMES_REVIEWS_BREAKER_MS` | breakerMs = 1800000 ms (30 min) (`steamReviews`) | `server/core/sources.js` (steamReviews) | breakerEnv: 'GAMES_REVIEWS_BREAKER_MS', |
| `GAMES_REVIEWS_BUDGET` | budget = 340 (0 = off) (`steamReviews`) | `server/core/sources.js` (steamReviews) | budgetEnv: 'GAMES_REVIEWS_BUDGET', |
| `GAMES_REVIEWS_PAUSE_MS` | pauseMs = 1700 ms (`steamReviews`) | `server/core/sources.js` (steamReviews) | pauseEnv: 'GAMES_REVIEWS_PAUSE_MS', |
| `GAMES_REVIEWS_RECHECK_DAYS` | см. файл | `server/games/enrich.js:128` | recheckEnv: 'GAMES_REVIEWS_RECHECK_DAYS', |
| `GAMES_REVIEWS_TIMEOUT_MS` | timeoutMs = 20000 ms (20 s) (`steamReviews`) | `server/core/sources.js` (steamReviews) | timeoutEnv: 'GAMES_REVIEWS_TIMEOUT_MS', |
| `GAMES_REVIEWS_TTL_MS` | ttlMs = 2592000000 ms (30 d) (`steamReviews`) | `server/core/sources.js` (steamReviews) | ttlEnv: 'GAMES_REVIEWS_TTL_MS', |
| `GAMES_SECONDARY_BREAKER_MS` | breakerMs = 1800000 ms (30 min) (`secondary`) | `server/core/sources.js` (secondary) | breakerEnv: 'GAMES_SECONDARY_BREAKER_MS', |
| `GAMES_SECONDARY_BUDGET` | budget = 200 (0 = off) (`secondary`) | `server/core/sources.js` (secondary) | budgetEnv: 'GAMES_SECONDARY_BUDGET', |
| `GAMES_SECONDARY_CATALOG_PROBE_TTL_MS` | `2592000000 ms (30 d) (DEFAULT_CATALOG_PROBE_TTL_MS)` (server/games/secondary/store.js) | `server/games/secondary/store.js:104` | return envMs('GAMES_SECONDARY_CATALOG_PROBE_TTL_MS', DEFAULT_CATALOG_PROBE_TTL_MS); |
| `GAMES_SECONDARY_KICK_COOLDOWN_MS` | `600000 ms (10 min) (DEFAULT_KICK_COOLDOWN_MS)` (server/games/secondary-details.js) | `server/games/secondary-details.js:137` | return envMs('GAMES_SECONDARY_KICK_COOLDOWN_MS', DEFAULT_KICK_COOLDOWN_MS); |
| `GAMES_SECONDARY_LAZY_KICK` | `''` (server/games/secondary-details.js) | `server/games/secondary-details.js:998` | if (String(process.env.GAMES_SECONDARY_LAZY_KICK \|\| '').trim() === '0') { |
| `GAMES_SECONDARY_LINKS_TTL_MS` | см. файл | `server/games/secondary/index.js:336` | const raw = Number(process.env.GAMES_SECONDARY_LINKS_TTL_MS); |
| `GAMES_SECONDARY_NOT_FOUND_TTL_MS` | `2592000000 ms (30 d) (DEFAULT_NOT_FOUND_TTL_MS)` (server/games/secondary/store.js) | `server/games/secondary/store.js:91` | return envMs('GAMES_SECONDARY_NOT_FOUND_TTL_MS', DEFAULT_NOT_FOUND_TTL_MS); |
| `GAMES_SECONDARY_PAUSE_MS` | pauseMs = 2000 ms (2 s) (`secondary`) | `server/core/sources.js` (secondary) | pauseEnv: 'GAMES_SECONDARY_PAUSE_MS', |
| `GAMES_SECONDARY_PROBE_TTL_MS` | `604800000 ms (7 d) (DEFAULT_PROBE_TTL_MS)` (server/games/secondary/store.js) | `server/games/secondary/store.js:96` | return envMs('GAMES_SECONDARY_PROBE_TTL_MS', DEFAULT_PROBE_TTL_MS); |
| `GAMES_SECONDARY_TIMEOUT_MS` | timeoutMs = 20000 ms (20 s) (`secondary`) | `server/core/sources.js` (secondary) | timeoutEnv: 'GAMES_SECONDARY_TIMEOUT_MS', |
| `GAMES_SECONDARY_TTL_MS` | ttlMs = 2592000000 ms (30 d) (`secondary`) | `server/core/sources.js` (secondary) | ttlEnv: 'GAMES_SECONDARY_TTL_MS', |
| `GAMES_SGDB_BREAKER_MS` | breakerMs = 1800000 ms (30 min) (`steamGridDb`) | `server/core/sources.js` (steamGridDb) | breakerEnv: 'GAMES_SGDB_BREAKER_MS', |
| `GAMES_SGDB_BUDGET` | budget = 50 (0 = off) (`steamGridDb`) | `server/core/sources.js` (steamGridDb) | budgetEnv: 'GAMES_SGDB_BUDGET', |
| `GAMES_SGDB_PAUSE_MS` | pauseMs = 1000 ms (1 s) (`steamGridDb`) | `server/core/sources.js` (steamGridDb) | Optional community grids for SKUs Steam publishes no vertical capsule for. Without `STEAMGRIDDB_API_KEY` the provider is skipped silently. |
| `GAMES_SGDB_TIMEOUT_MS` | timeoutMs = 20000 ms (20 s) (`steamGridDb`) | `server/core/sources.js` (steamGridDb) | timeoutEnv: 'GAMES_SGDB_TIMEOUT_MS', |
| `GAMES_SPY_BREAKER_MS` | breakerMs = 1800000 ms (30 min) (`steamSpy`) | `server/core/sources.js` (steamSpy) | breakerEnv: 'GAMES_SPY_BREAKER_MS', |
| `GAMES_SPY_BUDGET` | budget = 340 (0 = off) (`steamSpy`) | `server/core/sources.js` (steamSpy) | budgetEnv: 'GAMES_SPY_BUDGET', |
| `GAMES_SPY_PAUSE_MS` | pauseMs = 1100 ms (`steamSpy`) | `server/core/sources.js` (steamSpy) | pauseEnv: 'GAMES_SPY_PAUSE_MS', |
| `GAMES_SPY_RECHECK_DAYS` | см. файл | `server/games/enrich.js:110` | recheckEnv: 'GAMES_SPY_RECHECK_DAYS', |
| `GAMES_SPY_TIMEOUT_MS` | timeoutMs = 20000 ms (20 s) (`steamSpy`) | `server/core/sources.js` (steamSpy) | timeoutEnv: 'GAMES_SPY_TIMEOUT_MS', |
| `GAMES_SPY_TTL_MS` | ttlMs = 2592000000 ms (30 d) (`steamSpy`) | `server/core/sources.js` (steamSpy) | ttlEnv: 'GAMES_SPY_TTL_MS', |
| `GAMES_STEAM_BREAKER_MS` | breakerMs = 1800000 ms (30 min) (`steam`); breakerMs = 1800000 ms (30 min) (`steamCommunity`) | `server/core/sources.js` (steam, steamCommunity) | breakerEnv: 'GAMES_STEAM_BREAKER_MS', |
| `GAMES_STEAM_COMMUNITY_PAUSE_MS` | pauseMs = 2000 ms (2 s) (`steamCommunity`) | `server/core/sources.js` (steamCommunity) | pauseEnv: 'GAMES_STEAM_COMMUNITY_PAUSE_MS', |
| `GAMES_STEAM_DNS_SERVERS` | `''` (server/games/steam.js) | `server/games/steam.js:103` | const servers = (dnsServers \|\| process.env.GAMES_STEAM_DNS_SERVERS \|\| '') |
| `GAMES_STEAM_TIMEOUT_MS` | timeoutMs = 20000 ms (20 s) (`steam`); timeoutMs = 20000 ms (20 s) (`steamCommunity`); timeoutMs = 20000 ms (20 s) (`steamStore`) | `server/core/sources.js` (steam, steamCommunity, steamStore) | timeoutEnv: 'GAMES_STEAM_TIMEOUT_MS', |
| `GAMES_STORE_BREAKER_MS` | breakerMs = 1800000 ms (30 min) (`steamStore`) | `server/core/sources.js` (steamStore) | breakerEnv: 'GAMES_STORE_BREAKER_MS', |
| `GAMES_STORE_BUDGET` | budget = 340 (0 = off) (`steamStore`) | `server/core/sources.js` (steamStore) | budgetEnv: 'GAMES_STORE_BUDGET', |
| `GAMES_STORE_CC` | `''` (server/games/store.js) | `server/games/store.js:446` | const cc = String(process.env.GAMES_STORE_CC \|\| '').trim(); |
| `GAMES_STORE_PAUSE_MS` | pauseMs = 1700 ms (`steamStore`) | `server/core/sources.js` (steamStore) | pauseEnv: 'GAMES_STORE_PAUSE_MS', |
| `GAMES_STORE_RECHECK_DAYS` | см. файл | `server/games/enrich.js:83` | recheckEnv: 'GAMES_STORE_RECHECK_DAYS', |
| `GAMES_STORE_TTL_MS` | ttlMs = 15552000000 ms (180 d) (`steamStore`) | `server/core/sources.js` (steamStore) | ttlEnv: 'GAMES_STORE_TTL_MS', |
| `GB_API_KEY` | env или файл `config/gbooks-token` (значение не эхоится) | `server/config.js` (gbooks) | const GBOOKS_ENV_KEYS = ['GB_API_KEY', 'BOOKS_GOOGLE_API_KEY']; |
| `GOG_CLIENT_ID` | см. файл | `server/games/sources/gog-requests.js:70` | const envId = process.env.GOG_CLIENT_ID; |
| `GOG_CLIENT_SECRET` | см. файл | `server/games/sources/gog-requests.js:71` | const envSecret = process.env.GOG_CLIENT_SECRET; |
| `HARDCOVER_API_TOKEN` | env или файл `config/hardcover-token` (значение не эхоится) | `server/config.js` (hardcover) | const HARDCOVER_ENV_KEYS = ['HARDCOVER_API_TOKEN', 'HARDCOVER_READ_TOKEN']; |
| `KINOBOXD_BOOKS_PROFILE` | `''` (server/books/authors-backfill.js) | `server/books/authors-backfill.js:60` | const raw = options.profile \|\| process.env.KINOBOXD_BOOKS_PROFILE \|\| ''; |
| `KINOBOXD_BOOKS_WIKIDATA` | `''` (server/books/authors-bridge.js) | `server/books/authors-bridge.js:47` | const raw = String(process.env.KINOBOXD_BOOKS_WIKIDATA \|\| '').trim().toLowerCase(); |
| `KINOBOXD_CACHE_BOOK_DIR` | см. файл | `server/books/book-cache.js:36` | const BOOK_CACHE_DIR = process.env.KINOBOXD_CACHE_BOOK_DIR |
| `KINOBOXD_CACHE_DIR` | см. файл | `server/cache.js:10` | KINOBOXD_CACHE_DIR lets tests / alternative deployments point the whole TMDB + KinoPoisk cache tree somewhere else. Defaults to app/cache so the normal launcher (and the Nix wrapper, which copies server/ next to cache/)… |
| `KINOBOXD_CACHE_GAMES_DIR` | см. файл | `server/games/game-cache.js:50` | const GAMES_CACHE_DIR = process.env.KINOBOXD_CACHE_GAMES_DIR |
| `KINOBOXD_EPIC_CLIENT_FILE` | см. файл | `server/games/epic.js:103` | const CLIENT_FILE_ENV = 'KINOBOXD_EPIC_CLIENT_FILE'; |
| `KINOBOXD_EPIC_TOKENS_DIR` | см. файл | `server/games/epic-token-store.js:38` | const TOKENS_DIR = process.env.KINOBOXD_EPIC_TOKENS_DIR |
| `KINOBOXD_GAMES_MOBY` | `''` (server/games/personnel/moby.js) | `server/games/personnel/moby.js:124` | const raw = String(process.env.KINOBOXD_GAMES_MOBY \|\| '').trim().toLowerCase(); |
| `KINOBOXD_GAMES_WD` | `''` (server/games/personnel/wikidata.js) | `server/games/personnel/wikidata.js:97` | const raw = String(process.env.KINOBOXD_GAMES_WD \|\| '').trim().toLowerCase(); |
| `KINOBOXD_GOG_CLIENT_FILE` | см. файл | `server/games/sources/gog-requests.js:31` | const CLIENT_FILE_ENV = 'KINOBOXD_GOG_CLIENT_FILE'; |
| `KINOBOXD_LIVELIB_REIMPORT_TTL_MS` | см. файл | `server/books/import.js:44` | A cached LiveLib profile is considered current for 12 hours: repeat clicks reuse it instead of re-scraping the whole profile (LiveLib politeness). |
| `KINOBOXD_MOBY_KEY_FILE` | см. файл | `server/games/personnel/moby.js:44` | const KEY_FILE_ENV = 'KINOBOXD_MOBY_KEY_FILE'; |
| `KINOBOXD_PASSWORD` | см. файл | `server/auth.js:22` | typeof process.env.KINOBOXD_PASSWORD === 'string' ? process.env.KINOBOXD_PASSWORD : ''; |
| `KINOBOXD_SEGMENTS_INCLUDE_MEDIUM` | `''` (server/books/stats.js) | `server/books/stats.js:372` | const raw = String(process.env.KINOBOXD_SEGMENTS_INCLUDE_MEDIUM \|\| '').trim().toLowerCase(); |
| `KINOBOXD_STATE_DIR` | см. файл | `server/games/game-cache.js:54` | const STATE_DIR = process.env.KINOBOXD_STATE_DIR |
| `KINOBOXD_STEAM_KEY_FILE` | см. файл | `server/config.js:41` | Tests point this at a non-existent file so the local dev fallback (`config/steam-token`, present in the main tree) cannot change their result. |
| `KINOBOXD_WDQS_ENDPOINT` | `https://query.wikidata.org/sparql (WDQS)` (server/books/authors-wikidata.js) | `server/books/authors-wikidata.js:36` | POST, not GET: a batch of 450 labels does not fit an URL (WDQS answers `414 URI Too Long` around ~8 KB). The endpoint accepts a form-encoded `query=` body for exactly this case. |
| `MOBYGAMES_API_KEY` | env или файл `app/config/moby-token` (значение не эхоится) | `server/config.js` (`server/games/personnel/moby.js` (key_ENV_KEYS)) | const KEY_ENV_KEYS = ['MOBYGAMES_API_KEY', 'MOBY_API_KEY']; |
| `PORT` | `3000` (server/index.js) | `server/index.js:42` | const PORT = Number(process.env.PORT) \|\| 3000; |
| `REMATCH_CONCURRENCY` | `8` (server/rematch.js) | `server/rematch.js:38` | Math.min(16, Number(process.env.REMATCH_CONCURRENCY) \|\| 8) |
| `REMATCH_DRY_RUN` | см. файл | `server/rematch.js:40` | const DRY_RUN = process.env.REMATCH_DRY_RUN === '1'; |
| `SMOKE_TMP` | см. файл | `scripts/smoke-preload.js:21` | const outDir = process.env.SMOKE_TMP; |
| `STEAM_API_KEY` | env или файл `config/steam-token` (значение не эхоится) | `server/config.js` (steam) | const STEAM_ENV_KEYS = ['STEAM_API_KEY']; |
| `STEAMGRIDDB_API_KEY` | env или файл `config/steamgriddb-token` (значение не эхоится) | `server/config.js` (steamgriddb) | const STEAMGRIDDB_ENV_KEYS = ['STEAMGRIDDB_API_KEY']; |
| `TMDB_API_BASE` | `'https://api.themoviedb.org/3'` (server/tmdb.js) | `server/tmdb.js:11` | `TMDB_API_BASE` lets a local backfill use TMDB's alternate API host when the canonical `api.themoviedb.org` endpoint is blocked by the network. Production keeps the documented default. |
| `TMDB_API_TOKEN` | env или файл `config/tmdb-token` (значение не эхоится) | `server/config.js` (tmdb) | const ENV_KEYS = ['TMDB_API_TOKEN', 'TMDB_READ_ACCESS_TOKEN']; |
| `WIKIDATA_REFRESH` | см. файл | `server/wikidata.js:740` | options.force === true \|\| String(process.env.WIKIDATA_REFRESH \|\| '') === '1'; |

## Общие env-пары (одно имя — несколько источников)

| Env | Источники | Значение по умолчанию |
| --- | --- | --- |
| `GAMES_STEAM_BREAKER_MS` | `steam`, `steamCommunity` | breakerMs = 1800000 ms (30 min); breakerMs = 1800000 ms (30 min) |
| `GAMES_STEAM_TIMEOUT_MS` | `steam`, `steamCommunity`, `steamStore` | timeoutMs = 20000 ms (20 s); timeoutMs = 20000 ms (20 s); timeoutMs = 20000 ms (20 s) |

