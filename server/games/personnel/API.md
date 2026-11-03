# API «Персоналии» (M3) — контракт для фронта

Реализация: `server/games/personnel/` (backend-раунд M3 + раунд
«раздельные роли / WD-триггер» 01.11.2026). Роутер смонтирован в
`server/index.js` на `/api/games` рядом с M1-роутером; пути `/personnel`,
`/personnel/status` и `/override` не пересекаются с M1.

**Границы документа.** Роуты, строгий query и HTTP-коды — `contracts/api.md`;
здесь остаётся то, чего там нет: семантика ролей, форма payload'а, правила
запуска пасса и ограничения источников.

## Роли: `developer` и `publisher` — разные ответы

До 01.11.2026 студии были одной категорией (`studio` = разработчики +
издатели). Теперь это **две роли**, обе выбираемы в селекте, обе собираются из
двух источников:

| Роль | Steam `appdetails` | Wikidata | По умолчанию |
|---|---|---|---|
| `developer` | `developers[]` | `P178` | **да** |
| `publisher` | `publishers[]` | `P123` | нет |
| `composer` | — | `P86` | нет |
| `designer` | — | `P287` | нет |
| `writer` | — | `P58` (low) | нет |
| `artist` | MobyGames | — (нестабильно) | нет |
| `programmer` | — | `P943` | нет |
| `producer` | — | `P162` | нет |
| `director` | — | `P57` | нет |
| `creator` | — | `P170` (low) | нет |
| `sound`, `voice` | MobyGames | — | нет |

**Backward-compat:** старый токен `role=studio` — документированный алиас
`developer` (ответ: `role: "developer"`, `roleRequested: "studio"`,
`roleAlias: "studio"`). Кэшированный фронт, который ещё шлёт `studio`, не
получит 400 и не сломается. Также принимаются `studios` → `developer`,
`dev` → `developer`, `pub` → `publisher`.

Студия, указанная и разработчиком, и издателем, — **один элемент** с
`roles: ["developer","publisher"]`; но `count`/`hours` считаются только по
играм, где у неё есть **запрошенная** роль. Поэтому `role=developer` и
`role=publisher` дают разные списки и разные числа.

## `GET /api/games/personnel`

Роут и коды ошибок — `contracts/api.md`. Семантика параметров:

| Параметр | Обязателен | Значения | По умолчанию |
|---|---|---|---|
| `profile` | да | `steam-<steamid64>`, ровно один | — |
| `role` | нет | `developer`, `publisher`, `composer`, `designer`, `writer`, `artist`, `programmer`, `producer`, `director`, `creator`, `sound`, `voice` (+ алиасы `studio`/`studios`/`dev`/`pub`) | `developer` |
| `sort` | нет | `hours`, `count`, `completion`, `name` | `hours` |
| `limit` | нет | целое 1–50, длина `games[]` в каждом элементе | `5` |

Неизвестный параметр → `400 unexpected_parameter`; неизвестная роль →
`400 invalid_role` (текст перечисляет принятые роли и алиас `studio`);
сортировка → `400 invalid_sort`; `limit` → `400 invalid_limit`;
отсутствующий/чужой профиль → `400 profile_required|invalid_profile|unknown_profile`.

Ответ не кэшируется браузером: данные меняются после импорта/обогащения.

### Payload (§5.3 архитектуры)

