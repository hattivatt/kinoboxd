# AGENTS — kinoboxd: архитектура и правила

**Этот файл — единственный документ проекта.** Здесь и текущая архитектура сервиса, и правила, по которым работают агенты-исполнители. Других архитектурных/плановых документов нет: backlog, история решений и остатки — в §11, эмпирика по источникам — в §10, числа лимитов — в `contracts/limits.md` (генерируется).

**Раскладка.** Git-репозиторий — корень проекта. В нём лежит всё, что нужно для разработки и деплоя: `server/`, `public/`, `test/`, `scripts/`, `contracts/`, `spec/`, `nix/` (сборка и NixOS-модуль), `devenv.*` (dev-shell), `flake.nix`. Вне git остаётся только то, что генерируется или является личным: `node_modules/`, `cache*/`, `config/*-token`, `.devenv/`, `result`, `state/`, а также личный site-конфиг `kinoboxd.nix` (в `~/.nixos`). Имя `AGENTS.md` выбрано как конвенция, которую автоматически читают agent-тулзы.

**Статус:** v3.3, 12.11.2026, `main` @ `e2b1907` (тэг `v1.1.0` @ `7b5597d`, пин на него). v3.3: закрыт backlog §11 (все job-«running» в `core/jobs`, округления через `core/stats`, per-film blacklist таксономии, books-миграции юнитами, три распила модулей). v3.2: релизы на тэгах `vX.Y.Z` и semver, pin-блок в отчёте (§12.1, §13.1, §13.3). v3.1: dev/deploy-файлы внутри репозитория. Заменяет `АРХИТЕКТУРА.md`, `ПЛАНЫ.md` и `РЕФАКТОРИНГ-ПЛАН.md` (их содержимое сведено сюда, сами файлы удалены; история — в git).

---

## 1. Проект и стек

Сервис собирает личную статистику из внешних профилей: Кинопоиск и Letterboxd (фильмы), LiveLib и Hardcover (книги), Steam, GOG и Epic (игры). Данные обогащаются метадатой из публичных источников, кэшируются на диске и отдаются одностраничному интерфейсу.

- Node.js 24, Express 4, CommonJS, без сборщика и фреймворка на фронте.
- Хранение — файловый кэш в трёх независимых каталогах; базы данных нет.
- Деплой — Nix (`buildNpmPackage`), systemd-юниты и таймеры, секреты через sops.
- Runtime-зависимости ровно четыре: `express`, `cheerio`, `multer`, `adm-zip`.

---

## 2. Карта кода

```
<repo root>
  server/
    index.js              сборка приложения: gzip, auth, mount роутеров, /api/health, SPA, ошибки (~150 строк)
    core/                 общий слой (§3)
      jobs.js  jobs/      реестр заданий + распил (registry, job, lifecycle, cooldown)
      http.js  source-client.js  budget.js  breaker.js  sources.js
      fs-store.js  lock.js  env.js  params.js  errors.js  secrets.js  profile.js  stats.js
    films/routes.js       API фильмов
    stats.js  stats/      оркестратор payload'а фильмов + 9 секций
    cache.js  kp.js  tmdb.js  wikidata.js  upload.js
    taxonomy.js           движок правил (классификация, бакеты, агрегация)
    taxonomy-defs.js      данные правил: keywords, origins, periods, directors, Q-ids
    taxonomy-blacklist.js per-film снятие категорий из `cache/flags/`
    enrich.js  backfill.js  rematch.js  compare.js  attachment.js  mcu.js
    books/                routes, book-cache, import, resolve + resolve-stages/,
                          providers/ (hardcover, litres, googlebooks, openlibrary, livelib-card),
                          stats.js + stats/{,}, years/authors/manga backfills, scheduled-resolve
    games/                routes* + endpoints/{,epic/}, import, enrich, secondary/ (identity, cache,
                          bridge, title-genres, union, epic, enrich, details-*), sources/{gog,epic,*},
                          personnel/ (identity, group, build, enrich, jobs, wikidata, moby),
                          franchise/ + franchise.js, stats/ (18 секций), gog-import-stages/,
                          art/ (store, browse, resolve, proxy), editions/ (normalize, match,
                          index-build, store), reviews
    gzip.js  auth.js  config.js
  public/
    index.html            одна оболочка + три панели вкладок
    core.css films.css books.css games.css
    js/core/              charts, date, dom, poll, profile-store, progress, shell, streaks
    js/charts/            donut, timeline, year-bars, axis, year-data (charts.js — баррель)
    js/games/             labels, sources, secondary-card, import-flow, normalize/*
    js/                   main, widgets, books*, games*, films: доменные контроллеры и виджеты
  contracts/              api.md env.md limits.md cache.md — генерируются, руками не правятся
  scripts/                gen-contracts.js, census.js, smoke{,-seed,-preload}.sh
  test/                   62 файла: 13 доменных сьютов + 49 одиночных, helpers/, golden/
  nix/
    package.nix           единственный рецепт сборки (пин + 5 лаунчеров + prepare_state)
    module.nix            NixOS-модуль services.kinoboxd
  flake.nix               обёртка: callPackage nix/package.nix + devShell + checks
  devenv.nix  devenv.lock dev-shell (node 24, git, jq, curl, rg, nixfmt)
  AGENTS.md               этот документ
```

Направление зависимостей: домен знает `server/core/`, но не другие домены; `core/` не знает слов `film`, `book`, `game`. Общие модули без доменной семантики (`auth`, `config`, `gzip`) лежат в корне `server/`.

---

## 3. Ядро `server/core/`

Каждый модуль — одна сквозная подсистема с одним контрактом; шапка модуля описывает контракт.

