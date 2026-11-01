# Epic Games Store — M6b контракт (server/games/epic*)

Статус: **реализовано в ветке `agent/games-m6b`**, live-логин в этом раунде не
выполнялся (headless, нет пользовательского токена). Все проверки — моки и
фикстуры (`test/fixtures/games/epic/`). Живой smoke требует браузера
пользователя: `POST /api/games/epic/auth` → открыть `verificationUriComplete` →
дождаться `authorized` → `POST /api/games/epic/import`.

Источник фактов — `ИГРЫ-АРХИТЕКТУРА.md` §14 (research 01.11.2026): device-code
OAuth, `library/api/public/items` (cursor), `playtime/account/{id}/all`
(**секунды**, без `lastPlayed`), catalog bulk (нужен токен), публичный
`productmapping` как fallback slug.

## 1. Модель

Epic — **вторичная библиотека того же владельца** (§14.4), не второй журнал:

- владелец — Steam-профиль `steam-<steamid64>`; Epic-аккаунт привязывается к
  нему через `owner` при auth/import;
- один владелец → один Epic-аккаунт (`owner_mismatch` при попытке второго);
- Steam-журнал (`summary.totalHours`, top, достижения) **не меняется**;
- часы Epic живут отдельно: `hoursBySource.epic`;
- union по `workKey` — **не здесь** (M6c); этот слой отдаёт `exportedGames`
  с `workKey: null`, `steamAppId: null`;
- `lastPlayed` у Epic не существует в модели — не выдумывается (`null`);
- снимок при истёкшем токене остаётся: `status: 'auth_expired'` + `fetchedAt`,
  а не нули.

## 2. Эндпоинты (`/api/games/epic/*`, под общим auth-gate)

| Метод | Путь | Body/Query | Ответ |
|---|---|---|---|
| GET | `/status?owner=steam-<id64>` | owner или accountId, иначе все аккаунты | статус, `summary`, `hoursBySource`, `ownedBySource`, `libraries[]`, redacted token |
| POST | `/auth` | `{ owner?, label? }` | `201 { authId, status:'pending', userCode, verificationUri, verificationUriComplete, expiresIn, intervalMs, owner }` |
| GET | `/auth/:authId` | — | сессия; `pending` опрашивается здесь же (rate-limit по `intervalMs`) |
| DELETE | `/auth/:authId` | — | отмена |
| POST | `/import` | `{ accountId?, owner?, force?, label? }` | job (201/200) |
| POST | `/refresh` | `{ accountId?, owner? }` | job с `force: true` |
| GET | `/import/:jobId` | — | job |
| GET | `/import/status?id=` | id | job |
| GET | `/exported?owner=…\|accountId=…` | — | контракт для M6c: `games[]` |
| POST | `/disconnect` | `{ accountId?, owner? }` | удаляет локальный токен; снимок остаётся |

Строгий query-контракт: неизвестный параметр → `400 unexpected_parameter`
(как в книгах/фильмах).

Ошибки: `epic_not_connected` 400, `epic_auth_expired` 401, `owner_mismatch`
400, `epic_account_required` 400, `epic_rate_limited` 429,
`epic_unreachable`/`epic_http_error` 502, `epic_library_empty` 400.

## 3. Контракт для интеграции (M6c)

`GET /api/games/epic/exported?owner=steam-<id64>` и
`buildEpicLayer({ ownerKey })` (`server/games/epic-layer.js`) отдают:

```jsonc
{
  "source": "epic",
  "contractVersion": 1,
  "owner": "steam-7656…",
  "accountId": "<epic accountId>",
  "status": "ok|stale|auth_expired|not_imported|not_connected",
  "hoursBySource": { "steam": 5862.6, "epic": 10.5 },   // НЕ складывать
  "ownedBySource": { "steam": 340, "epic": 4 },
  "summary": {
    "ownedCount": 4,
    "playedCount": 2,
    "hours": 10.5,
    "totalTimeSec": 37800,
    "totalMinutes": 630,
    "externalOwnedCount": 4,          // Epic отдельно от Steam
    "externalHours": 10.5,
    "libraryExternalNumberCount": 4,  // отдельный счётчик, не в Steam total
    "playtimeCoverage": 75.0
  },
  "games": [{
    "source": "epic",
    "appName": "TheWitcher3",
    "catalogItemId": "9d2d0e…",
    "namespace": "ns-witcher",
    "slug": "the-witcher-3-wild-hunt",
    "name": "The Witcher 3: Wild Hunt",
    "developer": "CD PROJEKT RED",
    "publisher": "CD PROJEKT RED",
    "totalTimeSec": 36000,
    "totalMinutes": 600,
    "hours": 10,
    "platforms": ["windows", "mac"],
    "workKey": null,        // заполняет M6c через Wikidata P6278/P2725/P1733
    "steamAppId": null
  }]
}
```

Правила для M6c:

