<!-- GENERATED FILE — do not edit by hand. Regenerate: node scripts/gen-contracts.js limits -->
# Politeness limits per source

Единственная нормативная таблица пауз/бюджетов/breaker/TTL. Сгенерирована из `server/core/sources.js` (декларативная таблица `SOURCES`); runtime читает те же значения через `pauseMs`/`timeoutMs`/`budgetLimit`/`breakerMs`/`ttlMs`. Если число в `AGENTS.md` §1 расходится с этой таблицей — правится `core/sources.js`, а не документ и не AGENTS.

## Конвенция

- `0` = «выключено»: pause 0 — без паузы, budget 0 — ноль запросов, TTL 0 — всегда stale, breaker 0 — без кулдауна, timeout 0 — без дедлайна.
- Незаданная/пустая переменная = значение из таблицы.
- Известное исключение: `GAMES_FRANCHISE_BUDGET=0` — `franchise.js` применяет `Math.max(1, …)`, то есть всё равно задаёт один вопрос (сохранено намеренно).
- TTL у игровых источников местами ещё принадлежит runtime-модулю (`game-cache.js`, `secondary-details.js`); таблица зеркалит константы.

## Таблица источников

| Источник | Host | Pause | Timeout | Бюджет/прогон | Breaker | TTL | Env-ручки |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `epic` | `account-public-service-prod03.ol.epicgames.com` | 300 ms | 20000 ms (20 s) | — | 1800000 ms (30 min) | — | pause: `GAMES_EPIC_PAUSE_MS`<br>timeout: `GAMES_EPIC_TIMEOUT_MS`<br>breaker: `GAMES_EPIC_BREAKER_MS` |
| `gog` | `api.gog.com` | 400 ms | 20000 ms (20 s) | `GAMES_GOG_BUDGET` = 200 | 1800000 ms (30 min) | — | pause: `GAMES_GOG_LIBRARY_PAUSE_MS`<br>timeout: `GAMES_GOG_TIMEOUT_MS`<br>breaker: `GAMES_GOG_BREAKER_MS` |
| `googlebooks` | `www.googleapis.com` | 400 ms | 15000 ms (15 s) | `BOOKS_GB_BUDGET` = 300 | 1800000 ms (30 min) | — | — |
| `hardcover` | `api.hardcover.app` | 1100 ms | 30000 ms (30 s) | — | — | — | — |
| `kinopoisk` | `www.kinopoisk.ru` | 1500 ms…2500 ms | 30000 ms (30 s) | — | — | — | — |
| `litres` | `api.litres.ru` | 2000 ms (2 s) | 15000 ms (15 s) | `BOOKS_LITRES_BUDGET` = 200 | 1800000 ms (30 min) | — | — |
| `livelib` | `www.livelib.ru` | 1500 ms…2500 ms | 45000 ms (45 s) | `BOOKS_LIVELIB_CARD_BUDGET` = 300 | 1800000 ms (30 min) | — | — |
| `moby` | `api.mobygames.com` | 1100 ms | 30000 ms (30 s) | `GAMES_MOBY_BUDGET` = 100 | 1800000 ms (30 min) | — | pause: `GAMES_MOBY_PAUSE_MS` |
| `openlibrary` | `openlibrary.org` | 250 ms | 15000 ms (15 s) | — | — | — | — |
| `secondary` | `api.gog.com` | 2000 ms (2 s) | 20000 ms (20 s) | `GAMES_SECONDARY_BUDGET` = 200 | 1800000 ms (30 min) | 2592000000 ms (30 d) | pause: `GAMES_SECONDARY_PAUSE_MS`<br>timeout: `GAMES_SECONDARY_TIMEOUT_MS`<br>breaker: `GAMES_SECONDARY_BREAKER_MS`<br>ttl: `GAMES_SECONDARY_TTL_MS` |
| `steam` | `api.steampowered.com` | 0 | 20000 ms (20 s) | — | 1800000 ms (30 min) | — | timeout: `GAMES_STEAM_TIMEOUT_MS`<br>breaker: `GAMES_STEAM_BREAKER_MS` |
| `steamCommunity` | `steamcommunity.com` | 2000 ms (2 s) | 20000 ms (20 s) | — | 1800000 ms (30 min) | — | pause: `GAMES_STEAM_COMMUNITY_PAUSE_MS`<br>timeout: `GAMES_STEAM_TIMEOUT_MS`<br>breaker: `GAMES_STEAM_BREAKER_MS` |
| `steamReviews` | `api.steampowered.com` | 1700 ms | 20000 ms (20 s) | `GAMES_REVIEWS_BUDGET` = 340 | 1800000 ms (30 min) | 2592000000 ms (30 d) | pause: `GAMES_REVIEWS_PAUSE_MS`<br>timeout: `GAMES_REVIEWS_TIMEOUT_MS`<br>breaker: `GAMES_REVIEWS_BREAKER_MS`<br>ttl: `GAMES_REVIEWS_TTL_MS` |
| `steamSpy` | `steamspy.com` | 1100 ms | 20000 ms (20 s) | `GAMES_SPY_BUDGET` = 340 | 1800000 ms (30 min) | 2592000000 ms (30 d) | pause: `GAMES_SPY_PAUSE_MS`<br>timeout: `GAMES_SPY_TIMEOUT_MS`<br>breaker: `GAMES_SPY_BREAKER_MS`<br>ttl: `GAMES_SPY_TTL_MS` |
| `steamStore` | `store.steampowered.com` | 1700 ms | 20000 ms (20 s) | `GAMES_STORE_BUDGET` = 340 | 1800000 ms (30 min) | 15552000000 ms (180 d) | pause: `GAMES_STORE_PAUSE_MS`<br>timeout: `GAMES_STEAM_TIMEOUT_MS`<br>breaker: `GAMES_STORE_BREAKER_MS`<br>ttl: `GAMES_STORE_TTL_MS` |
| `tmdb` | `api.themoviedb.org` | 0 | 20000 ms (20 s) | — | — | — | — |
| `wdqs` | `query.wikidata.org` | 1200 ms | 120000 ms (2 min) | — | — | — | — |
| `wikidataFranchise` | `query.wikidata.org` | 1100 ms | 60000 ms (1 min) | `GAMES_FRANCHISE_BUDGET` = 450 | 1800000 ms (30 min) | 7776000000 ms (90 d) | ttl: `GAMES_FRANCHISE_TTL_DAYS` |
| `wikidataLabels` | `www.wikidata.org` | 0 | 120000 ms (2 min) | — | — | — | — |
| `wikidataPersonnel` | `query.wikidata.org` | 1100 ms | 60000 ms (1 min) | — | 1800000 ms (30 min) | — | — |

