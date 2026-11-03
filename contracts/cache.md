<!-- GENERATED FILE — do not edit by hand. Regenerate: node scripts/gen-contracts.js cache -->
# Cache layout

Раскладка кэша и state-каталогов, сгенерированная из path-констант `server/cache.js`, `server/books/book-cache.js`, `server/games/*-cache.js`, `server/games/epic-token-store.js` и `server/games/secondary/store.js` (P9). Корни переопределяются env-переменными (см. `contracts/env.md`).

## Корни

| Env | Константа | По умолчанию (env не задан) | Когда env задан | Модуль |
| --- | --- | --- | --- | --- |
| `KINOBOXD_CACHE_GAMES_DIR` | `GAMES_CACHE_DIR` | `app/cache-games` | `$ENV` | `server/games/game-cache.js` |
| `KINOBOXD_STATE_DIR` | `STATE_DIR` | `app/cache-games/state` | `<KINOBOXD_STATE_DIR>/games` | `server/games/game-cache.js` |
| `KINOBOXD_CACHE_BOOK_DIR` | `BOOK_CACHE_DIR` | `app/cache-book` | `$ENV` | `server/books/book-cache.js` |
| `KINOBOXD_CACHE_DIR` | `CACHE_DIR` | `app/cache` | `$ENV` | `server/cache.js` |
| `KINOBOXD_EPIC_TOKENS_DIR` | `TOKENS_DIR` | `app/cache-games/tokens` | `$ENV` | `server/games/epic-token-store.js` |

## Пути по модулям

### `server/cache.js`

| Константа | Путь |
| --- | --- |
| `CACHE_DIR` | `app/cache` |
| `INDEX_PATH` | `app/cache/index.json` |
| `LB_LINKS_PATH` | `app/cache/lb-links.json` |
| `DETAILS_DIR` | `app/cache/details` |

### `server/books/book-cache.js`

| Константа | Путь |
| --- | --- |
| `BOOK_CACHE_DIR` | `app/cache-book` |
| `PROFILES_DIR` | `app/cache-book/profiles` |
| `DETAILS_DIR` | `app/cache-book/details` |
| `LINKS_DIR` | `app/cache-book/links` |
| `IMPORTS_DIR` | `app/cache-book/imports` |
| `RESOLVE_STATE_DIR` | `app/cache-book/resolve-state` |
| `FLAGS_DIR` | `app/cache-book/flags` |
| `YEAR_OVERRIDES_DIR` | `app/cache-book/year-overrides` |
| `INDEX_PATH` | `app/cache-book/index.json` |
| `LINKS_JSON_PATH` | `app/cache-book/links.json` |
| `FLAGS_PATH` | `app/cache-book/flags/book-flags.json` |
| `MATCH_LOG_PATH` | `app/cache-book/match-log.jsonl` |
| `AUTHORS_PATH` | `app/cache-book/authors.json` |

### `server/games/game-cache.js`

| Константа | Путь |
| --- | --- |
| `GAMES_CACHE_DIR` | `app/cache-games` |
| `STATE_DIR` | `app/cache-games/state` |
| `PROFILES_DIR` | `app/cache-games/profiles` |
| `LIBRARY_DIR` | `app/cache-games/library` |
| `DETAILS_DIR` | `app/cache-games/details` |
| `DETAILS_BASE_DIR` | `app/cache-games/details-base` |
| `SPY_DIR` | `app/cache-games/spy` |
| `REVIEWS_DIR` | `app/cache-games/reviews` |
| `ACHIEVEMENTS_DIR` | `app/cache-games/achievements` |
| `GLOBAL_DIR` | `app/cache-games/global` |
| `BREAKER_PATH` | `app/cache-games/state/games-breaker.json` |
| `ENRICH_STATE_PATH` | `app/cache-games/state/enrich-state.json` |
| `DETAILS_HEAL_STATE_PATH` | `app/cache-games/state/details-heal-state.json` |
| `SPY_STATE_PATH` | `app/cache-games/state/spy-state.json` |
| `REVIEWS_STATE_PATH` | `app/cache-games/state/reviews-state.json` |

