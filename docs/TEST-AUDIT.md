# Аудит тест-файлов (P0 «страховочная сетка»)

Дата: 03.11.2026. Ревизия: `main` @ `fadf31c` (до коммитов P0).
Метод: каждый файл `test/*.test.js` прогнан отдельно
(`node --test --test-reporter=tap test/<file>`), число `test()` — количество
репортируемых подтестов, `assert` — статический подсчёт вызовов
`assert.*` без комментариев (верхняя оценка: ассерты в циклах считаются один раз).

Итог корпуса: **133 файлов**, **1080 тестов** (полный прогон
`npm test`: 1074 до P0 + 6 новых golden-тестов = 1080; 11 skip), **~7882 assert-вызовов**.
Слияние в этом раунде НЕ выполняется — только маршрут.

## Распределение по категориям

| Категория | Файлов | Тестов |
|---|---:|---:|
| Jobs | 35 | 221 |
| Stats | 24 | 207 |
| Матчинг | 23 | 207 |
| Парсеры | 16 | 189 |
| UI-поведение | 9 | 58 |
| Роуты/API | 8 | 53 |
| Кэш-бюджет-breaker | 7 | 43 |
| UI-структура | 5 | 67 |
| Ядро | 4 | 24 |
| Конфиг/секреты | 2 | 11 |

Категории из брифа (Парсеры / Матчинг / Кэш-бюджет-breaker / Jobs / Stats /
UI-поведение / UI-структура / Регрессионные однотестовые) дополнены тремя:
**Ядро** (`core-*`), **Конфиг/секреты** (`config-*`), **Роуты/API** (`*-routes`, `*-auth`)
— в исходном списке для них не было подходящей полки. Отдельная категория
«Регрессионные однотестовые» не понадобилась: такие файлы остались в своих
доменных категориях, а их полный список и вердикт «Слить в набор» — ниже.

## Полная таблица