## Дополнительные ручки из таблицы

Поля `SOURCES`, не входящие в стандартный набор (concurrency, batchSize, maxPerMinute, варианты паузы и т. п.). Это тоже контракт: их читают модули напрямую из таблицы.

| Источник | Поле | Значение |
| --- | --- | --- |
| `hardcover` | `maxPerMinute` | 55 |
| `hardcover` | `maxTransportAttempts` | 3 |
| `hardcover` | `minIntervalMs` | 1100 |
| `hardcover` | `windowMs` | 60000 |
| `kinopoisk` | `maxRedirects` | 10 |
| `livelib` | `cardPauseMs` | 2000 |
| `livelib` | `maxRedirects` | 5 |
| `secondary` | `epicPauseMs` | 1500 |
| `tmdb` | `concurrency` | 12 |
| `tmdb` | `rateLimitRetries` | 5 |
| `tmdb` | `retryDelaysMs` | 1000, 2000, 4000, 8000 |
| `wdqs` | `baseBackoffMs` | 2000 |
| `wdqs` | `batchSize` | 450 |
| `wdqs` | `maxAttempts` | 8 |
| `wdqs` | `maxBackoffMs` | 60000 |
| `wdqs` | `outageGapMs` | 60000 |
| `wikidataFranchise` | `batchSize` | 450 |
| `wikidataLabels` | `batchSize` | 50 |
| `wikidataLabels` | `maxAttempts` | 3 |
| `wikidataPersonnel` | `batchSize` | 450 |
| `wikidataPersonnel` | `cooldownMs` | 1800000 |
| `wikidataPersonnel` | `maxFailures` | 3 |
| `wikidataPersonnel` | `minOutageGapMs` | 60000 |

## Особые лимиты, не выводимые из таблицы

Числа, которые живут в коде/эмпирике и не являются полем `SOURCES` (суточные квоты, процессные правила, счётчики запросов на книгу). Источник указан точно; при изменении кода строка правится здесь же.

| Источник | Лимит | Происхождение | Комментарий |
| --- | --- | --- | --- |
| `hardcover` | сервер: 60 запросов/60 s, burst 10; сутки: 5000 | server/books/hardcover.js:12 (RateLimit-Policy из ответа API) | локальный гейт — `maxPerMinute: 55` в таблице; суточный лимит кодом не проверяется |
| `googlebooks` | free-tier ~1000 запросов/сутки (с ключом), без ключа — per-IP квота | AGENTS.md §1; server/books/providers/googlebooks.js:13 | числа в коде нет; бюджет прогона — `BOOKS_GB_BUDGET` (таблица) |
| `litres` | 2 запроса на книгу | AGENTS.md §1; server/books/providers/litres.js:12 | бюджет `BOOKS_LITRES_BUDGET` считает книги, не запросы |
| `livelib` | живой скрап-спайк: ≤4 запроса; пагинация — только HTML-страницы | AGENTS.md §1 (процессное правило, не код) | штатный путь — загрузка файла `livelib-backup`; скрап — аварийный |
| `kinopoisk` | живой скрап — только штатный bootstrapped flow (импорт профиля владельцем) | AGENTS.md §1 (процессное правило, не код) | для тестов/регрессий live-запросы запрещены |
| `steamCommunity` | 1 запрос на игру; числовой лимит не документирован | AGENTS.md §1 (эмпирика 01.11.2026) | пауза 2000 ms и breaker 30 min — в таблице |
| `steam` | `GAMES_STEAM_BUDGET` — план, в коде бюджета нет | AGENTS.md §1 | в таблице у `steam` нет `budgetEnv` — это честно отражено |
| `secondary` | негативный кэш: 30 d (реальный 404/empty), 7 d (угаданный slug) | server/games/secondary/store.js (DEFAULT_NOT_FOUND_TTL_MS / DEFAULT_PROBE_TTL_MS) | отдельные env-ручки: `GAMES_SECONDARY_NOT_FOUND_TTL_MS`, `GAMES_SECONDARY_PROBE_TTL_MS` |
| `books-resolve` | промах «ничего не найдено» помнится 90 дней (`--recheck-days`) | server/books/scheduled-resolve.js:55 (DEFAULT_RECHECK_DAYS) | бюджет/breaker/сеть не кэшируются |

