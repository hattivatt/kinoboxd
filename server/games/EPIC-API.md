# Epic Games Store — M6b контракт (server/games/epic*)

Статус: **M6b + фикс-раунд 01.11.2026 (authorization code)**. Живой smoke требует
браузера пользователя: `GET /api/games/epic/auth-url` → войти на
epicgames.com → скопировать `code` со страницы `/id/api/redirect` →
`POST /api/games/epic/connect { code, owner }` → импорт стартует сам.

**Device-code больше не используется.** Живая проверка 01.11.2026 (анонимные
запросы, без аккаунтов): `launcherAppClient2` (Legendary) → `401
authentication_failed` (1032); `fortnitePCGameClient` (EpicResearch) → `400
unsupported_grant_type` (1016, «your client does not have the proper grant_type
for access»). Это и есть прод-симптом «400 на
`/account/api/oauth/deviceAuthorization`»: grant закрыт для **всех публичных**
клиентов (оставлен консолям), а не «неверный заголовок». Хосты
`account-public-service-prod03` и `…-prod` резолвятся в один и тот же
weighted-сервис — дрейф хоста тут ни при чём.

Источник фактов — `ИГРЫ-АРХИТЕКТУРА.md` §14 (research 01.11.2026) +
EpicResearch (device_code.md, auth_clients.md) и Legendary/Heroic:
`library/api/public/items` (cursor), `playtime/account/{id}/all`
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
| GET | `/auth-url` | — | `{ url, clientSource, instructions }` — официальная страница входа Epic (без сетевого запроса) |
| POST | `/connect` | `{ code, owner?, label? }` | `{ connected:true, accountId, displayName, owner, authMethod:'authorization_code', importJobId }`; `code` — сам код **или вся ссылка** `/id/api/redirect?code=…` |
| POST | `/auth` | `{ owner?, label? }` | legacy device-code: теперь ожидаемо `400 epic_device_grant_unavailable` (Epic 1016) |
| GET | `/auth/:authId` | — | сессия device-code (только для клиентов, которым grant разрешён) |
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
`epic_unreachable`/`epic_http_error` 502, `epic_library_empty` 400,
`epic_code_required` 400 (пустой code), `epic_invalid_code` 400 (code
использован/просрочен — открыть ссылку заново), `epic_client_invalid` 502
(пара client_id/secret отклонена — это настройка сервера),
`epic_device_grant_unavailable` 400 (Epic закрыл device-code: используйте
`/connect`).

### 2.1. Обмен code (как именно)

```http
POST /account/api/oauth/token HTTP/1.1
Host: account-public-service-prod03.ol.epicgames.com
Authorization: basic <base64(client_id:client_secret)>   ← заголовок, НЕ query/body
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=<code>&token_type=eg1
```

Ответ: `access_token`, `refresh_token`, `account_id`, `displayName`,
`expires_in`, `refresh_expires_in`. Refresh — тот же эндпоинт с
`grant_type=refresh_token&refresh_token=…&token_type=eg1`. Значения
client-пары не логируются и не возвращаются в API (`clientSource`:
`env`/`file`/`default`).

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
- device-code (legacy): `authorization_pending` → pending, `slow_down` →
  interval+, `expired`/`invalid_grant` → expired/failed; 1016
  `unsupported_grant_type` → `epic_device_grant_unavailable`;
- authorization code: `invalid_client`/`1011` → `epic_client_invalid` (502),
  остальные 400 → `epic_invalid_code` (400), 403/429 → breaker;
- хосты дрейфуют: account `prod03` → fallback `prod`; entitlement —
  `entitlement-public-service-prod08` (не `entitlements-…prod06`, тот не
  резолвится); переопределяются env `GAMES_EPIC_*_HOST`;
- client credentials лаунчера — публичные (Legendary/Heroic), но значения не
  печатаются; порядок: `EPIC_CLIENT_ID`+`EPIC_CLIENT_SECRET` (алиасы
  `GAMES_EPIC_*`) → `config/epic-client.json` (0600, gitignored,
  `KINOBOXD_EPIC_CLIENT_FILE` — путь) → встроенная пара. Половина пары в env
  игнорируется.

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

- фактический обмен **реального** authorization code на боевом аккаунте
  (анонимно проверены только форма запроса и отказы: client_credentials 200,
  deviceAuthorization 401/400-1016; сам code требует логина пользователя);
- фактический ответ `deviceAuthorization`/`device_code` на боевом аккаунте
  (по EpicResearch/Legendary; в тестах — фейковый сервер) — сейчас недоступен
  для публичных клиентов;
- точность `totalTime` и охват сессий (Playnite: секунды);
- покрытие catalog bulk и `productmapping` (1 283 записи — неполное);
- поведение entitlement-хоста при ротации (prod08 → другой);
- rate-limit Epic на чтение библиотеки (заложены пауза/breaker, но не
  измерены).

## 8. Тесты

`npm test` (Node 24, порт 7084 для HTTP-тестов):

- `test/games-epic-token-store.test.js` — 0600/0700, атомарность, симлинки,
  починка mode, redaction;
- `test/games-epic-client.test.js` — authorization code (URL/заголовок basic/
  форма, `invalid_client` vs `invalid_grant`, code не эхоится, пустой code
  без запроса), device-code (pending/slow_down/expired/authorized) + 1016,
  refresh, 401/429/5xx, cursor-пагинация, секунды→минуты, catalog-чанки,
  маскировка, источник client-пары env→file→default;
- `test/games-epic-import.test.js` — цепочка, фильтры, deferred/auth_expired,
  reuse/force, owner_mismatch, `hoursBySource` не сливается со Steam;
- `test/games-epic-auth.test.js` — сессии, 0600-токен, owner binding, expiry,
  `connectWithCode` (0600, owner, `owner_mismatch`, валидация owner до сети);
- `test/games-epic-routes.test.js` — HTTP-контракт, redaction, strict query,
  disconnect со сохранением снимка, `/auth-url` + `/connect` (code required,
  unexpected_parameter).

Итог фикс-раунда 01.11.2026: полный `npm test` — **832 теста, 830 pass,
2 skip, 0 fail** (+11 к базе 821: 7 client, 3 auth, 1 routes).