| Файл | Категория | test() | assert | Вердикт |
|---|---|---:|---:|---|
| `books-ancient-bucket.test.js` | Stats | 4 | 51 | Держать |
| `books-author-identity.test.js` | Матчинг | 7 | 29 | Держать |
| `books-authors-bridge.test.js` | Матчинг | 8 | 50 | Держать |
| `books-book-identity.test.js` | Матчинг | 6 | 25 | Держать |
| `books-cache.test.js` | Кэш-бюджет-breaker | 5 | 17 | Держать |
| `books-collections.test.js` | Матчинг | 19 | 87 | Держать |
| `books-first-year.test.js` | Stats | 14 | 81 | Держать |
| `books-gbooks.test.js` | Парсеры | 12 | 63 | Держать |
| `books-hardcover-incremental.test.js` | Парсеры | 5 | 35 | Держать |
| `books-hardcover.test.js` | Парсеры | 10 | 75 | Держать |
| `books-import-activation.test.js` | Jobs | 2 | 11 | Слить в набор |
| `books-import-hardcover.test.js` | Jobs | 1 | 9 | Слить в набор |
| `books-import-two-phase.test.js` | Jobs | 5 | 45 | Держать |
| `books-import.test.js` | Jobs | 3 | 14 | Держать |
| `books-livelib-bootstrap.test.js` | Парсеры | 8 | 64 | Держать |
| `books-livelib-cookies.test.js` | Парсеры | 10 | 98 | Держать |
| `books-livelib-file-import.test.js` | Jobs | 4 | 94 | Держать |
| `books-livelib-file-manga.test.js` | Jobs | 6 | 53 | Держать |
| `books-livelib-file-resolve.test.js` | Матчинг | 10 | 70 | Держать |
| `books-livelib-file.test.js` | Jobs | 14 | 148 | Держать |
| `books-livelib.test.js` | Парсеры | 10 | 70 | Держать |
| `books-manga-flags.test.js` | Stats | 9 | 66 | Держать |
| `books-metadata-coverage.test.js` | Матчинг | 8 | 33 | Держать |
| `books-profiles.test.js` | Stats | 13 | 82 | Держать |
| `books-providers.test.js` | Парсеры | 21 | 131 | Разбить |
| `books-reading-now.test.js` | Stats | 5 | 58 | Держать |
| `books-refresh.test.js` | Jobs | 9 | 101 | Держать |
| `books-resolve-chain.test.js` | Матчинг | 10 | 77 | Держать |
| `books-resolve.test.js` | Матчинг | 8 | 40 | Держать |
| `books-scheduled-resolve.test.js` | Jobs | 7 | 51 | Держать |
| `books-series-blacklist.test.js` | Матчинг | 7 | 30 | Держать |
| `books-stats-manga.test.js` | Stats | 7 | 67 | Держать |
| `books-stats-profiles-scope.test.js` | Stats | 6 | 128 | Держать |
| `books-stats-series-manga.test.js` | Stats | 3 | 40 | Держать |
| `books-stats-status-filter.test.js` | Stats | 4 | 53 | Держать |
| `books-stats.test.js` | Stats | 5 | 65 | Держать |
| `books-ui-authors.test.js` | UI-структура | 3 | 19 | Переписать при U15 (структурные тесты) |
| `books-year-legacy.test.js` | Stats | 9 | 52 | Держать |
| `books-year-override.test.js` | Stats | 5 | 68 | Держать |
| `books-years-convergence.test.js` | Stats | 9 | 38 | Держать |
| `cache-invalidation.test.js` | Кэш-бюджет-breaker | 4 | 31 | Держать |
| `config-gbooks-key.test.js` | Конфиг/секреты | 5 | 5 | Держать |
| `config-hardcover-token.test.js` | Конфиг/секреты | 6 | 7 | Держать |
| `core-errors.test.js` | Ядро | 5 | 17 | Держать |
| `core-fs-store.test.js` | Ядро | 7 | 21 | Держать |
| `core-lock.test.js` | Ядро | 6 | 22 | Держать |
| `core-params.test.js` | Ядро | 6 | 20 | Держать |
| `enrich-retry.test.js` | Jobs | 1 | 6 | Слить в набор |
| `films-connections.test.js` | UI-поведение | 3 | 11 | Держать |
| `films-import-activation.test.js` | Jobs | 2 | 13 | Слить в набор |
| `films-stale-banner-removed.test.js` | UI-поведение | 5 | 28 | Держать |
| `games-auto-enrich.test.js` | Jobs | 3 | 53 | Держать |
| `games-b6-editions-base.test.js` | Stats | 19 | 137 | Держать |
| `games-cache-dir-nix.test.js` | Кэш-бюджет-breaker | 5 | 18 | Держать |
| `games-cache.test.js` | Кэш-бюджет-breaker | 7 | 36 | Держать |
| `games-details-heal.test.js` | Jobs | 5 | 43 | Держать |
| `games-editions.test.js` | Stats | 13 | 64 | Держать |
| `games-enrich-phases.test.js` | Jobs | 7 | 92 | Держать |
| `games-enrich-routes.test.js` | Роуты/API | 1 | 45 | Слить в набор |
| `games-enrich.test.js` | Jobs | 10 | 73 | Держать |
| `games-epic-auth.test.js` | Роуты/API | 10 | 54 | Держать |
| `games-epic-catalog-trace.test.js` | Парсеры | 10 | 90 | Держать |
| `games-epic-client.test.js` | Парсеры | 22 | 102 | Разбить |
| `games-epic-import.test.js` | Jobs | 8 | 100 | Держать |
| `games-epic-routes.test.js` | Роуты/API | 5 | 80 | Держать |
| `games-epic-token-store.test.js` | Кэш-бюджет-breaker | 7 | 28 | Держать |
| `games-franchise-aggregate.test.js` | Stats | 7 | 62 | Держать |
| `games-franchise-jobs.test.js` | Jobs | 5 | 36 | Держать |
| `games-franchise-routes.test.js` | Роуты/API | 4 | 51 | Держать |
| `games-franchise-wikidata.test.js` | Матчинг | 8 | 81 | Держать |
| `games-gog-auth.test.js` | Роуты/API | 14 | 96 | Держать |
| `games-gog-cache.test.js` | Кэш-бюджет-breaker | 8 | 31 | Держать |
| `games-gog-client.test.js` | Парсеры | 17 | 86 | Держать |
| `games-gog-import.test.js` | Jobs | 11 | 37 | Держать |
| `games-gog-playtime.test.js` | Jobs | 9 | 50 | Держать |
| `games-gog-routes.test.js` | Роуты/API | 10 | 57 | Держать |
| `games-gog-stats.test.js` | Stats | 7 | 44 | Держать |
| `games-gog-ui.test.js` | UI-поведение | 8 | 43 | Держать |
| `games-gog-union.test.js` | Матчинг | 7 | 38 | Держать |
| `games-gzip.test.js` | Кэш-бюджет-breaker | 7 | 42 | Держать |
| `games-import-activation.test.js` | Jobs | 1 | 9 | Слить в набор |
| `games-import-lag.test.js` | Jobs | 1 | 6 | Слить в набор |
| `games-import-mismatch.test.js` | Jobs | 2 | 13 | Слить в набор |
| `games-import-targetkey.test.js` | Jobs | 1 | 8 | Слить в набор |
| `games-import-vanity-activation.test.js` | Jobs | 1 | 10 | Слить в набор |
| `games-import.test.js` | Jobs | 9 | 67 | Держать |
| `games-job-stale-resume.test.js` | Jobs | 2 | 8 | Слить в набор |
| `games-m6-integration.test.js` | Stats | 13 | 99 | Разбить (мега-тест) |
| `games-m7-art.test.js` | Парсеры | 10 | 18 | Держать |
| `games-minhours.test.js` | Stats | 7 | 107 | Держать |
| `games-personnel-aggregate.test.js` | Stats | 13 | 136 | Держать |
| `games-personnel-identity.test.js` | Матчинг | 7 | 36 | Держать |
| `games-personnel-kick.test.js` | Jobs | 7 | 64 | Держать |
| `games-personnel-moby.test.js` | Матчинг | 7 | 53 | Держать |
| `games-personnel-roles.test.js` | Матчинг | 5 | 47 | Держать |
| `games-personnel-routes.test.js` | Роуты/API | 5 | 71 | Держать |
| `games-personnel-wikidata.test.js` | Матчинг | 10 | 55 | Держать |
| `games-profile-switch.test.js` | Jobs | 1 | 17 | Слить в набор |
| `games-profiles-label.test.js` | Jobs | 1 | 10 | Слить в набор |
| `games-profiles-reload.test.js` | Jobs | 1 | 7 | Слить в набор |
| `games-reviews.test.js` | Парсеры | 9 | 44 | Держать |
| `games-routes.test.js` | Роуты/API | 4 | 111 | Держать |
| `games-secondary-catalog-heal.test.js` | Jobs | 7 | 57 | Держать |
| `games-secondary-cover.test.js` | Матчинг | 2 | 14 | Слить в набор |
| `games-secondary-details-status.test.js` | Jobs | 18 | 114 | Держать |
| `games-secondary-details.test.js` | Jobs | 50 | 252 | Разбить (мега-тест) |
| `games-secondary-identity.test.js` | Матчинг | 10 | 32 | Держать |
| `games-secondary-kick-partial.test.js` | Jobs | 6 | 40 | Держать |
| `games-secondary-union.test.js` | Матчинг | 26 | 149 | Разбить (мега-тест) |
| `games-secondary-wd-year.test.js` | Матчинг | 22 | 80 | Разбить |
| `games-secondary-works-dom.test.js` | Матчинг | 1 | 30 | Слить в набор |
| `games-secondary-works.test.js` | Матчинг | 11 | 87 | Держать |
| `games-spy.test.js` | Парсеры | 8 | 51 | Держать |
| `games-stats-m2.test.js` | Stats | 10 | 96 | Держать |
| `games-stats-m4.test.js` | Stats | 12 | 53 | Держать |
| `games-stats.test.js` | Stats | 7 | 99 | Держать |
| `games-steam-art.test.js` | Парсеры | 13 | 52 | Держать |
| `games-steam.test.js` | Парсеры | 16 | 80 | Держать |
| `games-store.test.js` | Парсеры | 8 | 86 | Держать |
| `games-ui-m2.test.js` | UI-структура | 24 | 306 | Разбить |
| `games-ui-m4-dom.test.js` | UI-поведение | 1 | 18 | Слить в набор |
| `games-ui-m4.test.js` | UI-структура | 13 | 148 | Переписать при U15 (структурные тесты) |
| `games-ui-parity.test.js` | UI-поведение | 19 | 187 | Держать |
| `games-ui-sources-layout.test.js` | UI-структура | 2 | 30 | Слить в набор |
| `games-ui-u5.test.js` | UI-поведение | 4 | 65 | Держать |
| `games-ui-u6-strip.test.js` | UI-поведение | 1 | 15 | Слить в набор |
| `games-ui-u6.test.js` | UI-поведение | 15 | 102 | Держать |
| `games-ui.test.js` | UI-структура | 25 | 214 | Разбить |
| `games-years-narrowed-click.test.js` | UI-поведение | 2 | 15 | Слить в набор |
| `golden.test.js` | Stats | 6 | 17 | Держать |
| `matcher.test.js` | Матчинг | 6 | 21 | Держать |
| `mcu.test.js` | Матчинг | 2 | 18 | Слить в набор |
| `rematch.test.js` | Jobs | 1 | 20 | Слить в набор |