```jsonc
{
  "profile": "steam-76561198038369983",
  "role": "developer",              // каноническая роль
  "roleRequested": "studio",        // что реально прислал клиент ("" → роль)
  "roleAlias": "studio",            // null, если запрошена каноническая роль
  "sort": "hours",
  "roles": {                        // контракт для селекта фронта
    "accepted": ["developer", "publisher", "composer", "designer", "writer",
                 "artist", "programmer", "producer", "director", "creator",
                 "sound", "voice"],
    "default": "developer",
    "aliases": { "studio": "developer", "studios": "developer",
                 "dev": "developer", "pub": "publisher" },
    "studio": ["developer", "publisher"],
    "people": ["composer", "designer", "writer", "artist", "programmer",
               "producer", "director", "creator", "sound", "voice"]
  },
  "items": [
    {
      "id": "wd:Q1172164",              // wd:Q… | moby:123 | name:<slug>
      "name": "CD PROJEKT RED",         // canonical EN, иначе RU
      "aliases": ["CD Projekt RED"],
      "qid": "Q1172164",
      "mobyId": null,
      "roles": ["developer", "publisher"],  // все роли сущности
      "count": 1,                       // игр с ЗАПРОШЕННОЙ ролью
      "hours": 107.0,
      "hoursShare": 0.0183,
      "avgCompletion": 50,              // null, если достижений нет
      "games": [{ "appid": 292030, "name": "The Witcher 3: Wild Hunt", "hours": 107.0 }],
      "ambiguous": false,
      "sources": ["steam-store", "wikidata"]
    }
  ],
  "totals": { "games": 340, "secondaryWorks": 0, "hours": 5862.6, "excludedNonGame": 0 },
  "coverage": {
    "gamesTotal": 340,
    "gamesWithDetails": 340,
    "detailsPercent": 100,
    "gamesWithCredits": 119,
    "percent": 35,                     // «Кредиты: 35%»
    "gamesWithStudios": 296,
    "studioPercent": 87,
    "gamesWithDevelopers": 290,        // role=developer
    "developerPercent": 85,
    "gamesWithPublishers": 240,        // role=publisher
    "publisherPercent": 71,
    "byRole": { "composer": 97, "designer": 28, "writer": 15, "artist": 0,
                "programmer": 9, "producer": 19, "director": 19,
                "creator": 1, "sound": 0, "voice": 0 },
    "byStudioRole": { "developer": 290, "publisher": 240 },
    "wikidata": {                      // бейдж «WD: …» (§8.3)
      "state": "ok",                   // ok | never_run | unavailable | cooldown | disabled
      "badge": null,                   // null | "WD: не запущено" | "WD: недоступно" | "WD: выключено"
      "reason": null,                  // код провайдера: wikidata_429, never_run, cooldown, disabled_by_env
      "enabled": true,
      "lastSuccessAt": "2026-11-01T12:00:00.000Z",
      "lastAttemptAt": "2026-11-01T12:00:00.000Z",
      "lastError": null,
      "disabledUntil": null
    }
  },
  "pending": {
    "details": 0,                      // игры без details/<appid>.json
    "credits": 221,                    // игры без людей-кредитов
    "secondary": 0,                    // работы вне Steam без документа кредитов
    "staleLabels": 0,                  // документы, собранные по старому правилу имён (§4.2)
    "running": true,                   // пасс WD/импорт идёт прямо сейчас
    "jobId": "games-personnel-…",      // id пасса, если running/started
    "reason": "started"                // см. таблицу ниже; null — всё есть
  },
  "sources": {
    "credits": ["steam-store", "wikidata"],
    "wikidata": { "state": "ok", "badge": null, "enabled": true, "disabledUntil": null, "...": "как в coverage.wikidata" },
    "mobygames": {
      "enabled": false, "configured": false, "source": null,
      "reason": "key_missing", "budget": 100, "budgetUsed": 0,
      "pauseMs": 1100, "breaker": null
    }
  },
  "meta": {
    "builtAt": "2026-11-01T12:00:00.000Z",
    "buildMs": 19,
    "gamesConsidered": 340,
    "completionAvailable": true,
    "detailsSource": "cache-games/details",
    "creditsCache": "cache-games/personnel",
    "libraryPartial": false,
    "libraryFetchedAt": "2026-11-01T11:00:00.000Z"
  }
}
```

### `pending.reason` — почему кредитов ещё нет

| Значение | Что значит | Что делать UI |
|---|---|---|
| `null` | всё есть (`credits: 0`, `staleLabels: 0`) | ничего |
| `running` | пасс персоналий уже идёт | показать «собираем…», повторить запрос |
| `waiting_details` | идёт store-enrich, пасс ждёт `details` | показать «обогащаем детали…» |
| `started` | роут только что запустил пасс (fire-and-forget) | показать «собираем…», повторить через несколько секунд |
| `recent_cooldown` | пасс уже прогонялся < 10 мин назад | просто бейдж покрытия |
| `wikidata_not_run` | WD ещё не спрашивали, Moby без ключа | «WD: не запущено» |
| `wikidata_cooldown` | WD в паузе после 403/429/5xx | «WD: недоступно» + `disabledUntil` |
| `wikidata_unavailable` | WD отвечал ошибкой | «WD: недоступно» + `reason` |
| `sources_disabled` | `KINOBOXD_GAMES_WD=off` и нет ключа Moby | «WD: выключено» |
| `details_pending` | нет ни одного `details/<appid>.json` — WD по appid спрашивать нечего | кнопка «Обогатить» (M2) |
| `auto_disabled` | сервер запущен с `autoPersonnel:false` (тесты/отладка) | — |
| `labels_stale` | кредиты полны, но имена собраны по старому правилу меток (`labelRule`) — пасс перезапишет их один раз | ничего, повторить запрос через несколько секунд |
| `lock_busy` | пасс идёт в другом процессе (`personnel.lock`) | повторить позже |
| `kick_failed` | запуск пасса упал (см. лог сервера) | повторить позже |

