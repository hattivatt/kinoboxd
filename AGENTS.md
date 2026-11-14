# AGENTS — kinoboxd: архитектура и правила

**Этот файл — единственный документ проекта.** Здесь и текущая архитектура сервиса, и правила, по которым работают агенты-исполнители. Других архитектурных/плановых документов нет: backlog, история решений и остатки — в §11, эмпирика по источникам — в §10, числа лимитов — в `contracts/limits.md` (генерируется).

**Раскладка.** Git-репозиторий — корень проекта. В нём лежит всё, что нужно для разработки и деплоя: `server/`, `public/`, `test/`, `scripts/`, `contracts/`, `spec/`, `nix/` (сборка и NixOS-модуль), `devenv.*` (dev-shell), `flake.nix`. Вне git остаётся только то, что генерируется или является личным: `node_modules/`, `cache*/`, `config/*-token`, `.devenv/`, `result`, `state/`, а также личный site-конфиг `kinoboxd.nix` (в `~/.nixos`). Имя `AGENTS.md` выбрано как конвенция, которую автоматически читают agent-тулзы.

**Статус:** v3.9.1, 14.11.2026, `main` на тэге `v1.5.1` (предыдущий — `v1.5.0`, задеплоен на thecomet 13.11.2026). v3.9.1: гейт автора понимает каталожную метку «Фамилия, Имя Отчество», канал «от автора» не отбрасывает однобуквенные токены названия («Gantz:E» ≠ «Gantz») (§5.2, §11). v3.9: раунд «распознавание книг II» — три бага года (проекция `?authorBirth`, `first_publish_date` OpenLibrary, legacy-заявки вне очереди), год для нерезолвленных работ (`yearOnly`), ярусы вариантов названия, порядок имени автора, гейт тома и выведенного ISBN с лечением сохранённых связей, канал Wikidata «от автора», Фантлаб как источник года, порядок очереди (§5.2, §7, §10, §11). v3.8: аудит — сервер стартует без TMDB-токена (503 `tmdb_token_missing` только на TMDB-роутах, `tmdb` в `/api/health`), лимит неудачных входов и чистка сессий, комментарии вычищены из всего кода (ратчет census = 0), census отличает алиасы от копий, `books/routes.js` распилен (`routes-stats`, `profile-scope`, `route-errors`), мёртвые `dedupeWorks`/`mergeWorkGroup` удалены, нормализаторы книжного payload'а — в `books-normalize.js`, `modulepreload` всего графа модулей (§2, §8, §10, §11). v3.7: раунд «распознавание книг и метаданные» — челленджер тиражной заявки на год, кросс-языковой гейт автора, серии из всех провайдеров и канал `P179`/`P1545` в Wikidata, каноническая идентичность работы (`wikidataWorkId`), ручные правки серий и ссылок с аудитом, скрипт метрик качества; исправлена ложная «регрессия дедупа» (§5.2, §10, §11). v3.6: сверены дефолты таймеров модуля с текстом §12 (books hourly, manga weekly). v3.5: комментарии в коде не оставляются (§13.8), контракт модуля — в этом файле и `contracts/*`. v3.4: год первого издания — Wikidata-канал (провайдер, батчевый проход в resolve и бэкфилле), точность/вид заявки в payload, проверка правдоподобия, негативный маркер по набору провайдеров (§5.2, §10). v3.3: закрыт backlog §11 (все job-«running» в `core/jobs`, округления через `core/stats`, per-film blacklist таксономии, books-миграции юнитами, три распила модулей). v3.2: релизы на тэгах `vX.Y.Z` и semver, pin-блок в отчёте (§12.1, §13.1, §13.3). v3.1: dev/deploy-файлы внутри репозитория. Заменяет `АРХИТЕКТУРА.md`, `ПЛАНЫ.md` и `РЕФАКТОРИНГ-ПЛАН.md` (их содержимое сведено сюда, сами файлы удалены; история — в git).

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
    books/                routes, routes-manual (ручные правки), book-cache, import, resolve + resolve-stages/,
                          providers/ (hardcover, litres, googlebooks, openlibrary, wikidata, livelib-card, fantlab)
                          + title-variants.js (ярусы названия) + wikidata-author-works.js (канал «от автора»),
                          unlinked-years.js + year-only.js (год нерезолвленных работ), fantlab-flag.js,
                          resolve-stages/link-health.js (связи под пересвязку),
                          + claim.js (правила заявки на год) + match.js (гейт кандидата)
                          + series-name.js (гигиена имени серии) + ../wikidata-flag.js (kill switch),
                          series-identity.js (одна нормализация серии), series-stage.js (заполнение серии),
                          series-overrides.js  links.js  audit.js (ручные правки и их аудит),
                          routes-stats.js (/stats, /unmatched; монтируется внутри routes.js),
                          profile-scope.js (строгий ?profile=), route-errors.js (профиль ошибок домена),
                          backfill-queue.js (выбор документов для бэкфилла),
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
    js/                   main, widgets, books* (books-normalize — чистые нормализаторы payload'а), games*,
                          films: доменные контроллеры и виджеты
  contracts/              api.md env.md limits.md cache.md — генерируются, руками не правятся
  scripts/                gen-contracts.js, census.js, books-quality.js, smoke{,-seed,-preload}.sh
  test/                   76 файлов: 13 доменных сьютов + 63 одиночных, helpers/, golden/
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

Каждый модуль — одна сквозная подсистема с одним контрактом. Контракт модуля живёт в этом файле (и в `contracts/*`), а **не** в комментарии над файлом: новые комментарии в коде не добавляются (§13.8).

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
| TMDB | canonical-метадата: название, год, жанры, страны, постеры, люди | Web API, `TMDB_API_TOKEN` / `config/tmdb-token`; без токена сервер работает, фильмы отдаются из кэша, `enrich`/`import/kinopoisk`/`attach/lbzip`/`tmdb/search`/`match` → 503 `tmdb_token_missing` |
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
| Wikidata | год первого издания работы: `P577`/`P571` + точность, обход `P629` | WDQS, батч по названиям + канал «от автора» |
| Фантлаб | год первого издания + все русские варианты названия и оригинал | публичный API `api.fantlab.ru` (тестовая фаза v0.9, без ключа), поиск по названию |

- Импорт-файл: multipart, полка (read/wish), идемпотентность по ключу строки, манга-фильтр. Прогресс и результат — resolve-job.
- Hardcover: инкрементальный журнал; пустой дельта-импорт не запускает resolve.
- Resolve-цепочка (`books/resolve.js` + `resolve-stages/`): ISBN → название+автор → провайдеры по приоритету (Hardcover, Литрес, Google Books, OpenLibrary, LiveLib-card) → год (Wikidata, батчем) → `details/{hcWorkId}.json` + `links.json`.
- Происхождение метадаты видно в `metadataSources`; `links/{livelibBookId}.json` хранит метод и score матча.
- Серии/сборники: эвристика в `segments.js`; ручные флаги манги — `flags/book-flags.json`; блэклист тэг-серий — `series-blacklist.js`.
- Серия у работы — не одна: провайдеры отдают `seriesAll` (Hardcover, Литрес, LiveLib-card, OpenLibrary), `mergeResults` объединяет их по единому ключу из `series-identity.js`, `resultToDetails` пишет union в `details.series`. Одна нормализация имени для провайдеров (`sanitizeSeriesName`/`seriesKeyOf`) и для payload (`normalizeSeriesName`) — общий `series-identity.js`: две нормализации уже расходились и раздваивали полку. Гигиена: NFKC, повторное снятие скобочных суффиксов («The Punisher (2004) (Single Issues)» → «The Punisher»), обрезка непарного хвоста («Кристин, дочь Лавранса)  (Kristin Lavransdatter»), номер тома из строки (`seriesEntryOf`, четырёхзначный год томом не считается).
- Payload-серии собирает `stats/series.js:seriesGroupsOf`: ключи `id:<hcId>` и `name:<нормализованное имя>` объединяются union-find (как в `propagateSeriesManga`), каждая работа входит в серию один раз, id — меньший, имя — без скобок, в алфавите большинства томов, затем по частоте. Позиция тома (`details.series[].position`, 87 % записей) отдаётся в `series[].works[].position`. На живом кэше: 236 серий → 221, раздвоенных карточек 8 → 0.
- Серия из Wikidata (`P179` + номер `P1545`) — второй канал в `providers/wikidata.js` (тот же ответ, что и год: двух запросов не прибавилось) и `series-stage.js`. Пишется **только** когда у работы нет никакой серии (колонка экспорта и цикл Hardcover главнее) и только после маркера `seriesCheckedAt`/`seriesCheckedBy` (тот же 30-дневный recheck, что и у года, но отдельный: промах по серии не задерживает челлендж года). Отдача канала измерена и мала: 3 из 37 (8 %) работ без серии получили её — Wikidata знает циклы у известных авторов, а не у русских переизданий.
- Каноническая идентичность работы: из того же ответа в документ пишутся `wikidataWorkId` и `wikidataAuthorIds` — ключ склейки русских и английских изданий одной работы и источник QID автора (по метке автора QID не разрешается: «Stephen King» — 13 человек).
- Ручные правки: `POST/DELETE /api/books/series-override` (`cache-book/series-overrides.json`, полный список серий работы, применяется после мерджа и блэклиста), `POST/DELETE /api/books/link` (`method: 'manual'`, цепочка не перетирает ручную ссылку даже с `force`), `GET /api/books/audit?profile=` — подозрительные связи (том, ISBN, нет документа, сирота). Год по-прежнему `POST /api/books/year-override`, манга — `/work/flag`.
- Метрики качества — `npm run quality:books` (`scripts/books-quality.js`, без сети): работы/события/без метадаты, год по источникам, дубли по каноническому ключу и по строгому названию (номера томов сохраняются), серии (одиночные, раздвоенные, дубль внутри, смешанный алфавит), over-match (одна работа — разные названия событий по `metadataWorkId`), ссылки (методы, score < 0.9, чужой ISBN, сироты). Пишет в кэш **ничего**. Живой баланс 12.11.2026: 886 работ, 16 групп дублей / 32 копии, 221 серия из них 22 с дефектом, over-match 6, 961 ссылка из них 72 с низким score, 145 с чужим ISBN, 0 сирот.
- Миграции `authors` и `manga` теперь штатные юниты: `kinoboxd-backfill-manga` (очередь, таймер вкл., `booksMangaBackfillLimit`/`PauseMs`) и `kinoboxd-backfill-authors` (диагностика, таймер выкл., `--wikidata`; мост авторов и так default-on в `/api/books/stats`). Оба зовут один диспетчер-лаунчер `kinoboxd-books-migrate {manga|authors}`.
- Resolve **не** закрывает год вместе с карточкой: после провайдеров идёт один батчевый проход `resolve-stages/year-stage.js` по работам, у которых есть details и либо нет заявки, либо заявка тиражная. Он спрашивает только Wikidata (2 запроса WDQS на ~12 названий) и пишет `firstPublishedYear` + `Precision` + `Kind`; пустой ответ ничего не пишет — негативный кэш принадлежит бэкфиллу.
- **Челленджер тиражного года.** Заявка печатного источника (`hardcover`, `litres`, `openlibrary`, `googlebooks`, либо legacy-документ без источника) переспрашивается и перекрывается только **более ранней** (при равном годе — только более точной по `precision`); заявка `wikidata` и ручная правка не переспрашиваются. Перекрытая заявка остаётся в документе как `firstPublishedYearPrevious` + `firstPublishedYearChallengedBy`, и `keepYearClaim` проносит её через повторный resolve. Перекрытие требует `match.authorHit === true` (у Wikidata есть мягкое правило «единственный кандидат без P50 с точным названием»; при заполнении пустого года оно безобидно, при перезаписи даёт «Цыганку» 1850 у Агаты Кристи). Замер живого кэша: 7 из 22 заявок Hardcover и 9 из 39 заявок Литрес/GB/OL отстают от истины больше чем на год; живой прогон на 30 документах — 4 исправления.
- Кросс-языковой гейт автора: сравнение идёт по `namesLookAlike` + точной фамилии, затем по `surnameSimilarity` (транслитерация + скелет согласных + Левенштейн, порог 0.6) из `providers/match.js` — иначе «Leo Tolstoy» никогда не совпадает с «Лев Николаевич Толстой» (11 из 70 живых заявок были недостижимы). Кандидат с чужим `P50` по-прежнему отвергается.
- Бэкфилл `years-backfill.js` (`kinoboxd-backfill-books`) спрашивает автором **из события** (русское написание из экспорта), а не из документа; тиражная заявка документа участвует в том же рейсе кандидатов, поэтому более ранняя заявка провайдера её перекрывает. Выбор документов и очередь — `backfill-queue.js`, заполнение серии — `series-stage.js`; бюджет Wikidata общий с серией, поэтому работы с вопросом про год обслуживаются **первыми**.
- Заявка на год = год + точность (`year|decade|century|millennium`) + вид (`publication|composition`): у древних текстов дата часто известна веком и называется «дата создания» (`P571`), а не публикации. Ранняя заявка выигрывает; при равном годе — более точная.
- Год работы: `manual > first > edition > unknown`; `manual` — в `year-overrides/`, `edition` — честный фоллбек с `yearSource: 'edition'`. Нижняя граница печатного года — 1000: заявка печатного источника с годом 3 (Hardcover так хранит мангу) — артефакт, а не первое издание; она отбрасывается, а не попадает в «до 1000 г.». Промах «никто не знает» кэшируется на 30 д, но маркер перечисляет **всех** спрошенных провайдеров — провайдер, добавленный позже, переоткрывает вердикт (Wikidata переоткрыла 201 документ с маркером `none`).
- **Нерезолвленные работы тоже получают год.** Событие без связи (ни один провайдер не сматчил) раньше никогда не доходило до Wikidata: year-stage идёт только по details. Теперь бэкфилл первым делом проходит `unlinked-years.js`: читательские события без связи, кроме хостов сборников и полок reading/wish, спрашиваются у Wikidata и Фантлаба (побеждает ранняя заявка), ответ пишется в `details/ll-<key>.json` с флагом `yearOnly: true`; промах — такой же документ без года, перепроверка через 30 д, а новый провайдер в маркере переоткрывает его. `yearOnly`-документ **не** считается «карточкой LiveLib»: resolve, card-stage, раскрытие сборников и отчёт unmatched смотрят на `year-only.js:liveLibMetadata` и продолжают пытаться сматчить работу. Живая копия: 280 нерезолвленных работ → 129 годов (Wikidata 66 из них в одиночку).
- **Ярусы вариантов названия** (`providers/title-variants.js`, общие для Wikidata и Фантлаба): ярус 0 — как написано, без «(сборник)/(комплект…)/(+ CD)», в нижнем регистре кроме первой буквы («Бог Мелочей» → «Бог мелочей»), с длинным тире, каждая половина двуязычной строки; ярус 1 — подзаголовок после «Серия. »; ярус 2 (`wholeWork`) — без тома/«В N книгах» и голова «Серия. Заголовок». Ярусы 1–2 требуют автора; ярус 2 **только заполняет пустой год** (ни `wikidataWorkId`, ни серии, не перекрывает заявку — иначе том 7 получил бы год начала серии). Вариант, совпавший с именем автора («Конфуций. Великие изречения» → «Конфуций»), не спрашивается.
- **Канал «от автора»** (`wikidata-author-works.js`): если по метке ничего не нашлось, имя автора → человек с работами (макс. sitelinks), затем все его работы с ru/en-метками и ru-алиасами и датой (издания с `P629` отбрасываются), сравнение локальное (регистр, ё, окончания, перекрытие токенов ≥ 0.75; однобуквенные токены значимы — «Gantz:E» 2020 не становится годом тома «Gantz Volume 18»). Нечёткое совпадение (`match.fuzzy`) только заполняет год; упавший проход оставляет названия «не спрошенными». «Багдадская встреча» → «Багдадские встречи» 1951.
- **Фантлаб** (`providers/fantlab.js`): один поиск на название (`название без маркеров + фамилия`), кандидат должен нести название среди `rusname`/`name`/`altname` и пройти гейт автора; циклы, статьи и нулевой год пропускаются, побеждает самый ранний. Его годы для рассказов и томов манги точнее Wikidata («Коробка шоколада» → «Коробка конфет» 1923, «Атака на титанов. Том 6» → 2011, у Wikidata «Приключение Джонни Уэверли» 1979 вместо 1923). Заявка `fantlab`, как и `wikidata`, не переспрашивается; мангу в основном проходе Фантлаб не спрашивает.
- **Имя автора в обратном порядке.** `authorHit` понимает каталожную метку Wikidata «Соловьёв, Леонид Васильевич», «Пастернак Б.Л.» (фамилия + инициалы) и «Бенцони Жюльетта»/«Oda Eiichiro» (два токена в обратном порядке, оба похожи), но не «Генри Хаггард» ≈ «О. Генри».
- **Гейт тома.** Номер тома читает одна функция `normalize.volumeNumberOf` («Том/Книга/Часть/Vol./Volume/Book/#»). Скоринг провайдеров по названию, `guardReject` и **каждый** ответ цепочки (`tryProvider`) отвергают кандидата с другим номером тома. Hardcover по ISBN отдаёт и название издания: издание, прицепленное к книге другого тома («Eyeshield 21, Volume 10» на книге «Vol. 1»), отвергается; ISBN, пришедший не из экспорта, а из матча Литреса, обязан называть ту же книгу (13 рассказов Кристи висели на ISBN сборника «Дама под вуалью» → «The Chocolate Box»).
- **Лечение сохранённых связей** (`resolve-stages/link-health.js`): неручная связь, ведущая на другой том, или выведенный ISBN, общий для событий с разными названиями, попадает в очередь resolve-таймера (мимо фильтра `allowedWorkIds`), а без приемлемой замены **снимается** (`report.dropped`) — событие становится обычным промахом с окном перепроверки, а не вечным повтором. Живая копия: 43 такие связи, 0 ложных; после прохода 0, over-match 6 → 2.
- **Очередь бэкфилла:** сначала нерезолвленные работы (их бюджеты Wikidata/Фантлаба — первые), затем документы: без заявки → заявка = году тиража → прочие оспоримые; манга — в конце каждой группы. Заявка без источника (legacy) оспорима и в очереди, и в year-stage (`claim.isChallengeableClaim`; раньше очередь её не видела — 943 документа). Покрытие маркера сравнивается только с **включёнными** провайдерами: выключенный источник не переоткрывает весь кэш.
- Повторный resolve не стирает дозаполненный год: `resolve-stages/chain.js` переносит поля заявки из прежнего документа, если новый ответ её не знает.
- Payload (`GET /api/books/stats?profile=…`): `works`/`booksIndex`, `series`, `authors`, `decades`, `years`, `sources`, `coverage`, `timeline`, `summary`, `meta`; у работы есть `year`, `yearSource`, `yearPrecision`, `yearKind`, у серии — `works[].position`. Счётчика схлопнутых событий в `summary` нет намеренно: строки экспорта не схлопываются (§5.1/§11). Собирается в `server/books/stats/`; `stats.js` — оркестратор. Блока `publishers` в payload **нет** (виджет удалён 04.11.2026, мёртвый серверный блок убран 10.11.2026).

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

**Вежливость.** Пауза перед запросом, бюджет на прогон, breaker на 403/429, TTL кэша, `Retry-After` при 429, сеть/5xx — deferred. Книжный WDQS (`wikidataBooks`) — 1.2 s пауза, 2 запроса на батч из 12 названий, 3 попытки с backoff, 429/502/503/504 → breaker 30 мин, бюджет `BOOKS_WIKIDATA_BUDGET` (300 книг/прогон); kill switch `KINOBOXD_BOOKS_WIKIDATA=0|off` глушит и мост авторов, и год; канал «от автора» добавляет 2+ запроса на вызов, где были промахи. Фантлаб (`fantlab`) — 1.5 s пауза, 1 запрос на название, бюджет `BOOKS_FANTLAB_BUDGET` (150/прогон), 403/429 → breaker 30 мин, kill switch `KINOBOXD_BOOKS_FANTLAB=0|off`; тестовый забор (`test/helpers/env.js`) его выключает. **Нормативные числа — `contracts/limits.md`**; объявлять источник = править `server/core/sources.js` и перегенерировать контракт, а не документ.

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

**Пароль интерфейса** (`KINOBOXD_PASSWORD`): сессии в памяти процесса (30 д), истёкшие вычищаются при каждом входе; 5 неверных паролей с одного адреса за 15 мин → 429 `too_many_attempts` + `Retry-After` (таблица ограничена 1000 адресов, `server/auth.js`).

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

**Тесты.** `npm test` = `node --test test/*.test.js`: **77 файлов** (13 доменных сьютов + 64 одиночных), **1 588** тестов (1 577 pass, 11 skip), 0 fail, ~36 s. Тесты раунда v3.9 — `test/books-recognition.test.js`.

- `test/helpers/port.js` — `portFor(slot)`; база из `KINOBOXD_TEST_PORT_BASE` (по умолчанию 6000). Диапазон **9900–10999 не использовать**: там WHATWG-«bad ports» (10080 и др.), `fetch` их отвергает. Две полные сюиты можно гонять параллельно разными базами — это единственный способ не получить ложный `EADDRINUSE`.
- `test/helpers/env.js` — `makeTmpCache`, `tmpDir`, `resetMutableState`, `cleanupTmpDirs`. Модуль кэша читает свой корень **один раз при загрузке**, поэтому env выставляется до первого `require('../server/...')`.
- `test/helpers/{css,dom-shim}.js` — разбор CSS и минимальный DOM. DOM-смоук — процесс-глобальный, поэтому в одном сьюте может быть только один такой файл.
- `test/golden/` — три payload-снимка (`films.json`, `books.json`, `games.json`) + `smoke-baseline.json`; golden ловит изменение семантики payload'а, а не рефакторинг. Регенерация — только осознанно (`UPDATE_GOLDEN=1`), с записью «было/стало» в отчёте.
- `scripts/smoke.sh` — HTTP-прогон трёх payload'ов на `:5xxx` из golden-фикстур в `/tmp`, сверка с baseline ±5 %.
- `scripts/census.js` (`npm run census`) — размеры модулей и функций, копии хелперов, мёртвые модули, дубли портов; `test/census-thresholds.test.js` держит ратчет. Ратчет только сокращается. Census помечает однострочные реэкспорты хелперов ядра (`const safeKey = fsStore.safeKey;`, `const round2 = (v) => round(v, 'finite');`) как `(alias)` и не считает их копиями. Ратчет строк-комментариев (§13.8) стоит на **0**: любой новый комментарий валит `census-thresholds`.
- `test/modulepreload.test.js` — список `<link rel="modulepreload">` в `index.html` обязан совпадать со статическим графом импортов точек входа: добавили модуль — добавьте preload.
- `scripts/books-quality.js` (`npm run quality:books`) — метрики качества книжного домена на кэше (без сети, кэш не пишет): дубли работ, раздвоенные серии, over-match, годы по источникам, ссылки. Гонять на копии боевого кэша после каждого книжного раунда (§5.2).

**Контракты.** `contracts/{api,env,limits,cache}.md` генерируются из кода (`npm run gen:contracts`), дрейф ловит `test/gen-contracts.test.js`. Если контракт расходится с кодом — правится код и контракт перегенерируется, а не наоборот. Генератор понимает роутеры, смонтированные внутри роутера (`router.use(xRouter)`), и коды ошибок `parseBoolean({ code })`. Prose-описания эндпоинтов и `purpose` env-переменных генератор брал из комментариев; после §13.8 их нет, поэтому `purpose` у большинства env показывает строку кода. Правка «руками» запрещена. Любой перенос кода, меняющий `file:line`, требует перегенерации: диффом должны быть **только аннотации**.

**Источники и вежливость (эмпирика, которую нельзя «оптимизировать»):**

- Кинопоиск — скрап только штатным bootstrapped-импортом по действию пользователя; никогда для тестов и «проверить, что парсер жив».
- LiveLib — UI **не скрейпит** `livelib.ru`: импорт и обновление профиля = загрузка файла `livelib-backup`, за ходом следит resolve-job. Скрап-эндпоинт остался аварийным путём (bootstrap + cookie-план Б) и тестируется только моками. При живом спайке: ≤4 запроса, пауза 1.5–2.5 s, только HTML-страницы; cookie пользователя хранится `0600`/`0700` в `cache-book/cookies/` и не возвращается в API/логах.
- Литрес — неофициальный Foundation API без ключа, 2 запроса/книга, пауза 2 s, breaker 30 мин. Два потребителя (resolve-этап импорта и `kinoboxd-resolve-books`) не пересекаются общим `resolve.lock`.
- Google Books — free-tier ~1000/день с ключом; кириллицу искать plain-фразой (`intitle:`/`inauthor:` её не индексируют); значение ключа не эхоить.
- Hardcover — 60 запросов/мин, 5000/день; каждый top-level GraphQL-филд = запрос.
- Steam — `STEAM_API_KEY` **обязателен** для библиотеки (`GetOwnedGames` без ключа → 401); профиль/достижения/global%/размер библиотеки собираются без ключа. **Все формы `/games` → `302 /login/` даже для публичных профилей** (login-gate, не приватность; проверено 12 запросами/8 формами, cookie-jar и браузерные заголовки не помогают) — на эту форму запросы не тратить. Отзывы: старый `appreviews` мёртв, актуальный — `IUserReviewsService/GetAppReviews`. DNS: локальный резолвер может отдавать TLS-мёртвые edge-IP (лечится резолвером/DoH, **IP не хардкодить**).
- GOG/Epic secondary-метадата — GOG v2 недокументирован (используется веб-магазином), публичный; `globalReleaseDate` приоритетнее `gogReleaseDate`; Epic CMS — только `productHome`, `addon`/`offer` пропускать.
- WDQS — батчи по 450, уважать `429`/`Retry-After`, при outage не чаще 1 запроса/мин.
- **Год первого издания (эмпирика, 12.11.2026).** Замеры на живом кэше против Wikidata: 7 из 22 заявок Hardcover и 9 из 39 заявок Литрес/GB/OL отстают от истины больше чем на год («Чайка Джонатан Ливингстон» 1998 vs 1970, «Агнес Грей» 1998 vs 1847, «Занавес» 1966 vs 1975, «Лолита» 1777 из OpenLibrary). Отсюда челленджер: тиражная заявка переспрашивается, принимается только более ранняя, и только с подтверждённым автором. Заявки самой Wikidata ошибочны в 2 из 59. У русских переизданий печатных источников нет: OpenLibrary не имеет ни одной записи по 9 проверенным RU-ISBN (0/9), Wikidata по RU-ISBN (`P212`) — 0/4, Литрес `date_written_at` у «Искусства войны» `null`. Google Books отдаёт только год тиража. Работает один канал — Wikidata по **русскому названию** + автор: 43 из 97 недатированных названий боевого кэша (44%) на точном совпадении метки, на полном прогоне — 69 из 201 (34%), 33 запроса. Три обязательных правила матчинга: тип-фильтр `?item wdt:P31 ?type . ?type wdt:P279* wd:Q7725634` (цепочка `wdt:P31/wdt:P279*` даёт 504 за 60 s), обход `P629` (иначе дата перевода «Одиссеи» 1997 выдаётся за год работы) и отказ при чужом авторе (иначе «Бретёр» Ю. Яковлевой становится повестью Тургенева 1847). Запрос с `P629`-UNION внутри поиска по метке тоже уходит в 504 — канон спрашивается отдельным `VALUES`-запросом (~0.5 s).
- **Распознавание книг II (эмпирика, 13–14.11.2026, копия боевого кэша thecomet, профиль `livelib-Margaret`, 886 работ).** Из 265 работ без первого года 176 не имели связи вовсе и поэтому никогда не спрашивались у Wikidata. Причины промахов Wikidata, найденные руками: регистр метки («Бог Мелочей»), «(сборник)»/«(комплект…)»/«Том K» в названии, автор «Фамилия И.О.», другой русский перевод названия («Коробка шоколада» ↔ «Коробка конфет»). Wikidata даёт рассказам Кристи даты сборников (1979, 1999) — Фантлаб даёт 1923–1926. Hardcover по ISBN прицепляет издания томов к книге первого тома (Eyeshield 21: 18 томов → «Vol. 1», xxxHolic: 6 → «Vol. 5»); `editions.title` у Hardcover при этом верный. OpenLibrary у русских изданий — почти всегда отдельная транслитерированная «работа» без `first_publish_date` (3 из 12 его имели). Итог полного цикла на копии (resolve 47 + бэкфилл ×2): первых годов 609 → 687, без года 192 → 118, over-match 6 → 2, заявок `wikidata` 77 → 131, `fantlab` 0 → 25 (в payload; у нерезолвленных Фантлаб дал ~70 из 129), Литрес 69/200 за прогон. Фантлаб на трудном остатке (60 работ, где Wikidata промахнулась) — 34 попадания (57 %).
- **Древние тексты.** Год «первого издания» для них часто не существует: Wikidata даёт «Илиаду» 800 г. до н.э. с точностью «век», «Эпос о Гильгамеше» −2100, «Панчатантру» −299, «Ригведу» −1499, «Слово о полку Игореве» 1185 (только `P571`, точность «век»); а у «Одиссеи», «Махабхараты», «Рамаяны», «Дао дэ цзина», «Библии» и «Торы» даты нет вообще. Поэтому в схеме есть точность и вид заявки, а не только число.
- **GOG-паузы — полные `sleep` между запросами, а не «минимальный интервал» общего гейта.** Переводить их на `createSourceGate` нельзя: источник молча ускорится, а `limits.md` этого не покажет.

**Epic: авторизация и отказы.** Работает только `grant_type=authorization_code`: `GET /api/games/epic/auth-url` → пользователь логинится на epicgames.com → копирует `code` со страницы `/id/api/redirect` → `POST /api/games/epic/connect { code, owner }` → импорт стартует сам. `code` принимается и как голая строка, и как вся ссылка. Обмен — `POST /account/api/oauth/token` с `Authorization: basic <base64(client_id:client_secret)>` **в заголовке** (не в query/body), `Content-Type: application/x-www-form-urlencoded`, `grant_type=authorization_code&code=…&token_type=eg1`; refresh — тот же эндпоинт с `grant_type=refresh_token`. Device-code flow оставлен в коде, но публичным лаунчер-клиентам Epic отвечает `400 unsupported_grant_type` (1016) — это отказ в возможности, а не ошибка запроса. Модель: один владелец — один Epic-аккаунт (`owner_mismatch` при попытке второго), `lastPlayed` не существует и не выдумывается, при истёкшем токене снимок остаётся с `status: 'auth_expired'` + `fetchedAt`, а не нулями.

**Персоналии: роли и покрытие.** `developer` — единственная роль по умолчанию (Steam `developers[]` + Wikidata `P178`); `publisher` — Steam `publishers[]` + `P123`; `composer`/`designer`/`writer`/`producer`/`director`/`programmer`/`creator` — только Wikidata (`P86`/`P287`/`P58`/`P162`/`P57`/`P943`/`P170`); `artist`/`sound`/`voice` — только MobyGames. `GET /api/games/personnel` берёт ровно один `profile`, `role` (алиасы `studio`/`studios`/`dev`/`pub`), `sort` = `hours|count|completion|name`, `limit` 1–50. `pending.reason` — словарь для UI: `null` (всё есть), `running` (пасс идёт), `waiting_details` (ждёт store-enrich), `started` (роут только что запустил), `recent_cooldown` (<10 мин), `wikidata_not_run`, `wikidata_cooldown` (+`disabledUntil`).

---

## 11. Открытые остатки и известные компромиссы

**Остатки (12.11.2026, после раунда «распознавание книг и метаданные»).** Закрыто в этом раунде: челленджер тиражной заявки на год + кросс-языковой гейт автора (§5.2), серия — union-find по id и нормализованному имени, позиции томов в payload, одна нормализация имени на провайдеров и payload (`series-identity.js`), `seriesAll` из всех провайдеров, канал `P179`/`P1545` и каноническая идентичность работы (`wikidataWorkId`, `wikidataAuthorIds`), ручные правки серий/связей и аудит подозрительных связей (`routes-manual.js`), скрипт метрик качества (`npm run quality:books`). Ранее в этом же файле: Wikidata-канал года (v3.4), маркер года перечисляет спрошенных провайдеров.

**Кросс-источниковый дедуп работ** снят осознанно в `b9162ad`: склейка по каноническому названию схлопывает тома манги и нарушает «одна строка экспорта = один том» (тест `books-book-identity`). 32 «лишние копии» живого кэша — форма данных, а не баг. Мёртвые `dedupeWorks`/`mergeWorkGroup` удалены 13.11.2026; `canonicalKeyOf` остаётся для `npm run quality:books`.


1. 16 модулей > 800 строк остались осознанно — в основном доменные фасады и контроллеры: `public/js/books.js` 3 427, `public/js/games.js` 3 133, `public/js/widgets.js` 1 843, `public/js/games-view.js` 1 691, `public/js/main.js` 1 679, `server/books/livelib.js` 1 256, `server/games/franchise.js` 1 230; дальнейшее дробление — продуктовый раунд, ратчет в `test/census-thresholds.test.js` только сокращается.
2. В сьютах порядок блоков нагрузочный (шапка каждого сьюта объясняет почему): новый тест с агрегатом по всему кэшу идёт до seeding-блока или остаётся одиночным.
3. `config/{gbooks,steam,hardcover}-token` — dev-фоллбеки; в проде только sops.
4. Books-каталог `cache-book/` на dev-машине пуст: боевые данные живут по `KINOBOXD_CACHE_BOOK_DIR` деплой-конфига.
5. Ручные правки книг (серии, связь, аудит) живут только в API: в `public/js/books.js` для них нет ни кнопки, ни экрана — UI-раунд впереди. Также нет `POST` для возврата к автоматической связи (есть `DELETE`, после которого resolve пробует сам).
6. Payload фильмов на живом кэше — 7,5–12 МБ JSON (1 376 и 2 469 фильмов), первая сборка 1,2–1,3 s, повтор из memo `profile-cache` — 0,1 ms; размер, а не время — следующий кандидат (`filmsIndex`). Время сборки книг/игр (`X-Books-Build-Ms`, `X-Games-Build-Ms`) на боевых данных не замерено: memo по fingerprint'ам не вводится, пока цифры не покажут нужду.
7. Фильмы не отклоняют неизвестные query-параметры (`films/routes.js`), в отличие от §6. Включить `assertOnlyParams` — ломающее изменение (major по §12.1).
8. `version` в `package.json` (1.0.0) — не версия релиза: единственный источник версии — `nix/package.nix` (§12.1). `engines.node` = `>=24`.
9. `devenv shell` пишет «devenv 2.4.0 is newer than devenv input (2.3.1)» и после `devenv update`: тэг `v2.4.0` upstream сам сообщает 2.3.1. Lock не обновлялся.
10. Заявка «Цыганка» 1850 уже лежит в документе с источником `wikidata` и поэтому челленджером не переспрашивается (правило «`wikidata` не переспрашиваем»); такие единичные следы чистятся только руками или будущим флагом `--requestion`.
11. Серия из Wikidata даёт мало: 3 из 37 (8 %) работ без серии в замере; канал оставлен, потому что он не стоит ни одного лишнего запроса, но рассчитывать на него как на источник покрытия нельзя.
12. `v1.5.0` задеплоен 13.11.2026; утром 14.11 очередь бэкфилла ещё догоняла хвост (1 414 → 436 документов, ~170 за прогон): legacy-заявки без источника, совпадающие с годом тиража, стоят в группе ранга 1 и до прохода выглядят в payload как «первое издание» 2020-х. Прогон текущего кода на копии по 23 книгам 2020-х: 11 из 14 legacy исправляются («Чук и Гек» 2021 → 1939, «Ревизор» 2022 → 1836). Остаток без источников (Wikidata без даты у «Искусства войны» Q8251, «Зельда Марш» без ru-метки) правится ручным годом из интерфейса.
13. Ярус `wholeWork` даёт томам год начала серии, если ни Фантлаб, ни метка тома не нашлись («Sailor Moon. Том 2–7» → 1991). Это только заполнение пустого года, но не год тома.
14. API Фантлаба — тестовая фаза (v0.9), условия использования не опубликованы; формат ответа может поменяться. Источник выключается `KINOBOXD_BOOKS_FANTLAB=0`.
15. Ложные заявки, которые раунд не трогает, потому что они `wikidata` и не переспрашиваются: «Цыганка» 1850 (ранее), «Мышеловка» 1945, «Большой куш» 2018 (Wikidata отдаёт другой объект). Гейт рождения автора теперь работает только на **новых** ответах.
16. Псевдонимы на Фантлабе не сводятся: «Чернильно-чёрное сердце» Р. Гэлбрейта у Фантлаба записано за Дж. К. Роулинг и гейт автора его не пропускает.


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

- `nix/package.nix` — пин `fetchFromGitHub` (`rev`, `hash`) + `buildNpmPackage` (`npmDeps.hash`). Пин обновляется **только здесь**. Файл намеренно без комментариев: он же — копия в `~/.nixos/packages/kinoboxd/package.nix`, и его копируют целиком, а не патчат по месту. Симптом «`variable $src or $srcs should point to the source` в `<pname>-<version>-npm-deps`» значит, что в деривации потерян `src` (или `npmDeps`), — сверять весь файл, а не лишние атрибуты.
- `nix/module.nix` — NixOS-модуль `services.kinoboxd`: только Nix-код, комментариев в файле нет (вся операционная семантика — здесь). Сервер `kinoboxd` плюс 11 oneshot-юнитов, все взаимоисключающие через общий `Conflicts=`, все идемпотентные:
  - `kinoboxd-backfill` — агрегат фильмов (`allTargets`: `imdb`, `keywords`, `wikidata`, `rematch`, `collections`, `mcu`); по-таргетные `kinoboxd-backfill-<target>`; таймер `backfillTimer` выкл по умолчанию;
  - `kinoboxd-backfill-books` — первый год публикации: `--limit 200 --pause 2000`, `BOOKS_LITRES_BUDGET=200`, поверх Wikidata-проход (`BOOKS_WIKIDATA_BUDGET` дефолт 300 книг/прогон, модуль его не экспортирует); таймер `booksBackfillTimer` вкл., **hourly** по умолчанию (`daily`/`weekly` — через `booksBackfillTimer.interval`);
  - `kinoboxd-resolve-books` — resolve хвоста LiveLib (`--limit`/`--pause`/`--recheck-days`), внутри того же прохода — Wikidata-этап года; таймер `booksResolveTimer` вкл., **hourly** по умолчанию;
  - `kinoboxd-backfill-manga` — `kinoboxd-books-migrate manga --limit 20 --pause 600` (`booksMangaBackfillLimit`/`booksMangaBackfillPauseMs`); таймер `booksMangaBackfillTimer` вкл., **weekly** по умолчанию;
  - `kinoboxd-backfill-authors` — `kinoboxd-books-migrate authors --wikidata`; таймер `booksAuthorsBackfillTimer` выкл (мост авторов и так default-on в stats).
  Все таймеры — `Persistent = true` (+ `RandomizedDelaySec = "5m"` у книжных), то есть пропущенный тик догоняется на первом же старте после деплоя; интервалы — опции модуля, дефолт указан у каждого пункта выше. Ручной запуск: `sudo systemctl start kinoboxd-backfill-manga`, хвост — `journalctl -u kinoboxd-backfill-manga -f`.
- Лаунчеры `nix/package.nix`: `kinoboxd`, `kinoboxd-backfill`, `kinoboxd-books-backfill`, `kinoboxd-books-resolve`, `kinoboxd-books-migrate` (диспетчер `manga|authors`).
- Личный site-конфиг (`services.kinoboxd`: sops-секреты, порт, state, таймеры) живёт вне репозитория: `~/.nixos/modules/services/kinoboxd/kinoboxd-module.nix` + `~/.nixos/packages/kinoboxd/package.nix`; в repo их нет.
- Переменные: `KINOBOXD_CACHE_DIR`, `KINOBOXD_CACHE_BOOK_DIR`, `KINOBOXD_CACHE_GAMES_DIR`, `KINOBOXD_STATE_DIR`, `KINOBOXD_PASSWORD`, `PORT` (боевой `3000`; в тестах не использовать).
- Текущий пин (`v1.5.1`): `rev = "v1.5.1"` (тэг; коммит тэга `ff232ff`), `hash = sha256-rjDjabOTb/Re/SCyJOmp6Y4MLomEMwnHB9bBmn6e9RI=`, `npmDeps.hash = sha256-3WDQGA32z5UIh/9aJaPMXpKR54bfxyppeE4lITJh5PI=` (не менялся), store `/nix/store/vi14fq2bl4fmbvk30mqd9pni3rlwlw73-kinoboxd-1.5.1`.
- Предыдущие пины: `v1.5.0` — rev `v1.5.0` (коммит `ec1a14f`), store `/nix/store/g8ib9i81ya2aw3a8nn25b20c0bx1fzrs-kinoboxd-1.5.0`; `v1.4.0` — rev `v1.4.0` (коммит `41ba909`), store `/nix/store/5pmlb8nh8nycdmzixzh52cqi9zb1b4gw-kinoboxd-1.4.0`; `v1.3.0` не пинился (тэг `353f7a7` запушен вместе с `v1.4.0`); `v1.2.0` — rev `38d6ef6`, store `/nix/store/gkjpa4gbg7p1bfqxc4qzmlc4iv42j3rj-kinoboxd-1.2.0`; `v1.1.0` — rev `7b5597d…`, store `/nix/store/k2gzh95g3nrczz70lsx4avq2mrb7xmi2-kinoboxd-1.1.0`.
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
  - Изменился `nix/module.nix` (или пакет целиком, не только пин) → готовые `install -Dm644`-команды для `~/.nixos`: модуль → `modules/services/kinoboxd/kinoboxd-module.nix`, пакет → `packages/kinoboxd/package.nix`. «Пин обновлён» без команд — не отчёт.
  - Изменился **только пин** → никаких `install`, но и **никаких «голых» `rev`/`hash`-строк**: в отчёте — адресный патч, где явно сказано, что и куда вставлять, с 1–2 строками контекста до/после. Голый `hash = …;` в теле деривации синтаксически валиден (`buildNpmPackage` — это attrset) и молча заменяет `src`/`npmDeps` на дефолты nixpkgs — такой файл падает с `variable $src or $srcs should point to the source` (прецедент 12.11.2026):

В `nix/package.nix`, блок `source ? fetchFromGitHub {` (аргумент функции, не тело деривации):

```nix
  source ? fetchFromGitHub {
    owner = "hattivatt";
    repo = "kinoboxd";
    rev = "<sha коммита v1.4.2>"; # допустимо и "v1.4.2"
    hash = "sha256-…";
  },
```

В том же файле, внутри `buildNpmPackage (finalAttrs: { … })`, блок `npmDeps = fetchNpmDeps {` (рядом с `src = source;`):

```nix
  npmDeps = fetchNpmDeps {
    inherit (finalAttrs) src;
    hash = "sha256-…"; # меняется только вместе с package-lock.json
  };
```

и отдельно, если меняется, `version = "1.4.2";` — тоже в теле деривации, рядом с `pname`.

  Строка, не изменившаяся с прошлого отчёта, входит в свой блок с пометкой `# без изменений`. Если site-конфиг расходится с `nix/package.nix` формой — в отчёте это сказано явно и рекомендовано скопировать весь файл (`install -Dm644`), а не латать по месту. Признак «`src` не доехал» в логах: drv `npm-deps` назван `<pname>-<version>-npm-deps` (nixpkgs-дефолт) вместо `npm-deps` (наш `fetchNpmDeps`).
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

- **Ничего вне project sandbox.** В первую очередь **`~/.nixos/**`** — агенты никогда не читают, не пишут и не «пинят» эти файлы (прецедент `34bf666`: агент записал пин прямо в `~/.nixos`).
- **Правок в `~/.nixos/**` не делает и отчёт вместо правки.** Даже если просьба звучит как «посмотри/проверь/поправь»: агенту не даются ни чтение, ни запись. Вместо этого в отчёт идёт то, что человек применит сам: (а) готовые `install -Dm644`-команды, (б) если нужно поменять всего несколько строк — **адресный патч: какой файл, какой блок (`source ? fetchFromGitHub { … }`, `npmDeps = fetchNpmDeps { … }`, `version = …;`), вставлять внутрь него, с 1–2 соседними строками контекста до/после**, (в) диагностика по симптому из лога и проверка тем же nixpkgs, но без копии конфига в коде/ответе. Прецедент 12.11.2026: агент на просьбу «проверь, что там» прочитал файл и перезаписал `packages/kinoboxd/package.nix`; просьба посмотреть — не разрешение на правку.
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

### 13.8. Комментарии в коде

- **Комментариев в коде не оставлять.** Ни шапок модулей, ни rationale-блоков, ни docstring'ов, ни закомментированного кода, ни TODO. Код объясняет себя именами и структурой; «почему так» — в этом файле (§5/§7/§10) или в `contracts/*`, а не в исходнике.
- Существующие комментарии не расширяются. Правя функцию, комментарии вокруг неё удалять, а не обновлять; массовое вычищение чужого файла — отдельный раунд, а не побочный эффект.
- Правило пришло из глобальной конфигурации агента и потому сильнее локальной привычки репозитория: «как в соседнем файле, с комментариями» — не основание.
- Единственное исключение — синтаксически обязательные директивы (`# shellcheck`, `// eslint-disable`, shebang): это не объяснения, а инструкции инструментам.

### 13.7. Что делать при противоречии правила и здравого смысла

1. Остановиться до необратимого действия (push, merge, мутация боевого кэша).
2. Сообщить: какое правило, в чём конфликт, предложение и что будет сделано по умолчанию.
3. Правило меняется **через этот файл**, а не разовым исключением в коде/отчёте.
4. Принятое допущение — в отчёт.