## Списки для следующих фаз

### 1–2 теста на файл (22 файлов; из них 14 с одним тестом и 8 с двумя)

План говорил «39 файлов» — фактически **22**: после раундов
M6/M7 и книжного U-цикла часть файлов выросла, часть новых появилась уже
с 3+ тестами. Слияние — отдельная фаза после зелёных golden-снимков.

- `books-import-activation.test.js` — 2 test(), 11 assert
- `books-import-hardcover.test.js` — 1 test(), 9 assert
- `enrich-retry.test.js` — 1 test(), 6 assert
- `films-import-activation.test.js` — 2 test(), 13 assert
- `games-enrich-routes.test.js` — 1 test(), 45 assert
- `games-import-activation.test.js` — 1 test(), 9 assert
- `games-import-lag.test.js` — 1 test(), 6 assert
- `games-import-mismatch.test.js` — 2 test(), 13 assert
- `games-import-targetkey.test.js` — 1 test(), 8 assert
- `games-import-vanity-activation.test.js` — 1 test(), 10 assert
- `games-job-stale-resume.test.js` — 2 test(), 8 assert
- `games-profile-switch.test.js` — 1 test(), 17 assert
- `games-profiles-label.test.js` — 1 test(), 10 assert
- `games-profiles-reload.test.js` — 1 test(), 7 assert
- `games-secondary-cover.test.js` — 2 test(), 14 assert
- `games-secondary-works-dom.test.js` — 1 test(), 30 assert
- `games-ui-m4-dom.test.js` — 1 test(), 18 assert
- `games-ui-sources-layout.test.js` — 2 test(), 30 assert
- `games-ui-u6-strip.test.js` — 1 test(), 15 assert
- `games-years-narrowed-click.test.js` — 2 test(), 15 assert
- `mcu.test.js` — 2 test(), 18 assert
- `rematch.test.js` — 1 test(), 20 assert

