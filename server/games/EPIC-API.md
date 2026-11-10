# Epic Games Store — доменная специфика (M6b)

Статус: **M6b + фикс-раунд 01.11.2026 (authorization code)**.

**Границы документа.** Это не endpoint-контракт: роуты, строгий query и коды
ответов — `contracts/api.md`; раскладка кэша — `contracts/cache.md`; паузы,
бюджет и breaker — `contracts/limits.md`; модель «вторичная библиотека того же
владельца» — `АРХИТЕКТУРА.md` §5.3. Здесь остаётся только то, чего нет в
контрактах: поток авторизации, семантика отказов Epic и фильтры владения.

Реализация: `server/games/sources/epic.js` (сеть/бюджет/breaker),
`server/games/secondary/index.js` (идентичность и объединение);
фасадов старых путей больше нет — импортёры берут конкретный модуль из
`server/games/secondary/`.

## 1. Модель

Epic — **вторичная библиотека того же владельца**, не второй журнал:

- владелец — Steam-профиль `steam-<steamid64>`; Epic-аккаунт привязывается к
  нему через `owner` при auth/import;
- один владелец → один Epic-аккаунт (`owner_mismatch` при попытке второго);
- Steam-журнал (`summary.totalHours`, top, достижения) **не меняется**;
- часы Epic живут отдельно: `hoursBySource.epic`, со Steam не суммируются;
- union по `workKey` — в `secondary/index.js`; слой источника отдаёт
  `workKey: null`, `steamAppId: null`;
- `lastPlayed` у Epic не существует в модели — не выдумывается (`null`);
- снимок при истёкшем токене остаётся: `status: 'auth_expired'` + `fetchedAt`,
  а не нули.

## 2. Авторизация: authorization code

Живой smoke требует браузера пользователя: `GET /api/games/epic/auth-url` →
войти на epicgames.com → скопировать `code` со страницы `/id/api/redirect` →
`POST /api/games/epic/connect { code, owner }` → импорт стартует сам.
`code` принимается как сам код **или вся ссылка** `/id/api/redirect?code=…`.

Обмен (единственный рабочий grant):

```http
POST /account/api/oauth/token HTTP/1.1
Host: account-public-service-prod03.ol.epicgames.com
Authorization: basic <base64(client_id:client_secret)>   ← заголовок, НЕ query/body
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=<code>&token_type=eg1
```

Ответ: `access_token`, `refresh_token`, `account_id`, `displayName`,
`expires_in`, `refresh_expires_in`. Refresh — тот же эндпоинт с
`grant_type=refresh_token&refresh_token=…&token_type=eg1`. Client-пара не
логируется и не возвращается в API (только `clientSource`:
`env`/`file`/`default`).

**Device-code больше не используется.** Живая проверка 01.11.2026 (анонимно):
`launcherAppClient2` (Legendary) → `401 authentication_failed` (1032);
`fortnitePCGameClient` (EpicResearch) → `400 unsupported_grant_type` (1016).
Grant закрыт для **всех публичных** клиентов (оставлен консолям), поэтому
`POST /api/games/epic/auth` теперь ожидаемо отдаёт
`400 epic_device_grant_unavailable`.

## 3. Отказы Epic и фильтры владения

Отображение ошибок (HTTP-коды — в `contracts/api.md`):
`invalid_client`/`1011` → `epic_client_invalid` (502, настройка сервера);
остальные 400 → `epic_invalid_code` (code использован/просрочен — открыть
ссылку заново); 403/429 → breaker; 401 → `epic_auth_expired` + `lastAuthError`,
старый снимок цел; 5xx/сеть → `epic_unreachable` + `deferred: true`, импорт
**не** затирает снимок.

Фильтры владения:

- entitlements — первичный источник; library items — fallback/merge
  (`appName`, `platform`, `acquisitionDate`);
- выбрасываются: `namespace === 'ue'` (Unreal Engine), `sandboxType ===
  'PRIVATE'`, mobile-only (platform только Android/iOS), неактивные
  (`active: false` / `status !== ACTIVE`), consumable;
- запись без `catalogItemId` не попадает в счётчик, но считается в
  `counts.excluded.missingCatalogId`;
- пустой `platform` = «неизвестно», запись сохраняется.

## 4. Что не проверено живьём

- обмен **реального** authorization code на боевом аккаунте (анонимно
  проверены только форма запроса и отказы; сам code требует логина);
- `deviceAuthorization` на боевом аккаунте — недоступен публичным клиентам;
- точность `totalTime` и охват сессий (Playnite: секунды);
- покрытие catalog bulk и `productmapping` (1 283 записи — неполное);
- поведение entitlement-хоста при ротации (prod08 → другой);
- rate-limit Epic на чтение библиотеки (пауза/breaker заложены, не измерены).

Тесты: `test/games-epic-{token-store,client,import,auth,routes}.test.js`.