| Модуль | Назначение |
|---|---|
| `fs-store.js` | атомарная запись JSON (tmp + rename), чтение с fingerprint `mtimeNs:size:ino`, секреты `0600`, `safeKey` |
| `lock.js` | межпроцессный файловый lock (stale по мёртвому pid/возрасту) |
| `env.js` | числовые env-ручки: `0` = выключено, `undefined` = значение из `sources.js` |
| `http.js` | единственный HTTP-транспорт: timeout, retry/backoff, `Retry-After`, UA, инъекции `fetchImpl`/`sleep`, `nodeRequest` |
| `source-client.js` | один гейт источника (`createSourceGate`): breaker + пауза + маппинг транспортной ошибки |
| `budget.js` | счётчик бюджета прогона: `take()` = «не спросили», а не «не нашли» |
| `breaker.js` | breaker на источник: memory (книги) и persisted (игры) |
| `sources.js` | декларативная таблица источников: пауза, timeout, бюджет, breaker, TTL, env-ручки |
| `jobs.js` + `jobs/` | реестр заданий: id, стадии, прогресс, cooldown, single-flight, `status()`, `clear()` |
| `stats.js` | числовая математика: `round(value, digits, mode)` (`plain`/`finite`/`numeric`), `mean`, `dayNumber`, `computeStreaks` |
| `errors.js` | `HttpError`, `fromStatus`, `mapDomainError(err, profile)`, `respondError`, `errorMiddleware`; тело `{ error, code }` |
| `params.js` | строгий разбор query: `assertOnlyParams`, `parseBool/Int/Enum/MinHours/Force` |
| `secrets.js` | `env → dev-файл → значение`, источник без значения, маска |
| `profile.js` | реестр владельцев: `registerDomainProfiles`, `listOwners`, `resolveOwnerOrThrow` |

**Инварианты ядра:**

1. **`0` = выключено.** Пауза `0` — без паузы; бюджет `0` — ноль запросов; TTL `0` — всегда stale; breaker `0` — без кулдауна; timeout `0` — без дедлайна. Незаданная переменная = значение из `sources.js`. Известное исключение — `GAMES_FRANCHISE_BUDGET=0` (`Math.max(1, …)`, намеренно).
2. **Один транспорт, один бюджет, один breaker, один гейт.** Не заводить второй HTTP-клиент, второй счётчик или локальную копию обвязки `breaker+pause`.
3. **Ядро не знает доменов.** Обратная зависимость запрещена; домен регистрирует себя сам.
4. **Публичный API модуля не меняется при распиле.** Перед рефакторингом снимается `Object.keys(require(module))`, после — сверяется; фасады-заглушки не оставляются (после распила импортёры переводятся на реальный модуль, файл-заглушка удаляется).
5. **Пороги размеров — машинные.** `npm run census` + `test/census-thresholds.test.js`: функция > 300 строк и модуль > 800 строк обязаны быть в белом списке, список только сокращается. Плюс ратчеты: копии хелперов, мёртвые модули (0 импортёров), дубли тестовых портов.

---

## 4. Кэш, state и схемы

### 4.1. Три независимых namespace

| Домен | Корень | Переменная | State |
|---|---|---|---|
| Фильмы | `cache/` | `KINOBOXD_CACHE_DIR` | — |
| Книги | `cache-book/` | `KINOBOXD_CACHE_BOOK_DIR` | — |
| Игры | `cache-games/` | `KINOBOXD_CACHE_GAMES_DIR` | `state/games/` при `KINOBOXD_STATE_DIR` |

Полная раскладка по файлам — `contracts/cache.md` (генерируется). Кэши не пересекаются: `du`, бэкап и очистка раздельные.

### 4.2. Правила записи и чтения

- **Атомарная запись:** временный файл + `rename`; читатель никогда не видит половину документа.
- **Fingerprint-revalidation:** memory-кэш хранит `mtimeNs:size:ino`; перед отдачей делается один `stat()`, при изменении/удалении запись перечитывается. Живой сервер видит записи бэкфилла, rematch и resolve-таймера без рестарта.
- **`schemaVersion` штампуют сами домены** (`book-cache`, `games/game-cache`, `books/providers`, `resolve`). Общего стор-модуля нет: `core/store.js` был мёртвым и удалён 10.11.2026. Читатель обязан пережить документ без версии и не интерпретировать «будущую» версию (деградация в refetch безопаснее).
- **TTL принадлежит владельцу документа.** У книг/фильмов TTL задаёт домен, у игр — runtime-модуль; `contracts/limits.md` зеркалит константы. Ключевые игровые TTL: профиль 6 ч, библиотека 24 ч, достижения 24 ч, глобальные проценты 7 д, appdetails 180 д, арт-resolve 180 д (`none` — 30 д), кредиты/links 90 д, теги/отзывы/secondary 30 д.
- **Тесты двигают все корни и state в `/tmp`**; боевой кэш не мутируется никогда.

### 4.3. Негативный кэш

Отрицательный результат кэшируется только на настоящий «не найдено» и со своим TTL (книжный resolve — 30 д; игровой `not_found` — 30 д, «промах слага» — 7 д). Сеть и 5xx — `deferred`, а не «ничего не найдено»; бюджетный пропуск — тоже не вердикт (ключ идёт в `budgetPendingKeys`).

---

## 5. Домены

### 5.1. Фильмы

| Источник | Роль | Доступ |
|---|---|---|
| Кинопоиск | журнал: оценки, просмотры, даты | скрап по URL, только штатным импортом по действию пользователя |
| Letterboxd | архив того же владельца: diary-даты, пересмотры, watchlist | ZIP-выгрузка, прикрепляется к профилю КП |
| TMDB | canonical-метадата: название, год, жанры, страны, постеры, люди | Web API, `TMDB_API_TOKEN` / `config/tmdb-token` |
| Wikidata | внешние id, страны, франшизы, часть таксономии | WDQS, батчи |

Letterboxd — не отдельный профиль: он обогащает текущий профиль Кинопоиска (экран «Подключения»).

- Конвейер: `ZIP / профиль КП → uploadId → матчинг TMDB → enrich details → payload`.
- Матчинг: ключ `название|год` в `index.json`, значение — `tmdbId` или `{id, kind}` (`kind` различает фильм и сериал).
- Несматченное — в `unmatched` и `summary.unmatchedCount`; enrich пропускает уже собранные карточки.
- Payload (`GET /api/stats`): `summary`, `filmsIndex`, `genres`, `decades`, `years`, `countries`, `persons`, `franchises`, `collections`, `watchDays`/`calendar`, `timeline`, `runtimeHistogram`, `decadeRatings`, `rewatches`, `recentlyWatched`, `ratings`, `unmatched`, `streaks`, `meta`. Собирается в `server/stats/` (9 секций), `server/stats.js` — оркестратор.
- Таксономия: правила — данные + движок (`taxonomy-defs.js` / `taxonomy.js`), публичный API один модуль `server/taxonomy.js`. FP снимается персонально: `cache/flags/taxonomy-blacklist.json` (`{"version":1,"films":{"<slug>":["zombie"]}}`) убирает категорию/период только у этого slug, глобальное правило не трогается; неизвестный ключ попадает в `ignored`, битый файл и отсутствие файла значит «ничего не исключено» (`server/taxonomy-blacklist.js`).