### Мега-тесты (3)

- `games-m6-integration.test.js` — 13 test(), 99 assert: один файл держит целый сценарий (импорт → кэш → payload/UI). Разбивать по слоям: парсер / кэш / payload / рендер.
- `games-secondary-details.test.js` — 50 test(), 252 assert: один файл держит целый сценарий (импорт → кэш → payload/UI). Разбивать по слоям: парсер / кэш / payload / рендер.
- `games-secondary-union.test.js` — 26 test(), 149 assert: один файл держит целый сценарий (импорт → кэш → payload/UI). Разбивать по слоям: парсер / кэш / payload / рендер.

### Структурные проверки `index.html`

Точная формулировка `index.html carries`: **3 файла, 4 теста**
(`games-ui-m4`, `games-ui`, `games-ui-m2`). План говорил про 6 — фактически 4.

Шире, любое упоминание `index.html` в тесте: **13 файлов**
(`books-reading-now`, `books-refresh`, `books-ui-authors`, `films-connections`, `films-stale-banner-removed`, `games-gog-ui`, `games-m6-integration`, `games-secondary-works`, `games-ui-m2`, `games-ui-m4`, `games-ui-parity`, `games-ui-sources-layout`, `games-ui`).

Вердикт: эти проверки ломаются от любой перестановки разметки и не проверяют
поведение — переписать при U15 на data-атрибуты/роли, а не на порядок узлов.

