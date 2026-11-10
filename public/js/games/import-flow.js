/* Import flow wording and readers shared by the games tab widgets.
 *
 * Split out of `games-view.js`; only the definition moved — the error table,
 * the stage labels and the tolerant job-id reader are byte-identical.
 */

import { arr, firstString, numOrNull, text } from '../core/dom.js';

/**
 * Accepts «76561198038369983», a `profiles/<id64>` URL, `id/<vanity>`, a bare
 * vanity or the full steamcommunity URL. Returns exactly one of
 * `steamid64` / `vanityUrl`, or `{ error }` with a human sentence.
 */
export function accountFromInput(value) {
  const raw = text(value);
  if (!raw) {
    return { error: 'Введите steamid64 (17 цифр) или имя профиля из steamcommunity.com/id/<имя>.' };
  }
  const cleaned = raw
    .replace(/^https?:\/\/(?:www\.)?steamcommunity\.com\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/^(?:id|profiles)\//i, '')
    .trim();
  if (!cleaned) {
    return { error: 'В ссылке нет имени профиля: нужен steamcommunity.com/id/<имя> или steamcommunity.com/profiles/<17 цифр>.' };
  }
  if (/^\d{17}$/.test(cleaned)) return { steamid64: cleaned };
  if (/^\d+$/.test(cleaned)) {
    return { error: 'steamid64 — это ровно 17 цифр. Число из «SteamID»/«SteamID3» (32-битный) не подойдёт: возьмите профиль-ссылку steamcommunity.com/profiles/<17 цифр>.' };
  }
  if (/^[A-Za-z0-9_-]{2,64}$/.test(cleaned)) return { vanityUrl: cleaned };
  return { error: 'Это не похоже ни на steamid64 (17 цифр), ни на имя профиля (латиница, цифры, «_» и «-»).' };
}

/**
 * Import error → honest Russian text with the next step. Codes come from the
 * contract (§5.4); anything unknown keeps the server sentence.
 */
const IMPORT_ERRORS = {
  profile_private: {
    title: 'Профиль Steam закрыт',
    message: 'Steam отвечает, что профиль приватный. Откройте «Мой профиль» → «Редактировать профиль» → «Приватность» и поставьте «Открытый», затем повторите импорт. Приватный профиль — не «0 игр».',
  },
  library_private: {
    title: 'Библиотека недоступна',
    message: 'Профиль открыт, но библиотеку Steam не отдал. Проверьте, что «Сведения об играх» в приватности профиля — «Открытые», и что ключ Steam Web API действует.',
  },
  stats_private: {
    title: 'Достижения скрыты',
    message: 'Профиль открыт, но статистика достижений закрыта: импорт продолжится без достижений, часы и библиотека остаются.',
  },
  invalid_steamid: {
    title: 'Профиль не найден',
    message: 'Steam не нашёл такой vanity URL. Проверьте имя в ссылке steamcommunity.com/id/<имя> или вставьте steamid64 (17 цифр).',
  },
  steamid_mismatch: {
    title: 'Steam вернул другой профиль',
    message: 'Steam ответил другим steamid64, чем запрошенный. Библиотеку нельзя приписать этому владельцу, поэтому импорт остановлен и ничего не сохранено. Проверьте ссылку профиля (steamcommunity.com/profiles/<17 цифр>) и повторите.',
  },
  steam_key_missing: {
    title: 'Нет ключа Steam Web API',
    message: 'Без ключа Steam отдаёт только профиль, достижения и три последних игры — библиотеки с часами нет. Ключ бесплатный: steamcommunity.com/dev/apikey, затем добавьте его на сервере (STEAM_API_KEY).',
  },
  steam_key_invalid: {
    title: 'Ключ Steam Web API отклонён',
    message: 'Steam ответил 401 на ключ: он отозван, истёк или скопирован с ошибкой. Выпустите новый на steamcommunity.com/dev/apikey и замените STEAM_API_KEY на сервере. Значение ключа нигде не печатается.',
  },
  steam_unreachable: {
    title: 'Steam недоступен с сервера',
    message: 'Сеть сервера не достучалась до steamcommunity.com (DNS/TLS/таймаут). Это не «источник мёртв»: проверьте резолвер или прокси на хосте и повторите импорт.',
  },
  steam_rate_limited: {
    title: 'Steam просит подождать',
    message: 'Steam ограничил частоту запросов (429) или включил паузу после ошибок. Подождите несколько минут и повторите импорт — данные в кэше не потеряны.',
  },
  steam_http_error: {
    title: 'Steam ответил ошибкой',
    message: 'Steam Web API вернул ошибку на запрос библиотеки. Повторите импорт через пару минут; если повторяется — проверьте состояние api.steampowered.com.',
  },
  games_import_failed: {
    title: 'Импорт не удался',
    message: 'Задача импорта завершилась ошибкой на стороне сервера. Повторите импорт; подробности — в логе сервера.',
  },
  target_required: {
    title: 'Не указан профиль',
    message: 'Введите vanity URL (steamcommunity.com/id/<имя>) или steamid64 (17 цифр).',
  },
  profile_required: {
    title: 'Не выбран профиль',
    message: 'Сначала импортируйте профиль Steam — статистика строится ровно по одному профилю.',
  },
  unexpected_parameter: {
    title: 'Сервер не принял запрос',
    message: 'Сервер отклонил лишний параметр запроса. Обновите страницу (UI и сервер разошлись по версии) и повторите.',
  },
  auth_required: {
    title: 'Нужен вход',
    message: 'Сессия истекла — войдите заново и повторите импорт.',
  },
};

export function importErrorText(error) {
  const code = text(error && error.code).toLowerCase();
  const status = numOrNull(error && error.status);
  const raw = text(error && error.message);
  if (IMPORT_ERRORS[code]) return { ...IMPORT_ERRORS[code], code };
  if (code === 'network' || status === 0) {
    return {
      title: 'Нет связи с сервером',
      message: 'Сервер не ответил. Проверьте, что он запущен, и повторите импорт.',
      code: code || 'network',
    };
  }
  if (status === 401) return { ...IMPORT_ERRORS.auth_required, code: 'auth_required' };
  return {
    title: 'Не удалось импортировать профиль',
    message: raw || 'Сервер ответил ошибкой. Попробуйте ещё раз.',
    code,
  };
}

const STAGE_LABEL = {
  start: 'Запуск импорта',
  init: 'Подготовка',
  queued: 'В очереди',
  bootstrap: 'Открываем Steam',
  profile: 'Читаем профиль Steam',
  'steam-profile': 'Читаем профиль Steam',
  community: 'Читаем профиль Steam',
  library: 'Загружаем библиотеку',
  'owned-games': 'Загружаем библиотеку',
  games: 'Загружаем библиотеку',
  summaries: 'Уточняем профиль',
  achievements: 'Собираем достижения',
  global: 'Считаем редкость достижений',
  stats: 'Считаем статистику',
  done: 'Готово',
  failed: 'Ошибка',
};

/** Human stage sentence for the import progress card. */
export function jobStageText(status) {
  if (!status || typeof status !== 'object') return 'Готовим импорт…';
  const message = text(status.message || status.detail);
  if (message) return message;
  const stage = text(status.stage || status.phase || status.status).toLowerCase();
  return STAGE_LABEL[stage] || 'Импортируем библиотеку…';
}

/**
 * Tolerant job id reader: `{ id }`, `{ jobId }` or `{ job: { id } }`.
 *
 * A bare `job: "games-import"` is the job TYPE in the contract (§5.4), not an
 * id — treating it as an id would poll `/status?id=games-import` forever.
 * When the server returns no id, the caller polls by `profile` instead.
 */
export function gamesJobId(response) {
  if (!response || typeof response !== 'object') return '';
  const nested = response.job && typeof response.job === 'object' ? response.job : null;
  return firstString(
    response.id,
    response.jobId,
    response.job_id,
    nested && nested.id,
  );
}

/** `GET /api/games/profiles` → `[{ key, userKey, personaName, label, gameCount, importedAt }]`. */
export function normalizeProfilesList(raw) {
  const list = Array.isArray(raw) ? raw : arr(raw && (raw.profiles || raw.items));
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const userKey = firstString(item.userKey, item.steamid64, item.id);
    const key = firstString(item.key, userKey ? `steam-${userKey}` : '');
    if (!key) continue;
    out.push({
      key,
      userKey,
      personaName: firstString(item.personaName, item.persona, item.label, userKey, key),
      label: firstString(item.label),
      gameCount: numOrNull(item.gameCount),
      importedAt: text(item.importedAt) || null,
      source: text(item.source) || 'steam',
    });
  }
  return out;
}