### 5.2. Книги

**Модель:** профиль = владелец. Внутри — один primary-источник (LiveLib **или** Hardcover) и enricher'ы только того же владельца. LiveLib и Hardcover равнозначные primary: профиль создаётся из одного, второй обогащает метадатой, но не становится вторым журналом.

| Источник | Роль | Доступ |
|---|---|---|
| LiveLib | журнал: прочитанное, оценки, статусы, даты | `livelib-backup` (JSON/CSV) — штатный путь; RSC-скрап — legacy/аварийный, план Б по cookie |
| Hardcover | журнал или enricher: `user_books` + `user_book_reads` | GraphQL, `HARDCOVER_API_TOKEN` |
| Литрес | метадата: год написания, издательство | неофициальный Foundation API, бюджет и пауза |
| Google Books | метадата по ISBN/названию | free-tier с ключом `GB_API_KEY` |
| OpenLibrary | метадата, `first_publish_year` | публичный API |
| LiveLib-card | метадата карточки | публичная страница |
| Wikidata | P577 (первая публикация), авторы | WDQS |

- Импорт-файл: multipart, полка (read/wish), идемпотентность по ключу строки, манга-фильтр. Прогресс и результат — resolve-job.
- Hardcover: инкрементальный журнал; пустой дельта-импорт не запускает resolve.
- Resolve-цепочка (`books/resolve.js` + `resolve-stages/`): ISBN → название+автор → провайдеры по приоритету (Hardcover, Литрес, Google Books, OpenLibrary, LiveLib-card) → `details/{hcWorkId}.json` + `links.json`.
- Происхождение метадаты видно в `metadataSources`; `links/{livelibBookId}.json` хранит метод и score матча.
- Серии/сборники: эвристика в `segments.js`; ручные флаги манги — `flags/book-flags.json`; блэклист тэг-серий — `series-blacklist.js`.
- Миграции `authors` и `manga` теперь штатные юниты: `kinoboxd-backfill-manga` (очередь, таймер вкл., `booksMangaBackfillLimit`/`PauseMs`) и `kinoboxd-backfill-authors` (диагностика, таймер выкл., `--wikidata`; мост авторов и так default-on в `/api/books/stats`). Оба зовут один диспетчер-лаунчер `kinoboxd-books-migrate {manga|authors}`.
- Год работы: `manual > first > edition > unknown`; `manual` — в `year-overrides/`, `edition` — честный фоллбек с `yearSource: 'edition'`. Промах «никто не знает» кэшируется на 30 д.
- Payload (`GET /api/books/stats?profile=…`): `works`/`booksIndex`, `series`, `authors`, `decades`, `years`, `sources`, `coverage`, `timeline`, `summary`, `meta`. Собирается в `server/books/stats/`; `stats.js` — оркестратор. Блока `publishers` в payload **нет** (виджет удалён 04.11.2026, мёртвый серверный блок убран 10.11.2026).

### 5.3. Игры

| Источник | Роль | Доступ |
|---|---|---|
| Steam Web API | `GetOwnedGames`, `GetRecentlyPlayedGames`, часы, достижения | ключ `STEAM_API_KEY` (dev: `config/steam-token`); без ключа библиотека недоступна |
| Steam community XML | профиль, достижения с `unlockTimestamp`, глобальные проценты | без ключа, 1 запрос на игру |
| Steam Store `appdetails` | жанры, категории, разработчики, дата, metacritic, DLC | без ключа, `l=english` обязателен, recheck 180 д |
| `IStoreBrowseService` | asset-hash вертикальной капсулы | без ключа, 1 запрос/appid, свой breaker |
| SteamGridDB | опциональные community-обложки | ключ `STEAMGRIDDB_API_KEY`; без ключа молча пропускается |
| `IUserReviewsService` | оценка отзывов 1..9 | без ключа, только явная фаза `reviews` |
| SteamSpy | теги, owners, CCU | пауза/бюджет/кэш по таблице |
| Wikidata | кредиты, франшизы, годы, внешние id | WDQS, батчи по 450 |
| GOG | вторая библиотека владельца + store-метадата | OAuth, `api.gog.com/v2` |
| Epic | вторая библиотека + CMS-метадата | authorization code, entitlements/catalog |
| MobyGames (опц.) | artist/sound/voice | `MOBYGAMES_API_KEY`; без ключа — Wikidata-only |

- Импорт Steam: профиль → библиотека → достижения → авто-enrich `details+spy`; `reviews` только явной командой. Окно двух недель — 4-й запрос, вливается в снимок по `appid`, журнал не расширяет; `rtime_last_played: 0` = «Steam не раскрыл дату».
- Вторичные библиотеки: GOG/Epic объединяются в работы того же владельца по `workKey`; часы раздельно (`hoursBySource`) и никогда не суммируются со Steam. Строки `secondaryOnly` (`appid: null`) несут `workKey`.
- Идентичность: `editions.json` (canonical `appid → workKey`, ручные merge/split) + Wikidata-мост `P2725`/`P6278` → `P1733` + title-fallback (в `titleEntries`, отдельно от slug-моста; промах settled-кэшируется).
- Франшизы: Wikidata `P179` + онбучинг; ручные склейки в `overrides/`; для работ вне Steam — отдельный батч по QID и глобальный `links/secondary-franchise.json` (settled-TTL 90 д).
- Персоналии: Wikidata-кредиты по ролям, веса по часам/количеству игр; on-demand job с локом и cooldown. Студии работ вне Steam — из store-деталей с field-level провенансом (`epic-store`/`gog-store` важнее каталога; списки двух магазинов не сливаются).
- Арт: `resolveVerticalArt()` один раз на appid, порядок проб зависит от схемы `appdetails.header_image` (new schema — одна hashed-проба → `IStoreBrowseService` → SteamGridDB; legacy — hashed `capsule_image` → legacy library → store frontend → SteamGridDB); результат в `cache-games/art/resolved/<appid>.json`, `none` тоже settled (30 д).
- Lazy kick из `/stats`: `resolved < total || partial > 0 || healable > 0 || noSlug > 0`; `healable` = недостающий факт уже лежит в кэше моста (0 запросов).
- Payload (`GET /api/games/stats`): `profile`, `summary`, `gamesIndex`, жанры, годы/десятилетия, достижения, `personnel`, `franchises`, `secondaryWorks`, `meta`; арт-поля аддитивны (`verticalCapsule`, `verticalCapsuleKnown`, `iconFallbackUrl`). Собирается в `server/games/stats/` (18 секций). Фильтры: `includeFree` (1), `includeDlc` (0), `minHours` (-1 = все).