### Русские подписи в assert

**44 файлов** содержат кириллицу в сообщении/ожидаемом литерале
`assert` (в основном это реальные подписи payload'а — «Мультфильмы», «Прочитано»,
имена жанров). Это не проблема сама по себе, но при унификации текстов UI
такие ассерты надо менять вместе с контрактом, а не молча.

- `test/books-ancient-bucket.test.js`
- `test/books-author-identity.test.js`
- `test/books-authors-bridge.test.js`
- `test/books-collections.test.js`
- `test/books-first-year.test.js`
- `test/books-livelib-file-manga.test.js`
- `test/books-livelib-file-resolve.test.js`
- `test/books-livelib-file.test.js`
- `test/books-livelib.test.js`
- `test/books-profiles.test.js`
- `test/books-providers.test.js`
- `test/books-reading-now.test.js`
- `test/books-refresh.test.js`
- `test/books-resolve-chain.test.js`
- `test/books-resolve.test.js`
- `test/books-series-blacklist.test.js`
- `test/books-stats.test.js`
- `test/books-ui-authors.test.js`
- `test/films-connections.test.js`
- `test/films-stale-banner-removed.test.js`
- `test/games-epic-auth.test.js`
- `test/games-franchise-aggregate.test.js`
- `test/games-franchise-routes.test.js`
- `test/games-franchise-wikidata.test.js`
- `test/games-gog-ui.test.js`
- `test/games-m6-integration.test.js`
- `test/games-personnel-kick.test.js`
- `test/games-personnel-roles.test.js`
- `test/games-personnel-routes.test.js`
- `test/games-personnel-wikidata.test.js`
- `test/games-profiles-label.test.js`
- `test/games-secondary-cover.test.js`
- `test/games-secondary-works.test.js`
- `test/games-ui-m2.test.js`
- `test/games-ui-m4-dom.test.js`
- `test/games-ui-m4.test.js`
- `test/games-ui-parity.test.js`
- `test/games-ui-sources-layout.test.js`
- `test/games-ui-u5.test.js`
- `test/games-ui-u6-strip.test.js`
- `test/games-ui-u6.test.js`
- `test/games-ui.test.js`
- `test/games-years-narrowed-click.test.js`
- `test/mcu.test.js`

## Рекомендуемый маршрут

1. **Сначала** зелёные golden-снимки (`test/golden.test.js`) — они фиксируют
   контракт трёх payload'ов и ловят смысловые регрессии при любом рефакторинге.
2. Слить 1–2-тестовые файлы в наборы по домену (books/games/films), сохранив
   имена тестов: слияние не должно менять отчёт о падении.
3. Разбить мега-тесты по слоям (парсер → кэш → payload/UI), каждый слой —
   отдельный файл с общим seed-модулем.
4. UI-структурные проверки переписать на семантические селекторы в рамках U15;
   до этого их падение при перестановке разметки — ожидаемо.
5. Только после 1–4 трогать `server/stats.js`, `server/books/stats.js`,
   `server/games/stats.js` — golden остаётся неизменным.

## P8: UI-структура переписана в один контракт оболочки (03.11.2026)

Сделано в P8 (`test/shell.test.js`, U15):

- четыре проверки `index.html carries …` (`games-ui.test.js` — 1,
  `games-ui-m2.test.js` — 2, `games-ui-m4.test.js` — 1) и две `layout: …`
  (`games-ui-m4.test.js`, `games-ui-parity.test.js`) удалены; их содержимое
  переехало в `shell.test.js` как один контракт: топбар, профиль-чипы, карточки
  источников (`book-source-card`), панель журнала/прогресса, панель управления и
  монтирование виджетов дашборда игр (id-список сохранён, порядок — нет);
- новые тесты `shell.test.js` проверяют дескрипторы `{ domain, title,
  sources[], journal{} }` всех трёх вкладок (ровно один `journal` на владельца) и
  рендереры `core/shell.js` (чипы row/flat, создание/адопция карточки, шапка
  экрана «Подключения», строки прогресса);
- поведенческие DOM-тесты доменов (переключение профилей, импорт, GOG/Epic,
  прогресс) не менялись.
