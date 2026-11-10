# Books domain — spec pointer

Это **не** спецификация. Единый источник семантики домена — `../AGENTS.md` (разделы 5 и 6) вне репозитория. Здесь только карта кода и
указатели на инварианты.

## Инварианты-указатели

- Профиль = один владелец: `livelib-<user>` и `hardcover-<id>` — разные
  владельцы, их события не сливаются (§6 `AGENTS.md`). Hardcover — звено
  metadata-chain, а не второй журнал.
- Основной путь импорта — файл `livelib-backup`; скрап `POST /api/books/import/livelib`
  остаётся аварийным и для тестов job'а.
- Резолв метаданных идёт цепочкой провайдеров с бюджетами/брейкерами из
  `server/core/sources.js` (см. `contracts/limits.md`).

## Карта кода

- Роуты: `server/books/routes.js` (монтируется на `/api/books`).
- Кэш: `server/books/book-cache.js` (`cache-book/`, см. `contracts/cache.md`).
- Импорт: `server/books/import.js`, `livelib-file.js`, `livelib.js`,
  `hardcover.js`, `resolve.js`, `scheduled-resolve.js`.
- Провайдеры: `server/books/providers/` (приоритет и merge — `providers/index.js`).
- Статистика: `server/books/stats.js` + `server/books/stats/`.

## Контракты

- Роуты, строгий query и коды ошибок: `contracts/api.md`.
- Env, паузы/бюджеты/breaker/TTL: `contracts/env.md`, `contracts/limits.md`.