---

## 6. Владелец: инварианты

Главный инвариант сервиса: **профиль данных = один владелец**.

- У владельца ровно один primary-источник событий: Кинопоиск (фильмы), LiveLib **или** Hardcover (книги), Steam (игры).
- Enricher'ы допустимы только из источников того же владельца: Letterboxd обогащает профиль КП, Hardcover может обогащать LiveLib-профиль метадатой, GOG и Epic — вторые библиотеки того же Steam-владельца.
- Показатели двух владельцев не суммируются и не усредняются ни в payload, ни в UI.
- Сведение — только переключением активного профиля; мутирующие операции явно адресуют профиль.
- Контракт запроса строгий: неизвестный query-параметр — 400 `unexpected_parameter`; отсутствующий/неоднозначный профиль — 400 `profile_required` / `invalid_profile` / `unknown_profile` с перечнем доступных ключей. Тихий игнор запрещён.
- Канонический реестр профилей — серверный (`GET /api/{domain}/profiles` одной формы, `core/profile.js`). Браузер хранит метки и кэш статистики в **одном** IndexedDB-реестре `kinoboxd-registry` (`public/js/core/profile-store.js`; одноразовая миграция старых `kinoboxd`/`kinoboxd-books`).

---

## 7. Задания и вежливость

**Задания.** Каждый длительный процесс (импорт фильмов/книг/игр, обогащение, кредиты, франшизы, GOG/Epic, secondary-details) — реестр на `core/jobs.js` с `start*`/`getStatus`: id, стадии, прогресс, cooldown, single-flight. Клиент опрашивает статус, вкладку можно свернуть. Доменный фасад сохраняет прежние поля ответа байт-в-байт. Job-«running» вне `core/jobs` больше нет: `meta.secondaryDetails.running` читается из реестра (`isRunning(ownerKey)`).

**Вежливость.** Пауза перед запросом, бюджет на прогон, breaker на 403/429, TTL кэша, `Retry-After` при 429, сеть/5xx — deferred. **Нормативные числа — `contracts/limits.md`**; объявлять источник = править `server/core/sources.js` и перегенерировать контракт, а не документ.

**Локи.** Межпроцессные проходы (resolve книг, кредиты игр, бэкфиллы) защищены общим файловым lock; при занятом локе импорт ждёт `*_LOCK_WAIT_MS`, таймер выходит 0. Юниты бэкфилла конфликтуют друг с другом (`Conflicts=`), сервер продолжает работать.

**Деградация.** Частичные данные видны в payload: `metadataSources`, `yearSource`, `libraryPartial`, `deferred`, `secondaryDetails.running`, `coverage`/`pending`. Бюджетный пропуск — не вердикт.

---

## 8. Секреты

Порядок: env → dev-файл → prod sops. Значение никогда не логируется и не возвращается в API — только источник (`env`, `file`) и маска. Файлы `0600`, каталоги `0700`; значения не попадают в argv, `.drv`, `result`, `ps`.

| Секрет | Env | Dev-файл |
|---|---|---|
| TMDB | `TMDB_API_TOKEN` / `TMDB_READ_ACCESS_TOKEN` | `config/tmdb-token` |
| Hardcover | `HARDCOVER_API_TOKEN` / `HARDCOVER_READ_TOKEN` | `config/hardcover-token` |
| Google Books | `GB_API_KEY` / `BOOKS_GOOGLE_API_KEY` | `config/gbooks-token` |
| Steam | `STEAM_API_KEY` | `config/steam-token` |
| SteamGridDB (опц.) | `STEAMGRIDDB_API_KEY` | `config/steamgriddb-token` |
| GOG / Epic | `GOG_CLIENT_ID`/`SECRET`, `EPIC_CLIENT_ID`/`SECRET` (алиасы `GAMES_EPIC_*`) | OAuth-токены в `cache-games/tokens/`, `config/epic-client.json` |

Полный список имён и алиасов — `contracts/env.md` (генерируется из `process.env`-обращений, таблицы `sources.js` и массивов алиасов).

**Хост `thevalley` (текущая dev-машина).** Источник истины здесь — `gopass` (`~/.password-store`, gpg): API-ключи лежат в `apikeys/`, имя описывает токен: `apikeys/<service>-api-key`. Фактически в store сейчас: `apikeys/hardcover-api-key`, `apikeys/steam-api-key`; Google Books исторически в `apitokens/gbooks-api-key`, а TMDB — легаси-запись `Services/tmdb`. Новых путей не выдумывать: посмотреть `gopass ls --flat` и брать по имени. Значение попадает только в env, не в argv и не в файл (dev-файл `config/*-token` остаётся лишь фоллбеком):

```sh
TMDB_API_TOKEN="$(gopass show -o Services/tmdb)" npm start
GB_API_KEY="$(gopass show -o apitokens/gbooks-api-key)" npm start
```

При смене хоста правило то же, но путь спрашивать у владельца: имя store'а не считается известным по умолчанию.

---

## 9. Фронтенд

