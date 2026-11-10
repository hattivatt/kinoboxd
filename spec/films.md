# Films domain — spec pointer

Это **не** спецификация. Единый источник семантики домена — `../AGENTS.md` (разделы 5 и 6) вне репозитория. Файл держит только карту кода и
указатели, чтобы не дублировать архитектуру и не расходиться с ней.

## Инварианты-указатели

- Один владелец = один профиль: кэш `cache/kp/<userId>.json`; журналы разных
  людей не суммируются (§6 `AGENTS.md`).
- Payload `GET /api/stats` — контракт под golden-снимком; форма ответа не
  меняется рефакторингом.
- Путь данных: Letterboxd ZIP → upload → TMDB enrich → stats → UI.

## Карта кода

- Роуты: `server/films/routes.js` (монтируется на `/api` в `server/index.js`).
- Кэш: `server/cache.js` (`cache/`, см. `contracts/cache.md`).
- Импорт/обогащение: `server/upload.js`, `server/enrich.js`, `server/kp.js`,
  `server/tmdb.js`, `server/wikidata.js`.
- Статистика: `server/stats.js` + `server/stats/` (секции), `server/taxonomy.js`.
- Сравнение профилей: `server/compare.js`.

## Контракты

- Роуты, параметры и коды ошибок: `contracts/api.md`.
- Env и лимиты источников: `contracts/env.md`, `contracts/limits.md`.