### Семантика полей (важно для UI)

- **`count`** — число игр, где человек/студия имеет **запрошенную роль**.
  Для `role=developer` издатель той же компании не добавляет игру в счёт.
- **`hours`** — сумма часов этих игр; один хит перевешивает десять малых.
- **`hoursShare`** — доля от `totals.hours` (часы всех учтённых игр профиля),
  округление до 4 знаков.
- **`avgCompletion`** — среднее `achieved/total` по играм автора, у которых есть
  достижения; `null`, если ни у одной нет. **Не 0.**
- **`ambiguous: true`** — одно имя принадлежит разным QID (John Smith). Такие
  элементы нельзя схлопывать.
- **`coverage.percent`** — бейдж «Кредиты: N%» (игры с людьми / все учтённые).
  `developerPercent`/`publisherPercent` — отдельные бейджи ролей.
- **`coverage.wikidata.badge`** — готовый текст «WD: не запущено» /
  «WD: недоступно» / «WD: выключено» (`null` = скрыть). `reason` — код
  провайдера, `disabledUntil` — до какого времени пауза.
- **`pending`** — честная неполнота; `0` — всё есть. `running`/`reason`
  описывают, что делает сервер, чтобы виджет не показывал «пусто» молча.
- **`sources.mobygames`** — только флаги/источник ключа, **никогда значение**.
- **`meta.libraryPartial`** — библиотека без `STEAM_API_KEY` (только профиль).

### Работы вне Steam (03.11.2026)

GOG/Epic-эксклюзивы того же владельца (например, Alan Wake 2) входят в
`items` наравне со Steam-играми, но с `appid: null`:

- `items[].games[]` для такой работы несёт `workKey` (`epic:<catalogItemId>` /
  `gog:<gogGameId>`) и `secondaryOnly: true`; у Steam-строк этих ключей нет
  (payload остаётся аддитивным).
- студии берутся из store-документов (`developers`/`publishers`, источники
  `epic-store`/`gog-store`), люди — из Wikidata, только если мост
  `links/secondary.json` уже дал QID. Кредиты пишутся в
  `cache-games/personnel/work-<safeKey(workKey)>.json`.
- часы работы — часы второго магазина (union `displayMinutes`); Steam-журнал
  не суммируется повторно, потому что сюда попадают только `secondaryOnly`
  работы.
- `totals.secondaryWorks` — сколько таких работ; `pending.secondary` — у
  скольких ещё нет документа кредитов (ленивый kick запускает пасс).

## Откуда берутся кредиты (WD-триггер)

Ключевой фикс 01.11.2026. Раньше `enrichPersonnel()` был доступен только
ручному CLI (`node server/games/personnel/backfill.js`), а
`GET /api/games/personnel` читает кэш и никогда не ходит в сеть. На проде CLI
никто не запускал → в `cache-games/personnel/` пусто → виджет навсегда видел
только студии Steam («композиторы не приехали»). Теперь пасс запускается сам:

1. **Импорт / refresh** (`POST /api/games/import`, `/import/steam`,
   `/refresh`): после store-enrich стартует `kickPersonnelQuietly`. Ответ
   импорта содержит `personnelJobId` / `personnelSkipped`.
2. **`POST /api/games/enrich`**: рядом с enrich-джобой стартует пасс
   персоналий; ответ содержит `personnelJobId`.
3. **Ленивый запуск из `GET /api/games/personnel`**: если кредиты неполные и
   пасс не идёт — fire-and-forget запуск, ответ **не блокируется**:
   `pending.running: true`, `pending.reason: "started"`, `pending.jobId`.
   Следующий запрос отдаёт уже собранные кредиты.
4. **Порядок гарантирован**: пасс ждёт завершения store-enrich
   (`enrichJobs.whenIdle()`), иначе `details/<appid>.json` ещё нет и
   обогащать нечего.
5. **Один пасс за раз**: в процессе — очередь, между процессами — файловый
   лок `<state>/games/personnel.lock` (CLI/таймер vs сервер). Занятый лок →
   джоба `skipped`, `skipped: "lock_busy"`, без запросов к WDQS.
6. **Coalescing**: повторный `kick` во время работы возвращает тот же `jobId`;
   повторный ленивый kick в течение 10 минут не перезапускает пасс
   (`recent_cooldown`). Явный импорт/refresh/enrich этот лимит **обходит**
   (`forceKick`): это действие пользователя, а не фоновый опрос.