- `index.html` — одна оболочка: один топбар (три вкладки слева, действия справа), чипы профилей, экран «Подключения», экран импорта, прогресс, три панели дашбордов. Действия меняются по активной вкладке (`data-actions`); на boot/login/upload/enrich/compare топбар скрыт.
- Профили — один компонент чипов (`core/shell.js` → `renderProfileBar`); экраны «Подключения», карточки источников и строки прогресса рисуются из дескриптора вкладки (`js/shell-descriptors.js`, `core/shell.js`).
- Профильное хранилище — `core/profile-store.js`: один IndexedDB (`kinoboxd-registry` v1, store `entries`, ключ `domain:kind:id`, маркер `meta:schema`), memory-фоллбек в приватном режиме, `getActive`/`setActive` на домен. Старые БД читаются один раз и не удаляются.
- Дашборды доменные: сетка виджетов, графики и их расположение не унифицируются между вкладками.
- Графики — ручной SVG без зависимостей: примитивы в `js/core/charts.js`, рендереры в `js/charts/{donut,timeline,year-bars}.js` (+`axis`, `year-data`), `charts.js` — баррель. Таймлайн один на фильмы и книги (различия — параметры: ключи значений, падежи, aria, пустое состояние, вторая строка тултипа).
- Общие хелперы: `core/date.js` (даты и дни), `core/streaks.js` (два нормализатора — фильмовый и игровой, формы возврата разные), `core/dom.js` (DOM/форматирование/тултипы/тосты), `core/poll.js` (один поллер), `core/progress.js` (одна полоса).
- Обложки игр: сначала `verticalCapsule` из `cache-games/art/resolved/` (прокси `/steam-art/...`); при `verticalCapsuleKnown: false` legacy-цепочка не запускается; иначе — `library_600x900` по хэшу → legacy library → `header.jpg` → `capsule` → иконка → инициалы.
- CSS разложен по доменам: `core.css` (оболочка + общее), `films.css`, `books.css`, `games.css`.

---

## 10. Тесты, контракты, лимиты

**Тесты.** `npm test` = `node --test test/*.test.js`: **62 файла** (13 доменных сьютов + 49 одиночных), **1 380** тестов (1 369 pass, 11 skip), 0 fail, ~20 s.

- `test/helpers/port.js` — `portFor(slot)`; база из `KINOBOXD_TEST_PORT_BASE` (по умолчанию 6000). Диапазон **9900–10999 не использовать**: там WHATWG-«bad ports» (10080 и др.), `fetch` их отвергает. Две полные сюиты можно гонять параллельно разными базами — это единственный способ не получить ложный `EADDRINUSE`.
- `test/helpers/env.js` — `makeTmpCache`, `tmpDir`, `resetMutableState`, `cleanupTmpDirs`. Модуль кэша читает свой корень **один раз при загрузке**, поэтому env выставляется до первого `require('../server/...')`.
- `test/helpers/{css,dom-shim}.js` — разбор CSS и минимальный DOM. DOM-смоук — процесс-глобальный, поэтому в одном сьюте может быть только один такой файл.
- `test/golden/` — три payload-снимка (`films.json`, `books.json`, `games.json`) + `smoke-baseline.json`; golden ловит изменение семантики payload'а, а не рефакторинг. Регенерация — только осознанно (`UPDATE_GOLDEN=1`), с записью «было/стало» в отчёте.
- `scripts/smoke.sh` — HTTP-прогон трёх payload'ов на `:5xxx` из golden-фикстур в `/tmp`, сверка с baseline ±5 %.
- `scripts/census.js` (`npm run census`) — размеры модулей и функций, копии хелперов, мёртвые модули, дубли портов; `test/census-thresholds.test.js` держит ратчет.

**Контракты.** `contracts/{api,env,limits,cache}.md` генерируются из кода (`npm run gen:contracts`), дрейф ловит `test/gen-contracts.test.js`. Если контракт расходится с кодом — правится код и контракт перегенерируется, а не наоборот. Правка «руками» запрещена. Любой перенос кода, меняющий `file:line`, требует перегенерации: диффом должны быть **только аннотации**.

**Источники и вежливость (эмпирика, которую нельзя «оптимизировать»):**

- Кинопоиск — скрап только штатным bootstrapped-импортом по действию пользователя; никогда для тестов и «проверить, что парсер жив».
- LiveLib — UI **не скрейпит** `livelib.ru`: импорт и обновление профиля = загрузка файла `livelib-backup`, за ходом следит resolve-job. Скрап-эндпоинт остался аварийным путём (bootstrap + cookie-план Б) и тестируется только моками. При живом спайке: ≤4 запроса, пауза 1.5–2.5 s, только HTML-страницы; cookie пользователя хранится `0600`/`0700` в `cache-book/cookies/` и не возвращается в API/логах.
- Литрес — неофициальный Foundation API без ключа, 2 запроса/книга, пауза 2 s, breaker 30 мин. Два потребителя (resolve-этап импорта и `kinoboxd-resolve-books`) не пересекаются общим `resolve.lock`.
- Google Books — free-tier ~1000/день с ключом; кириллицу искать plain-фразой (`intitle:`/`inauthor:` её не индексируют); значение ключа не эхоить.
- Hardcover — 60 запросов/мин, 5000/день; каждый top-level GraphQL-филд = запрос.
- Steam — `STEAM_API_KEY` **обязателен** для библиотеки (`GetOwnedGames` без ключа → 401); профиль/достижения/global%/размер библиотеки собираются без ключа. **Все формы `/games` → `302 /login/` даже для публичных профилей** (login-gate, не приватность; проверено 12 запросами/8 формами, cookie-jar и браузерные заголовки не помогают) — на эту форму запросы не тратить. Отзывы: старый `appreviews` мёртв, актуальный — `IUserReviewsService/GetAppReviews`. DNS: локальный резолвер может отдавать TLS-мёртвые edge-IP (лечится резолвером/DoH, **IP не хардкодить**).
- GOG/Epic secondary-метадата — GOG v2 недокументирован (используется веб-магазином), публичный; `globalReleaseDate` приоритетнее `gogReleaseDate`; Epic CMS — только `productHome`, `addon`/`offer` пропускать.
- WDQS — батчи по 450, уважать `429`/`Retry-After`, при outage не чаще 1 запроса/мин.
- **GOG-паузы — полные `sleep` между запросами, а не «минимальный интервал» общего гейта.** Переводить их на `createSourceGate` нельзя: источник молча ускорится, а `limits.md` этого не покажет.