| TTL-константа | Выражение | Значение |
| --- | --- | --- |
| `LIBRARY_TTL_MS` | `24 * 60 * 60 * 1000` | 86400000 ms (1 d) |
| `ACHIEVEMENTS_TTL_MS` | `24 * 60 * 60 * 1000` | 86400000 ms (1 d) |
| `GLOBAL_TTL_MS` | `7 * 24 * 60 * 60 * 1000` | 604800000 ms (7 d) |
| `DETAILS_TTL_MS` | `180 * 24 * 60 * 60 * 1000` | 15552000000 ms (180 d) |
| `SPY_TTL_MS` | `30 * 24 * 60 * 60 * 1000` | 2592000000 ms (30 d) |
| `REVIEWS_TTL_MS` | `30 * 24 * 60 * 60 * 1000` | 2592000000 ms (30 d) |

### `server/books/livelib-cookies.js`

| Константа | Путь |
| --- | --- |
| `COOKIES_DIR` | `app/cache-book/cookies` |

### `server/books/resolve-lock.js`

| Константа | Путь |
| --- | --- |
| `LOCK_PATH` | `app/cache-book/resolve.lock` |

### `server/games/gog-cache.js`

| Константа | Путь |
| --- | --- |
| `PROFILES_DIR` | `app/cache-games/profiles` |
| `LIBRARY_DIR` | `app/cache-games/library` |
| `PLAYTIME_DIR` | `app/cache-games/playtime` |
| `TOKENS_DIR` | `app/cache-games/tokens` |
| `BREAKER_PATH` | `app/cache-games/state/gog-breaker.json` |
| `DEBUG_DIR` | `app/cache-games/debug/gog` |

| TTL-константа | Выражение | Значение |
| --- | --- | --- |
| `LIBRARY_TTL_MS` | `24 * 60 * 60 * 1000` | 86400000 ms (1 d) |
| `PLAYTIME_TTL_MS` | `24 * 60 * 60 * 1000` | 86400000 ms (1 d) |

### `server/games/epic-cache.js`

| Константа | Путь |
| --- | --- |
| `PROFILES_DIR` | `app/cache-games/profiles` |
| `LIBRARY_DIR` | `app/cache-games/library` |
| `PLAYTIME_DIR` | `app/cache-games/playtime` |
| `CATALOG_DIR` | `app/cache-games/catalog` |
| `PRODUCT_MAPPING_PATH` | `app/cache-games/catalog/productmapping.json` |

| TTL-константа | Выражение | Значение |
| --- | --- | --- |
| `LIBRARY_TTL_MS` | `24 * 60 * 60 * 1000` | 86400000 ms (1 d) |
| `PLAYTIME_TTL_MS` | `24 * 60 * 60 * 1000` | 86400000 ms (1 d) |
| `CATALOG_TTL_MS` | `180 * 24 * 60 * 60 * 1000` | 15552000000 ms (180 d) |
| `PRODUCT_MAPPING_TTL_MS` | `7 * 24 * 60 * 60 * 1000` | 604800000 ms (7 d) |

### `server/games/epic-token-store.js`

| Константа | Путь |
| --- | --- |
| `TOKENS_DIR` | `app/cache-games/tokens` |

### `server/games/secondary/store.js`

| Константа | Путь |
| --- | --- |
| `CACHE_DIR` | `app/cache-games/secondary-details` |
| `BREAKER_PATH` | `app/cache-games/state/secondary-details-breaker.json` |
| `STATUS_PATH` | `app/cache-games/state/secondary-details-status.json` |
| `DEBUG_DIR` | `app/cache-games/debug/epic` |
| `CATALOG_PROBE_DIR` | `app/cache-games/catalog-probe` |
| `CATALOG_STATE_PATH` | `app/cache-games/state/catalog-state.json` |

| TTL-константа | Выражение | Значение |
| --- | --- | --- |
| `DEFAULT_TTL_MS` | `30 * DAY_MS` | 2592000000 ms (30 d) |
| `DEFAULT_NOT_FOUND_TTL_MS` | `30 * DAY_MS` | 2592000000 ms (30 d) |
| `DEFAULT_PROBE_TTL_MS` | `7 * DAY_MS` | 604800000 ms (7 d) |
| `DEFAULT_CATALOG_PROBE_TTL_MS` | `30 * DAY_MS` | 2592000000 ms (30 d) |