1. Union — по `workKey`; Epic-запись без моста остаётся отдельной
   (`secondaryOnlyWorks`), не склеивается по названию молча.
2. `hoursBySource.steam` и `hoursBySource.epic` не суммировать; для одной игры
   часы Steam и Epic не складывать (двойной счёт).
3. `games[].totalMinutes` — уже нормализованные минуты (`totalTime` секунды);
   `hours` — один знак после запятой.
4. `status !== 'ok'` → UI показывает дату снимка и «требуется переподключение»,
   а не 0.
5. Слот «Подключения»: Epic-карточка уже рендерится `public/js/games-epic.js`
   в `#games-connections`; GOG-слот M6a добавляется рядом, экран не
   дублируется.

## 4. Кэш и токены

```
cache-games/
  profiles/epic-<accountId>.json      displayName/ownerKey/connectedAt/label
  library/epic-<accountId>.json       merged snapshot (games/counts/fingerprint)
  playtime/epic-<accountId>.json      artifactId → totalTimeSec/totalMinutes
  catalog/<catalogItemId>.json        catalog bulk (title/slug/dev/pub)
  catalog/productmapping.json         appName → slug (public, 7 d)
  tokens/epic-<accountId>.json        0600, dir 0700 (эквивалент пароля)
```

TTL: library/playtime 24 ч, catalog 180 д, productmapping 7 д. Свежесть
влияет только на reuse импорта; устаревший снимок отдаётся со `status: 'stale'`.

Токен-стор (`epic-token-store.js`) пишет секрет атомарно с
`O_CREAT|O_EXCL|O_NOFOLLOW` и mode 0600 (без окна world-readable), чинит
случайный `chmod 0644`, не читает симлинк, не пишет по симлинку. Наружу
отдаётся только `redactTokens()`: `hasAccessToken`/`hasRefreshToken`/expiry.

## 5. Сеть, лимиты, деградация

- пауза 300 мс (`GAMES_EPIC_PAUSE_MS`) между запросами;
- breaker 30 мин на 403/429 (`state/games-breaker.json`, общий с Steam);
- 5xx/сеть → `epic_unreachable` + `deferred: true`: импорт **не** затирает
  снимок, job получает `status: 'deferred'`;
- 401 → `epic_auth_expired`, токен-файл помечается `lastAuthError`, job
  `failed`, старый снимок цел;
- device-code: `authorization_pending` → pending, `slow_down` → interval+,
  `expired`/`invalid_grant` → expired/failed;
- хосты дрейфуют: account `prod03` → fallback `prod`; entitlement —
  `entitlement-public-service-prod08` (не `entitlements-…prod06`, тот не
  резолвится); переопределяются env `GAMES_EPIC_*_HOST`;
- client credentials лаунчера — публичные (Legendary/Heroic), но значения не
  печатаются; переопределяются `EPIC_CLIENT_ID`/`EPIC_CLIENT_SECRET`.

## 6. Фильтры владения

- entitlements — первичный источник; library items — fallback/merge
  (`appName`, `platform`, `acquisitionDate`);
- выбрасываются: `namespace === 'ue'` (Unreal Engine), `sandboxType ===
  'PRIVATE'`, mobile-only (`platform` только Android/iOS), неактивные
  (`active: false` / `status !== ACTIVE`), consumable;
- запись без `catalogItemId` не попадает в счётчик (но считается в
  `counts.excluded.missingCatalogId`);
- пустой `platform` = «неизвестно», запись сохраняется (правило —
  «Android-only», а не «нет поля»).

## 7. Что не проверено живьём

- фактический ответ `deviceAuthorization`/`device_code` на боевом аккаунте
  (по EpicResearch/Legendary; в тестах — фейковый сервер);
- точность `totalTime` и охват сессий (Playnite: секунды);
- покрытие catalog bulk и `productmapping` (1 283 записи — неполное);
- поведение entitlement-хоста при ротации (prod08 → другой);
- rate-limit Epic на чтение библиотеки (заложены пауза/breaker, но не
  измерены).

## 8. Тесты

`npm test` (Node 24, порт 7084 для HTTP-тестов):

- `test/games-epic-token-store.test.js` — 0600/0700, атомарность, симлинки,
  починка mode, redaction;
- `test/games-epic-client.test.js` — device-code (pending/slow_down/expired/
  authorized), refresh, 401/429/5xx, cursor-пагинация, секунды→минуты,
  catalog-чанки, маскировка;
- `test/games-epic-import.test.js` — цепочка, фильтры, deferred/auth_expired,
  reuse/force, owner_mismatch, `hoursBySource` не сливается со Steam;
- `test/games-epic-auth.test.js` — сессии, 0600-токен, owner binding, expiry;
- `test/games-epic-routes.test.js` — HTTP-контракт, redaction, strict query,
  disconnect со сохранением снимка.

Итог раунда: 734 теста, 732 pass, 2 skip, 0 fail.