**Epic: авторизация и отказы.** Работает только `grant_type=authorization_code`: `GET /api/games/epic/auth-url` → пользователь логинится на epicgames.com → копирует `code` со страницы `/id/api/redirect` → `POST /api/games/epic/connect { code, owner }` → импорт стартует сам. `code` принимается и как голая строка, и как вся ссылка. Обмен — `POST /account/api/oauth/token` с `Authorization: basic <base64(client_id:client_secret)>` **в заголовке** (не в query/body), `Content-Type: application/x-www-form-urlencoded`, `grant_type=authorization_code&code=…&token_type=eg1`; refresh — тот же эндпоинт с `grant_type=refresh_token`. Device-code flow оставлен в коде, но публичным лаунчер-клиентам Epic отвечает `400 unsupported_grant_type` (1016) — это отказ в возможности, а не ошибка запроса. Модель: один владелец — один Epic-аккаунт (`owner_mismatch` при попытке второго), `lastPlayed` не существует и не выдумывается, при истёкшем токене снимок остаётся с `status: 'auth_expired'` + `fetchedAt`, а не нулями.

**Персоналии: роли и покрытие.** `developer` — единственная роль по умолчанию (Steam `developers[]` + Wikidata `P178`); `publisher` — Steam `publishers[]` + `P123`; `composer`/`designer`/`writer`/`producer`/`director`/`programmer`/`creator` — только Wikidata (`P86`/`P287`/`P58`/`P162`/`P57`/`P943`/`P170`); `artist`/`sound`/`voice` — только MobyGames. `GET /api/games/personnel` берёт ровно один `profile`, `role` (алиасы `studio`/`studios`/`dev`/`pub`), `sort` = `hours|count|completion|name`, `limit` 1–50. `pending.reason` — словарь для UI: `null` (всё есть), `running` (пасс идёт), `waiting_details` (ждёт store-enrich), `started` (роут только что запустил), `recent_cooldown` (<10 мин), `wikidata_not_run`, `wikidata_cooldown` (+`disabledUntil`).

---

## 11. Открытые остатки и известные компромиссы

**Остатки (12.11.2026).** Закрыто в этом раунде: `meta.secondaryDetails.running` переехал в `core/jobs` (§7), инлайн-копии округления заменены на `core/stats` (0 выражений `Math.round(x * 10**n) / 10**n` в `server/`), books-миграции `authors`/`manga` стали юнитами (§12), FP таксономии снимаются per-film blacklist'ом (§5.1), распилены `taxonomy.js`, `games/steam-art.js`, `games/editions.js` (24 → 21 модуль > 800 строк).

1. 21 модуль > 800 строк остался осознанно — в основном доменные фасады и контроллеры: `public/js/books.js` 4 294, `public/js/games.js` 3 465, `public/js/games-view.js` 2 017, `public/js/widgets.js` 1 971, `public/js/main.js` 1 819, `server/games/franchise.js` 1 569, `server/books/livelib.js` 1 508; дальнейшее дробление — продуктовый раунд, ратчет в `test/census-thresholds.test.js` только сокращается.
2. В сьютах порядок блоков нагрузочный (шапка каждого сьюта объясняет почему): новый тест с агрегатом по всему кэшу идёт до seeding-блока или остаётся одиночным.
3. `config/{gbooks,steam,hardcover}-token` — dev-фоллбеки; в проде только sops.
4. Books-каталог `cache-book/` на dev-машине пуст: боевые данные живут по `KINOBOXD_CACHE_BOOK_DIR` деплой-конфига.

**Таксономия и FP:**

- **Found footage** — отдельной категорией не является; `mockumentary` включает алиасы `faux documentary`/`pseudo documentary`.
- **Zombie/Kaiju/Mockumentary** — единичные FP снимаются per-film blacklist'ом (см. ниже), глобальное правило остаётся exact-keyword + Wikidata.
- **Gothic horror / cyberpunk** — `biopunk` и `gothic` намеренно не алиасы: расширили бы бакет вдвое.
- **Marvel** — TMDB хранит не одной коллекцией, а десятком под-франшиз, поэтому виджет показывает их раздельно.

**Игры (ограничения данных, а не баги):**

- Приватный профиль отдаёт пустой ответ, а не «0 игр»; `playtime_forever` включает idle и семейный доступ; `unlocktime` после оффлайн-синхронизации даёт кластеры; `badges/13` отстаёт от `game_count`; `<stats><hoursPlayed>` ≠ `playtime_forever`; HTML-`percentages` — не контракт; дата Steam Store — дата переиздания.
- FP франшиз: Dark Souls ≠ Darkest Dungeon, Hitman ≠ Hitman's Bodyguard; Wikidata неровна (у Witcher 3 нет дизайнеров); осиротевшие агрегаты (`hoursHistogram`, `summary.modes`, `backlog`) оставлены ради контракта.

---

## 12. Деплой

