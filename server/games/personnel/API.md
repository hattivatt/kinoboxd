# API «Персоналии» (M3) — контракт для фронта

Реализация: `server/games/personnel/` (backend-раунд M3). Роутер
самодостаточный; интеграционный раунд монтирует его рядом с M1-роутером:

```js
// server/index.js (делает оркестратор, не этот раунд)
app.use('/api/games', require('./games/personnel/routes-personnel'));
```

Монтировать **после** `/api/games` M1: пути `/personnel` и `/override` не
пересекаются с существующими, порядок не важен, но один `app.use` на оба
роутера проще.

## `GET /api/games/personnel`

| Параметр | Обязателен | Значения | По умолчанию |
|---|---|---|---|
| `profile` | да | `steam-<steamid64>`, ровно один | — |
| `role` | нет | `studio`, `developer`, `publisher`, `composer`, `designer`, `writer`, `artist`, `programmer`, `producer`, `director`, `creator`, `sound`, `voice` | `studio` |
| `sort` | нет | `hours`, `count`, `completion`, `name` | `hours` |
| `limit` | нет | целое 1–50, длина `games[]` в каждом элементе | `5` |

Неизвестный параметр → `400 unexpected_parameter`; неизвестная роль →
`400 invalid_role`; сортировка → `400 invalid_sort`; `limit` → `400 invalid_limit`;
отсутствующий/чужой профиль → `400 profile_required|invalid_profile|unknown_profile`.
Ответ кэшируется браузером не должен: данные меняются после импорта/обогащения.

`role=studio` — все студии (роли `developer` и/или `publisher` в одном элементе).
`role=developer|publisher` — только студии с этой ролью. Остальные роли — люди.
Студии **всегда первыми**: это отдельный запрос/блок, не смешивается с людьми.

### Payload (§5.3 архитектуры)

```jsonc
{
  "profile": "steam-76561198038369983",
  "role": "composer",
  "sort": "hours",
  "items": [
    {
      "id": "wd:Q19005369",            // wd:Q… | moby:123 | name:<slug>
      "name": "Marcin Przybyłowicz",   // canonical EN, иначе RU
      "aliases": ["Марцин Пшибылович"],
      "qid": "Q19005369",              // null, если QID нет
      "mobyId": null,                  // null, если Moby не дал id
      "roles": ["composer"],           // все роли человека (массив)
      "count": 2,                      // игр библиотеки с этой ролью
      "hours": 107.4,                  // сумма playtime_forever / 60, 0.1 ч
      "hoursShare": 0.0183,            // доля от часов всех учтённых игр
      "avgCompletion": 50,             // % достижений, null если данных нет
      "games": [                       // top-N по часам (N = ?limit)
        { "appid": 292030, "name": "The Witcher 3: Wild Hunt", "hours": 107.0 }
      ],
      "ambiguous": false,              // true: одно имя, разные QID
      "sources": ["wikidata"]          // steam-store | wikidata | mobygames
    }
  ],
  "totals": { "games": 340, "hours": 5862.6, "excludedNonGame": 0 },
  "coverage": {
    "gamesTotal": 340,
    "gamesWithDetails": 0,
    "detailsPercent": 0,
    "gamesWithCredits": 119,           // игры, где есть хотя бы один человек
    "percent": 35,                     // «Кредиты: 35%»
    "gamesWithStudios": 296,
    "studioPercent": 87,
    "byRole": { "composer": 97, "designer": 28, "writer": 15, "artist": 0,
                "programmer": 9, "producer": 19, "director": 19,
                "creator": 1, "sound": 0, "voice": 0 }
  },
  "pending": { "details": 340, "credits": 221 },
  "sources": {
    "credits": ["steam-store", "wikidata"],
    "wikidata": { "enabled": true, "disabledUntil": null },
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
    "completionAvailable": false,
    "detailsSource": "cache-games/details",
    "creditsCache": "cache-games/personnel",
    "libraryPartial": false,
    "libraryFetchedAt": "2026-11-01T11:00:00.000Z"
  }
}
```

### Семантика полей (важно для UI)

- **`count`** — число игр, где человек/студия имеет **запрошенную роль**
  (для `role=studio` — любая студийная роль). Это не «число упоминаний».
- **`hours`** — сумма часов этих игр; один хит перевешивает десять малых.
- **`hoursShare`** — доля от `totals.hours` (часы всех учтённых игр профиля),
  округление до 4 знаков. Не доля от «всех часов Steam» при `includeFree=0` —
  параметра фильтра у персоналий нет.
- **`avgCompletion`** — среднее `achieved/total` по играм автора, у которых есть
  достижения; `null`, если ни у одной нет. **Не 0.** Если
  `meta.completionAvailable === false` — виджет completion не рисуется.
- **`ambiguous: true`** — одно имя принадлежит разным QID (John Smith). Такие
  элементы нельзя схлопывать и не стоит ставить в топ без ручного merge.
- **`sources`** — происхождение записи; у студии Steam+Wikidata оба источника.
- **`coverage.percent`** — бейдж «Кредиты: N%» (игры с людьми / все учтённые).
  `studioPercent` — отдельный бейдж для студий (обычно 100% после M2).
- **`pending`** — честная неполнота: `details` = игры без `details/<appid>.json`
  (M2 ещё не обогатил), `credits` = игры без людей-кредитов. `0` — всё есть.
- **`sources.mobygames`** — только флаги/источник ключа, **никогда значение**.
  `enabled:false, reason:'key_missing'` — штатное состояние этого раунда.
- **`meta.libraryPartial`** — библиотека без `STEAM_API_KEY` (только профиль).

### Пустое состояние

`items: []` — валидный ответ (нет details/кредитов). UI показывает бейдж
покрытия и «данных пока нет», а не нули. Скрывать блок по `items.length === 0`.

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

## Что появится после интеграции

- `GET /api/games/game/:appid` должен отдавать `personnel` из
  `personnelForGame(appid)` (студии + люди + `pending`), а не `null` из M1.
- В `/api/games/stats` оркестратор добавит `summary.metadata.creditsResolved/percent`
  (из `coverage`) — этот раунд `stats.js` не трогает.

## Ограничения (честно)

- **MobyGames без ключа** — люди только из Wikidata; `artist`, `sound`, `voice`
  пустые (у Wikidata нет стабильного свойства художника, §2.4).
- **Wikidata неровная**: у Witcher 2 — 2 композитора, у Witcher 1 (Enhanced
  Edition) — ни одного; у Pathologic — композитор, 2 дизайнера, режиссёр,
  программист. Это не баг, это покрытие источника.
- **`creator` (P170) и `writer` (P58)** — `confidence: 'low'`; P58 — свойство
  сценариста кино, для игр применимо не всегда. UI может не показывать `low`.
- **Компания в P162 (producer)** не становится человеком, если тот же QID уже
  студия этой игры (дедуп в `wikidata.js`); компания-«продюсер» без dev/pub
  остаётся человеком — известный шум Wikidata.
- **`links/<appid>.json`** пока не пишет никто (M2): live-прогон резолвит игру
  через `P1733` (Steam appid) в том же SPARQL. Когда M2 начнёт писать `links`,
  приоритет у `links.qid` (резолв один раз, §4.1).
- **details от M2**: принимаются `developers`/`publishers`; написание
  `developirts` тоже принято (терпимость к контракту M2, не догадка о данных).
