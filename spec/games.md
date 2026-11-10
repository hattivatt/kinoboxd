# Games domain — spec pointer

Это **не** спецификация. Единый источник семантики домена — `../AGENTS.md` (разделы 5 и 6) вне репозитория. Здесь только карта кода и указатели на
инварианты.

## Инварианты-указатели

- Профиль = один владелец (`steam-<id>`, `gog-<key>`, `epic-<id>`); библиотеки
  разных владельцев не смешиваются (§6 `AGENTS.md`).
- Библиотека Steam собирается только Web API (`STEAM_API_KEY`); формы `/games`
  — login-gate, их не спрашивать (см. `AGENTS.md` §1).
- Вне-Steam карточки (GOG/Epic) — пайплайн `server/games/secondary/`
  (+ `sources/{gog,epic}.js`; `secondary-details.js` — фасад) с негативным
  кэшем и breaker; kick — только после реального импорта.
- Импорт/обогащение — задания с единой формой статуса (`server/core/jobs.js`).

## Карта кода

- Роуты: `server/games/routes.js`, `routes-gog.js`, `routes-epic.js`,
  `routes-franchise.js`, `personnel/routes-personnel.js` (все на `/api/games`).
- Кэш: `server/games/game-cache.js`, `gog-cache.js`, `epic-cache.js`,
  `secondary/store.js` (см. `contracts/cache.md`).
- Импорт: `import.js`, `gog-import.js`, `epic-import.js`, `enrich.js`.
- Метаданные: `store.js`, `spy.js`, `secondary/` (+ `secondary-details.js` —
  фасад), `franchise.js`, `personnel/` (Wikidata/Moby).
- Статистика: `server/games/stats.js` + `server/games/stats/`.

## Контракты

- Роуты, строгий query и коды ошибок: `contracts/api.md`.
- Env, паузы/бюджеты/breaker/TTL: `contracts/env.md`, `contracts/limits.md`.