- `nix/package.nix` — пин `fetchFromGitHub` (`rev`, `hash`) + `buildNpmPackage` (`npmDeps.hash`). Пин обновляется **только здесь**.
- `nix/module.nix` — systemd: сервер, бэкфилл фильмов (`allTargets`: `imdb`, `keywords`, `wikidata`, `rematch`, `collections`, `mcu`), бэкфилл книг (годы, resolve, `manga`, `authors`), юниты игр; `EnvironmentFile`, state-раскладка. Все books-миграции теперь юниты; таймер `manga` вкл., `authors` — опционален.
- Лаунчеры `nix/package.nix`: `kinoboxd`, `kinoboxd-backfill`, `kinoboxd-books-backfill`, `kinoboxd-books-resolve`, `kinoboxd-books-migrate` (диспетчер `manga|authors`).
- Личный site-конфиг (`services.kinoboxd`: sops-секреты, порт, state, таймеры) живёт вне репозитория — в `~/.nixos`; в repo его нет.
- Переменные: `KINOBOXD_CACHE_DIR`, `KINOBOXD_CACHE_BOOK_DIR`, `KINOBOXD_CACHE_GAMES_DIR`, `KINOBOXD_STATE_DIR`, `KINOBOXD_PASSWORD`, `PORT` (боевой `3000`; в тестах не использовать).
- Текущий пин (`v1.1.0`): `rev = 7b5597d4b547b971bd767d692e50792d5d738d00` (коммит тэга), `hash = sha256-IxYV5Bfv8YxtnIHf2FJkLMYfaadpUIYEDZtBCiT9vcE=`, `npmDeps.hash = sha256-X6rMqzNU1oXT0h1oc7Ak3dxP6Yb90frXXbiIra52Qag=` (не менялся: `package-lock.json` не двигался с `v1.0.0`), store `/nix/store/k2gzh95g3nrczz70lsx4avq2mrb7xmi2-kinoboxd-1.1.0`. Предыдущий пин — `v1.0.0`: rev `2416813…`, store `/nix/store/6cjby7wpcf4gawir94ypi29cvgpp1cbg-kinoboxd-1.0.0`.
- `flake.nix` больше **не дублирует** рецепт: он делает `pkgs.callPackage ./nix/package.nix { source = <local tree>; }`, поэтому лаунчеры, `prepare_state` и `meta` живут в одном файле. Пин `rev` указывает на коммит последнего релизного тэга, поэтому он всегда отстаёт от HEAD (архив собственного коммита запинить нельзя). `nix build .#` пин не использует.

### 12.1. Релизы и тэги

- **Тэг — единица релиза.** Annotated-тэг `vX.Y.Z` на `main`; `version` в `nix/package.nix` = тэг без префикса (`v1.4.2` ⇔ `version = "1.4.2"`). Другого источника версии нет.
- **Пин ставится на тэг, а не на HEAD.** `rev` = коммит последнего релиза (или сам тэг, `rev = "v1.4.2"` — `hash` от этого не меняется, он считается по распакованному дереву). Практический выигрыш: пин трогается один раз на релиз, а не после каждого пуша.
- **Semver — по контракту, а не по объёму работы:**
  - **patch** (`1.0.x`) — багфикс без изменения формы payload/API и чисел в `contracts/`;
  - **minor** (`1.x.0`) — аддитивно: новое поле payload, эндпоинт, виджет, источник, опциональный env; все прежние поля и golden-семантика на месте;
  - **major** (`x.0.0`) — ломающее: удаление/переименование поля или эндпоинта, новый обязательный query-параметр, ужесточение валидации, смена семантики существующего числа.
- **Релиз — два коммита:** `chore(release): X.Y.Z` (только `version` в `nix/package.nix`) → тэг на этот коммит → `chore(nix): pin vX.Y.Z` (только пин). Тэг ставится на уже запушенный коммит и пушится до/вместе с пином: пин на несуществующий remote-тэг не соберётся у чужих машин.
- **Тэги не двигаются и не удаляются.** Ошиблись с номером — следующий релиз исправляет (`v1.2.1` → `v1.2.2`), история тэгов остаётся линейной. До первого релиза версия не поднимается «на глазок»: номер будущего релиза выбирается в коммите `chore(release)`, а не после него.
- Каталог данных от пина не зависит: `prepare_state` штампует `server@<store-hash>`, поэтому смена `rev` не требует миграции `state/` или `cache*/`.

---

## 13. Правила агентам

### 13.1. Раунды и брифы

**Бриф самодостаточен.** Агент не видит беседу оркестратора с пользователем. В брифе обязаны быть: точные файлы (что читать и что менять), awaited результат (поведение, числа, какой тест это подтверждает) и RESTRICTED-ограничения (что трогать запрещено, какие внешние API запрещены). Если чего-то не хватает — принять разумное допущение и **зафиксировать его в отчёте**; вопросы оркестратору не задавать.

**Обязательный шот-лист отчёта:**

- **Deploy-файлы:** какие из `nix/package.nix` / `nix/module.nix` изменены.
  - Изменился `nix/module.nix` (или пакет целиком, не только пин) → готовые `install -Dm644`-команды для `~/.nixos` (модуль → `modules/services/kinoboxd/module.nix`, пакет → `packages/kinoboxd/package.nix`). «Пин обновлён» без команд — не отчёт.
  - Изменился **только пин** (`version`/`rev`/`hash`/`npmDeps.hash`) → никаких `install`: в отчёте pin-блок, который копируется в site-конфиг как есть. Блок печатается целиком, строками ровно в том виде, в каком они стоят в рецепте; не изменившаяся с прошлого отчёта строка помечается `# без изменений`, чтобы блок вставлялся целиком, а не досочинялся по памяти:

```nix
version = "1.4.2";
rev = "<sha коммита v1.4.2>"; # допустимо и "v1.4.2"
hash = "sha256-…"; # fetchFromGitHub
npmDepsHash = "sha256-…"; # fetchNpmDeps.hash; меняется только с package-lock.json
```

  Если в конфиге поле называется иначе (`npmDeps.hash`), строка печатается с этим именем.
- **Тест-числа:** сколько тестов, что проверено, реальные цифры (payload ±байты, счётчики, тайминги), а не «стало быстрее».
- **Git:** commit SHA(ы), файлы, ветка; `pin` (rev в `nix/package.nix`) и store-путь.
- **Риски:** что не проверено, где данные могли устареть, какие допущения приняты.
- **Payload/данные:** только выборочные фрагменты (1–2 примера), не дампы.

**Ворота раунда** (без них раунд не закрыт): `npm test` 0 fail и число тестов не уменьшилось; golden байт-в-байт; `node scripts/gen-contracts.js --check` — up to date; `bash scripts/smoke.sh` — 200 на трёх payload'ах; `npm run census` — пороги соблюдены; новых зависимостей 0; боевой кэш не мутирован; токены не эхоились.

### 13.2. Worktree-параллелизм

Базовое правило: **дизъюнктные по файлам раунды — параллельно**, пересекающиеся — последовательно.

```bash
cd "$REPO"          # корень репозитория
git worktree add ../kb-wt-<name> -b agent/<name>
ln -s "$REPO/node_modules" ../kb-wt-<name>/node_modules
ln -s "$REPO/cache"        ../kb-wt-<name>/cache
```