7. **Полит-корректность WDQS не меняется**: один SPARQL-батч на ≤450
   appid/QID, пауза между батчами, breaker 30 мин на 403/429/5xx
   (`wikidata.js`). Лок персоналий — отдельный от enrich, счётчики не
   пересекаются.

## `GET /api/games/personnel/status?id=…`

Статус пасса (для «собираем кредиты…» и диагностики). `id` обязателен,
неизвестный → `404 unknown_job`.

```jsonc
{
  "jobId": "games-personnel-…", "id": "games-personnel-…",
  "job": "games-personnel", "source": "wikidata",
  "profile": "steam-76561198038369983",
  "status": "done",          // running | done | failed | skipped
  "stage": "done",           // queued | waiting_details | fetching | done | failed | skipped
  "done": true, "reused": false, "force": false, "limit": 500,
  "games": 340, "updated": 297, "skippedFresh": 0, "pendingDetails": 0,
  "wdQueries": 1, "wdSkipped": null, "wdDisabledUntil": null,
  "mobyRequests": 0, "enrichWait": "idle",
  "errors": [], "skipped": null, "code": null, "error": null,
  "startedAt": 1762000000000, "finishedAt": 1762000037000, "elapsedMs": 37000
}
```

## `POST /api/games/override`

Ручная склейка/алиас (ИГРЫ §5.5). Пишет в
`cache-games/personnel-overrides.json` (не в `personnel/<appid>.json`), resolve
его не перетирает; сохранение union-safe — старые правки не теряются.

```jsonc
// request
{ "type": "person", "action": "merge", "from": "Alex Doe", "to": "Alexander Doe" }
// type: person|studio, action: merge|split|alias
```

- `merge` — считать `from` тем же человеком, что `to`; `from` остаётся алиасом.
- `alias` — добавить `from` в алиасы `to` (без объединения весов).
- `split` — отменить merge и пометить имя `ambiguous` (два QID не сливаются).

Ответ `200`:

```jsonc
{ "ok": true, "type": "person", "action": "merge", "from": "Alex Doe",
  "to": "Alexander Doe",
  "overrides": { "updatedAt": "…", "merges": 1, "aliases": 0, "splits": 0 } }
```

Ошибки: `400 invalid_override_type|invalid_override_action|invalid_override_from|invalid_override_to`.

## Пустое состояние

`items: []` — валидный ответ (нет details/кредитов). UI показывает бейдж
покрытия и «данных пока нет», а не нули. Скрывать блок по `items.length === 0`.

## Ограничения (честно)

- **MobyGames без ключа** — люди только из Wikidata; `artist`, `sound`, `voice`
  пустые (у Wikidata нет стабильного свойства художника, §2.4).
- **Wikidata неровная**: у Witcher 2 — 2 композитора, у Witcher 1 (Enhanced
  Edition) — ни одного; у Pathologic — композитор, 2 дизайнера, режиссёр,
  программист. Это не баг, это покрытие источника.
- **`creator` (P170) и `writer` (P58)** — `confidence: 'low'`.
- **Компания в P162 (producer)** не становится человеком, если тот же QID уже
  студия этой игры (дедуп в `wikidata.js`).
- **Имя студии = язык-нейтральная метка.** `mul`-метка Wikidata главнее
  английской, когда английская — лишь обрывок (`Q3539040`: en «Development
  Studio», `mul` «Paradox Development Studio»). Документ помнит правило, по
  которому собран (`labelRule`), поэтому кэш старого правила перезапрашивается
  один раз (`pending.staleLabels`), а не живёт с обрывком 90 дней.
- **Юрформа — не часть имени.** Для склейки снимаются хвостовые `Inc./Ltd/
  LLC/GmbH/Corp./Co./S.A./…` («Valve Corporation» ↔ «Valve»), но **не**
  `Studio`/`Games`/`Interactive`. Склейка идёт только когда ядро имени
  подтверждено ровно одним QID/Moby id; два QID не сливаются никогда.
- **`links/<appid>.json`** пока не пишет никто (M2): live-прогон резолвит игру
  через `P1733` (Steam appid) в том же SPARQL. Когда M2 начнёт писать `links`,
  приоритет у `links.qid`.
- **details от M2**: принимаются `developers`/`publishers`; написание
  `developirts` тоже принято (терпимость к контракту M2).
- **Негативный кэш 90 дней**: «WD ничего не знает об этой игре» запоминается,
  поэтому повторный пасс не тратит WDQS-бюджет.