- Корень worktree — это корень репозитория: `server/`, `public/`, `package.json`, `nix/` лежат прямо в `kb-wt-<name>/`.
- Каждый раунд гоняет тесты со **своей** базой: `KINOBOXD_TEST_PORT_BASE=<уникальный>` (6000–9800 или 11000–19000; 9900–10999 запрещены).
- Мутирующие кэш/бэкфилл прогоны — **только в main-дереве**; в worktree допустимы unit/mock/live-read тесты.
- Ветки не трогают `nix/`, `flake.nix`, `devenv.*`, `AGENTS.md`.
- Перед началом: `git -C <worktree> branch --show-current` → `agent/<name>`.
- Hot-set, который **нельзя** параллелить между собой: `server/stats.js` + `server/stats/`, `server/taxonomy.js`, `public/js/widgets.js`, `public/index.html`.
- Конфликт по `package-lock.json` — ошибка планирования раундов, а не рутинная работа.
- После merge: `git worktree remove <path>`; ветка остаётся для истории.

### 13.3. Merge / release / push (после каждого раунда)

```
merge → npm test → nix flake check → smoke → nix-build → chore(release) → tag → pin → push
```

**Релиз (если раунд меняет исходник — то есть почти всегда):**

1. Номер по §12.1, коммит `chore(release): X.Y.Z` — в `nix/package.nix` меняется только `version`.
2. Ворота раунда (§13.1) на этом коммите.
3. `git tag -a vX.Y.Z -m "kinoboxd X.Y.Z"` на этом коммите и `git push origin main vX.Y.Z`. Пин пишется **после** этого: тэг обязан существовать в remote.

**Пин `nix/package.nix` (отдельный коммит `chore(nix): pin vX.Y.Z`):**

1. `rev` = коммит с тэгом (или `"vX.Y.Z"`), `hash`/`npmDeps.hash` = `lib.fakeHash`, если менялось дерево/`package-lock.json`; если не менялось — строки остаются прежними и печатаются как `# без изменений`.
2. Локальная проверка рецепта без пина: `nix-build -E 'with import <nixpkgs> {}; callPackage ./nix/package.nix { source = ./.; }'` из корня репозитория → взять `got: sha256-…`; для пина на тэг — `nix-prefetch-url --unpack https://github.com/hattivatt/kinoboxd/archive/refs/tags/vX.Y.Z.tar.gz` + `nix hash convert --to sri`.
3. Пересобрать до успеха и проверить store-smoke (health + три payload'а).
4. В отчёт — pin-блок по формату §13.1 (не пересказ) + store-путь.
5. `git push origin main` — пин уезжает уже на существующий тэг, догоняющих коммитов из-за отставания `rev` больше нет.

### 13.4. Секреты и кэш

- **Ничего вне project sandbox.** В первую очередь **`~/.nixos/**`** — агенты никогда их не читают, не пишут и не «пинят» (прецедент `34bf666`: агент записал пин прямо в `~/.nixos`).
- Токены в тестах — только через env (`TMDB_API_TOKEN`, `HARDCOVER_API_TOKEN`); config-файлы `chmod 600`, gitignored, только dev-фоллбек.
- **Никогда** не эхоить значение токена в отчёт, лог, коммит, скриншот или фикстуру: только маска (`hc_pat_***`, `eyJ***`, `AIzaSy***`, `***`) и источник (`env`/`file`).
- Токен не должен попадать в argv, `.drv`, `result`, `ps`.
- Тесты не мутируют боевые `cache*` и state: копия в `/tmp/opencode/...` через `KINOBOXD_CACHE_*` + `KINOBOXD_STATE_DIR`. Перед прогоном `echo $KINOBOXD_CACHE_DIR` должен указывать в `/tmp`.
- На `thevalley` секреты берутся из `gopass` (`apikeys/<service>-api-key`, легаси-записи в `apitokens/` и `Services/`) и только в env (`TMDB_API_TOKEN="$(gopass show -o …)"`). `gopass` — единственное исключение из «ничего вне sandbox»: читать значение можно, но оно не должно попасть ни в вывод, ни в файл, ни в коммит; в отчёте — только имя записи и маска.
- `cache/`, `result`, `result-*`, token-файлы **никогда** не коммитятся.

### 13.5. Git-гигиена

- Коммиты осмысленные, по логике раунда; сообщение объясняет «что и зачем», а не «fix».
- `git status` после раунда чистый (кроме осознанно оставленных untracked, о которых сказано).
- Релизные тэги (`vX.Y.Z`) — часть истории, а не рабочая мелочь: их не переносить, не пересоздавать и не удалять (§12.1).
- Коммит и пуш — только после зелёных e2e/регрессий; не пушить «чтобы сохранить».
- Добавили зависимость → `npmDeps.hash` пересчитывается заново и проверяется сборкой.
- Документация живёт **только здесь**: архитектурные и плановые markdown-файлы не заводятся. Контракты — `contracts/*` (генерируются), `spec/*.md` — короткие указатели сюда, `README.md` — витрина репозитория.

### 13.6. Модели

- **Бесплатные** — для механических, коротких, хорошо огороженных раундов (переносы хелперов, удаление мёртвого кода, доки, слияние тестов). Обязателен ревью диффа по трём пунктам: публичный API не изменился, число тестов не уменьшилось без объяснения, golden байт-в-байт. При провале любого пункта раунд переисполняется сильной моделью, а не «дожимается» правками.
- **Платные — только `opencode-go`** (`pi`-провайдер, модели `opencode-go/*`). Другие платные провайдеры не использовать.
- Бесплатные пулы квотируются и могут кончиться посреди раунда: для длинных задач сразу брать `opencode-go`, а free — для коротких; при падении агента с «usage limit / insufficient funds» продолжение писать в тот же worktree с явным описанием уже сделанного.

### 13.7. Что делать при противоречии правила и здравого смысла

1. Остановиться до необратимого действия (push, merge, мутация боевого кэша).
2. Сообщить: какое правило, в чём конфликт, предложение и что будет сделано по умолчанию.
3. Правило меняется **через этот файл**, а не разовым исключением в коде/отчёте.
4. Принятое допущение — в отчёт.
