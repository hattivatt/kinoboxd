/* Games modals: game card, game lists and the person card (films parity).
 *
 * The films tab opens `openFilmListModal` / the person modal from
 * `modal.js`; games need the same shape but different data (Steam appids,
 * hours, completion, studios instead of TMDB people). This module owns that
 * layer so `games.js` keeps only the dashboard rendering:
 *
 *   - `openGameCardModal`  → `GET /api/games/game/:appid` (details,
 *     achievements, credits, store links) — the only extra request, lazy;
 *   - `openGameListModal`  → a client-side list from `gamesIndex` (year,
 *     decade, genre, mode, hours bucket, backlog, unmatched, …);
 *   - `openPersonModal`    → one person/studio with their games, batch 60.
 *
 * Sorting is persisted per scope in localStorage, exactly like
 * `kinoboxd.modalSort.<scope>` for films, but with games keys
 * (hours / completion / year / name).
 */

import {
  el, clear, fmtInt, plural, icon, emptyState, errorBox, toast, shortErrorMessage,
  showTooltip, moveTooltip, hideTooltip,
} from './ui.js';
import { openModal } from './modal.js';
import { getGameDetails } from './api.js';
import {
  GAME_SORT_OPTIONS, sortGameRows, personGames, personSummaryText, hoursText, percentText,
  formatDateRu, gameTypeLabel, personnelRoleLabel, normalizeGameCard, gamesInFranchise,
} from './games-view.js';

const GAME_BATCH = 60;
const ACHIEVEMENT_BATCH = 20;
const GAME_PLURAL = ['игра', 'игры', 'игр'];
const SORT_STORAGE_PREFIX = 'kinoboxd.games.modalSort.';
const SORT_VALUES = new Set(GAME_SORT_OPTIONS.map((option) => option.key));

const context = {
  profile: '',
  gamesIndex: {},
};

/** Called by games.js on every dashboard render (one owner, one index). */
export function configureGamesModals({ profile = '', gamesIndex = null } = {}) {
  context.profile = profile || '';
  context.gamesIndex = gamesIndex && typeof gamesIndex === 'object' ? gamesIndex : {};
}

/* =========================================================
   sort persistence
   ========================================================= */

export function getGameSort(scope, { fallback = 'hours' } = {}) {
  let value = '';
  try {
    value = window.localStorage.getItem(`${SORT_STORAGE_PREFIX}${scope || 'games'}`) || '';
  } catch {
    value = '';
  }
  return SORT_VALUES.has(value) ? value : fallback;
}

export function setGameSort(scope, value) {
  if (!SORT_VALUES.has(value)) return;
  try {
    window.localStorage.setItem(`${SORT_STORAGE_PREFIX}${scope || 'games'}`, value);
  } catch {
    /* private mode — the dialog still sorts for this session */
  }
}

function sortHint(key) {
  const option = GAME_SORT_OPTIONS.find((entry) => entry.key === key);
  return option ? option.hint : '';
}

function createGameSortSelect({ scope, onChange, fallback = 'hours' } = {}) {
  const wrap = el('div', { class: 'modal-sort' });
  wrap.append(el('span', { class: 'modal-sort-label', text: 'Сортировка' }));
  const selectWrap = el('div', { class: 'select-wrap' });
  const select = el('select', { class: 'select select-sm', 'aria-label': 'Сортировка игр' });
  for (const option of GAME_SORT_OPTIONS) {
    select.append(el('option', { value: option.key, text: option.label }));
  }
  select.value = getGameSort(scope, { fallback });
  select.addEventListener('change', () => {
    setGameSort(scope, select.value);
    if (typeof onChange === 'function') onChange(select.value);
  });
  selectWrap.append(select);
  selectWrap.append(el('span', { class: 'select-chevron', html: icon('chevron', 14) }));
  wrap.append(selectWrap);
  return { node: wrap, value: select.value, select };
}

/* =========================================================
   icons / fallbacks
   ========================================================= */

function initialOf(name) {
  const chars = Array.from(String(name || '').trim());
  return chars.length ? chars[0].toUpperCase() : '?';
}

function positiveId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function fallbackStyle(name) {
  let hash = 0;
  for (const char of String(name || '?')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  const hue = hash % 360;
  return {
    background: `linear-gradient(145deg, hsl(${hue} 32% 33%), hsl(${(hue + 48) % 360} 36% 19%))`,
  };
}

/** Steam capsule icon (46/88 px) with a deterministic initials fallback. */
export function gameIconEl(game, { className = 'game-icon' } = {}) {
  const name = game && game.name ? game.name : '';
  const url = game && /^https?:\/\//i.test(String(game.iconUrl || '')) ? game.iconUrl : '';
  if (!url) {
    return el('div', {
      class: `${className} game-icon-fallback`,
      style: fallbackStyle(name),
      'aria-hidden': 'true',
      text: initialOf(name),
    });
  }
  const img = el('img', {
    class: className,
    src: url,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer',
  });
  img.addEventListener('error', () => {
    img.replaceWith(el('div', {
      class: `${className} game-icon-fallback`,
      style: fallbackStyle(name),
      'aria-hidden': 'true',
      text: initialOf(name),
    }));
  });
  return img;
}

const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

/**
 * Landscape cover URLs for one game, best first. No network probe happens
 * here: the browser walks the chain through `error` listeners in
 * `gameCoverEl`.
 *
 *   header.jpg (460×215)     — the store header of the SKU, the real artwork;
 *   capsule_231x87.jpg       — the older capsule, same CDN;
 *   the 32×32 community icon — last Steam-side step;
 *   initials                 — client-side fallback (no request at all).
 *
 * The canonical `primaryAppid` wins over the edition's own appid so two
 * editions of one work paint the same cover. `library_hero.jpg` is *not* in
 * the chain: it is missing for a lot of regional/older SKUs, and a 404 there
 * would burn a request on every card.
 *
 * The games tab paints vertical posters (see `gameVerticalCoverUrls`); this
 * landscape chain is kept for callers that still want the store header.
 */
export function gameCoverUrls(game) {
  const appid = positiveId(game && (game.primaryAppid ?? game.appid));
  const urls = [];
  if (appid) {
    urls.push(`${STEAM_CDN}/${appid}/header.jpg`);
    urls.push(`${STEAM_CDN}/${appid}/capsule_231x87.jpg`);
  }
  const icon = game && /^https?:\/\//i.test(String(game.iconUrl || '')) ? String(game.iconUrl) : '';
  if (icon) urls.push(icon);
  return urls;
}

/**
 * Vertical poster URLs for one game, best first — the shape books/films use
 * in their shelves. Live CDN audit (40 random appids of the 340-game
 * library, 01.11.2026): `library_600x900.jpg` is present for 33/40 SKUs;
 * the 7 misses are old/regional/package appids. For 6 of those 7 the
 * landscape `header.jpg` still exists, so it is the first fallback and CSS
 * centre-crops it into the 2:3 frame (`object-fit: cover`).
 *
 *   library_600x900.jpg (600×900, 2:3) — the official vertical library capsule;
 *   header.jpg (460×215)              — landscape header, cropped vertically;
 *   capsule_231x87.jpg                — older capsule, same CDN;
 *   the 32×32 community icon          — last Steam-side step;
 *   initials                          — client-side fallback (no request).
 *
 * `library_600x900_2x.jpg` is deliberately absent: the audit showed its
 * availability is *identical* to the 1x file (40/40 parity), so it can never
 * rescue a missing 1x, while it is ~4× heavier. The 600×900 file is already
 * ~6× the rendered 96 px width — plenty even on HiDPI.
 */
export function gameVerticalCoverUrls(game) {
  const appid = positiveId(game && (game.primaryAppid ?? game.appid));
  const urls = [];
  if (appid) {
    urls.push(`${STEAM_CDN}/${appid}/library_600x900.jpg`);
    urls.push(`${STEAM_CDN}/${appid}/header.jpg`);
    urls.push(`${STEAM_CDN}/${appid}/capsule_231x87.jpg`);
  }
  // M6c: a cross-store row may bring its own poster (GOG/Epic art is not on
  // the Steam CDN). Steam rows keep the Steam chain first; the provided URL is
  // the only art when there is no appid at all.
  const provided = game && (game.verticalCoverUrl || game.coverUrl);
  if (/^https?:\/\//i.test(String(provided || ''))) urls.push(String(provided));
  const icon = game && /^https?:\/\//i.test(String(game.iconUrl || '')) ? String(game.iconUrl) : '';
  if (icon) urls.push(icon);
  return urls;
}

/** Shared <img> that walks a URL chain and ends in the initials block. */
function coverChainEl(game, urls, className) {
  const name = game && game.name ? game.name : '';
  const fallback = () => el('div', {
    class: `${className} game-icon-fallback`,
    style: fallbackStyle(name),
    'aria-hidden': 'true',
    text: initialOf(name),
  });
  if (!urls.length) return fallback();
  const img = el('img', {
    class: className,
    src: urls[0],
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer',
  });
  let step = 0;
  img.addEventListener('error', () => {
    step += 1;
    if (step < urls.length) {
      img.setAttribute('src', urls[step]);
      return;
    }
    img.replaceWith(fallback());
  });
  return img;
}

/**
 * Wide cover with the landscape chain. Kept for parity, but the games tab
 * uses `gameCoverVerticalEl` everywhere it paints artwork.
 */
export function gameCoverEl(game, { className = 'game-cover' } = {}) {
  return coverChainEl(game, gameCoverUrls(game), className);
}

/**
 * Vertical poster (96×144 strip art, 88×132 card head) with the fallback
 * chain. Returns an <img> that swaps its own `src` down the chain, or the
 * initials block when every URL failed / none exists. Small 34×34 rows keep
 * `gameIconEl`: a 32×32 icon is the right size there, not a cropped poster.
 */
export function gameCoverVerticalEl(game, { className = 'game-cover-vertical' } = {}) {
  return coverChainEl(game, gameVerticalCoverUrls(game), className);
}

function firstGameIconUrl(person) {
  for (const game of Array.isArray(person && person.games) ? person.games : []) {
    if (!game || game.appid == null) continue;
    const entry = context.gamesIndex[game.appid] || context.gamesIndex[String(game.appid)];
    if (entry && /^https?:\/\//i.test(String(entry.iconUrl || ''))) return entry.iconUrl;
  }
  return '';
}

/** Person/studio avatar: the first game's Steam icon, else initials. */
export function personAvatarEl(person, { className = 'avatar' } = {}) {
  const name = person && person.name ? person.name : '';
  return gameIconEl({ name, iconUrl: firstGameIconUrl(person) }, { className });
}

/* =========================================================
   game row (shared by every list modal)
   ========================================================= */

function gameRowSubtitle(game) {
  const parts = [];
  const type = gameTypeLabel(game.type);
  if (type && game.type !== 'game') parts.push(type);
  if (game.releaseYear) parts.push(String(game.releaseYear));
  if (game.hours != null) parts.push(hoursText(game.hours));
  if (game.completion != null) parts.push(`completion ${percentText(game.completion, 0)}`);
  return parts.join(' · ');
}

function gameRow(game, { onOpen = null } = {}) {
  const row = el('div', {
    class: 'film-row game-row',
    role: 'button',
    tabIndex: 0,
    'aria-label': `${game.name || `appid ${game.appid}`}: открыть карточку игры`,
  });
  row.append(gameIconEl(game));
  const info = el('div', { class: 'film-info' });
  const title = el('div', { class: 'film-title', text: game.name || `appid ${game.appid}` });
  if (game.releaseYear) title.append(el('span', { class: 'film-year', text: String(game.releaseYear) }));
  info.append(title);
  const sub = gameRowSubtitle(game);
  if (sub) info.append(el('div', { class: 'film-char', text: sub }));
  row.append(info);

  const value = el('div', { class: 'game-row-value' });
  value.append(el('span', { text: game.hours != null ? hoursText(game.hours) : '—' }));
  if (game.completion != null) {
    value.append(el('small', { text: `completion ${percentText(game.completion, 0)}` }));
  }
  row.append(value);

  row.addEventListener('pointerenter', (event) => {
    showTooltip(
      `${game.name || `appid ${game.appid}`}${game.hours != null ? ` — ${hoursText(game.hours)}` : ''}`,
      [
        game.releaseYear ? `год релиза ${game.releaseYear}` : 'год релиза неизвестен',
        game.completion != null ? `completion ${percentText(game.completion, 0)}` : '',
        'нажмите, чтобы открыть карточку',
      ].filter(Boolean).join(' · '),
    );
    moveTooltip(event);
  });
  row.addEventListener('pointermove', moveTooltip);
  row.addEventListener('pointerleave', hideTooltip);

  const activate = () => {
    hideTooltip();
    if (typeof onOpen === 'function') onOpen(game);
    else openGameCardModal(game.appid);
  };
  row.addEventListener('click', activate);
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  });
  return row;
}

/* =========================================================
   game list modal
   ========================================================= */

let seq = 0;

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.kicker]
 * @param {string} [opts.subtitle]
 * @param {string} [opts.hint]
 * @param {string} [opts.groupLabel]
 * @param {string} [opts.emptyText]
 * @param {Array<object>} opts.games  normalised gamesIndex rows
 * @param {string} [opts.sortScope]  localStorage scope
 * @param {string} [opts.defaultSort]
 * @param {number} [opts.batch]
 * @param {(game:object)=>void} [opts.onOpen]
 */
export function openGameListModal({
  title = 'Игры',
  kicker = '',
  subtitle = '',
  hint = '',
  groupLabel = 'Игры',
  emptyText = 'Нет игр',
  games = [],
  sortScope = 'games',
  defaultSort = 'hours',
  batch = GAME_BATCH,
  onOpen = null,
} = {}) {
  seq += 1;
  const titleId = `game-list-title-${seq}`;
  const list = Array.isArray(games) ? games.filter(Boolean) : [];
  let sortKey = getGameSort(sortScope, { fallback: defaultSort });
  let ordered = sortGameRows(list, sortKey);

  const head = el('div', { class: 'modal-head' });
  const copy = el('div', { class: 'modal-head-copy' });
  if (kicker) copy.append(el('div', { class: 'modal-role', text: kicker }));
  copy.append(el('h2', { class: 'modal-title', id: titleId, text: title }));
  if (subtitle) copy.append(el('div', { class: 'modal-sub', text: subtitle }));
  if (hint) copy.append(el('p', { class: 'modal-hint', text: hint }));
  head.append(copy);

  const body = el('div', { class: 'modal-body' });
  if (!list.length) {
    body.append(emptyState(emptyText));
    const control = createGameSortSelect({ scope: sortScope, fallback: defaultSort });
    head.append(control.node);
    return openModal({ head, body, labelledBy: titleId, className: 'modal-films' });
  }

  const group = el('div', { class: 'film-group-label' });
  group.append(el('span', { text: groupLabel }));
  const noteNode = el('span', { text: sortHint(sortKey) });
  group.append(noteNode);
  body.append(group);

  const listHost = el('div', { class: 'film-list' });
  const moreHost = el('div', { class: 'modal-more' });
  body.append(listHost, moreHost);

  const size = Math.max(10, Math.min(Number(batch) || GAME_BATCH, 200));
  let shown = Math.min(size, ordered.length);
  const renderVisible = () => {
    clear(listHost);
    clear(moreHost);
    for (const game of ordered.slice(0, shown)) {
      listHost.append(gameRow(game, { onOpen: onOpen || ((row) => openGameCardModal(row.appid)) }));
    }
    if (shown < ordered.length) {
      const more = el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        text: `Показать ещё ${fmtInt(Math.min(size, ordered.length - shown))}`,
      });
      more.addEventListener('click', () => {
        shown = Math.min(ordered.length, shown + size);
        renderVisible();
      });
      moreHost.append(more);
    }
  };

  const control = createGameSortSelect({
    scope: sortScope,
    fallback: defaultSort,
    onChange: (value) => {
      sortKey = value;
      ordered = sortGameRows(list, sortKey);
      noteNode.textContent = sortHint(sortKey);
      renderVisible();
    },
  });
  head.append(control.node);
  renderVisible();

  return openModal({ head, body, labelledBy: titleId, className: 'modal-films' });
}

/**
 * Franchise modal: the games of one franchise (IGDB/Wikidata link or the
 * name heuristic), ordered by release year. Reuses the game-list modal so the
 * sorting control and the card drilldown stay identical to every other list.
 */
export function openFranchiseModal({ franchise = null, games = [], hoursSum = null } = {}) {
  const label = (franchise && (franchise.label || franchise.name || franchise.key)) || 'Франшиза';
  const list = Array.isArray(games) ? games.filter(Boolean) : [];
  const hoursPart = hoursSum != null ? ` · ${hoursText(hoursSum)}` : '';
  return openGameListModal({
    kicker: 'Франшиза',
    title: label,
    subtitle: `${fmtInt(list.length)} ${plural(list.length, GAME_PLURAL)}${hoursPart}`,
    hint: 'Игры одной франшизы (IGDB/Wikidata или эвристика), по годам релиза. Часы — по данным Steam.',
    groupLabel: label,
    emptyText: 'Нет игр этой франшизы в библиотеке',
    games: list,
    sortScope: 'franchise',
    defaultSort: 'year',
  });
}

/* =========================================================
   person modal
   ========================================================= */

/**
 * One person/studio from `/api/games/personnel` with their games.
 * The server caps games per person at 50 (`limit`), so when `count > games`
 * the modal says so honestly instead of pretending the list is complete.
 */
export function openPersonModal({ person, role = 'developer', weight = 'hours', coverage = null } = {}) {
  if (!person) return null;
  seq += 1;
  const titleId = `game-person-title-${seq}`;
  // `developer` is the split key; `studio` is the old mixed one. Both are
  // companies, so both get the studio logo and the studio summary wording.
  const isStudio = role === 'studio' || role === 'developer';
  const games = personGames(person, context.gamesIndex);
  const count = Math.max(Number(person.count) || 0, games.length);
  const hours = person.hours;
  let sortKey = getGameSort('person', { fallback: 'hours' });
  let ordered = sortGameRows(games, sortKey);

  const head = el('div', { class: 'modal-head' });
  head.append(personAvatarEl(person, { className: 'modal-portrait' }));
  const copy = el('div', { class: 'modal-head-copy' });
  copy.append(el('div', { class: 'modal-role', text: personnelRoleLabel(role) }));
  copy.append(el('h2', { class: 'modal-title', id: titleId, text: person.name }));
  copy.append(el('div', {
    class: 'modal-sub',
    text: isStudio
      ? personSummaryText({ count, hours })
      : `${fmtInt(count)} ${plural(count, GAME_PLURAL)} в кредитах${hours != null ? ` · ${hoursText(hours)}` : ''}`,
  }));

  const hints = [];
  if (person.rolesText) hints.push(`роли: ${person.rolesText}`);
  if (person.aliasesText) hints.push(`также: ${person.aliasesText}`);
  if (person.qid) hints.push(`QID ${person.qid}`);
  if (person.avgCompletion != null) hints.push(`средний completion ${percentText(person.avgCompletion, 0)}`);
  if (person.sources && person.sources.length) hints.push(`источник: ${person.sources.join(', ')}`);
  if (coverage && coverage.gamesWithCredits != null && coverage.gamesTotal) {
    hints.push(`кредиты у ${fmtInt(coverage.gamesWithCredits)} из ${fmtInt(coverage.gamesTotal)} игр`);
  }
  if (hints.length) copy.append(el('p', { class: 'modal-hint', text: hints.join(' · ') }));
  if (count > games.length) {
    copy.append(el('p', {
      class: 'modal-hint',
      text: `В карточке ${fmtInt(games.length)} из ${fmtInt(count)} игр: сервер отдаёт не больше 50 игр на человека.`,
    }));
  }
  head.append(copy);

  const body = el('div', { class: 'modal-body' });
  if (!games.length) {
    body.append(emptyState(isStudio ? 'Нет игр этой студии в выгрузке' : 'Нет игр с этой персоной'));
    const control = createGameSortSelect({ scope: 'person', fallback: 'hours' });
    head.append(control.node);
    return openModal({ head, body, labelledBy: titleId });
  }

  const group = el('div', { class: 'film-group-label' });
  group.append(el('span', { text: isStudio ? 'Игры студии' : 'Игры персоны' }));
  const noteNode = el('span', { text: sortHint(sortKey) });
  group.append(noteNode);
  body.append(group);

  const listHost = el('div', { class: 'film-list' });
  const moreHost = el('div', { class: 'modal-more' });
  body.append(listHost, moreHost);

  let shown = Math.min(GAME_BATCH, ordered.length);
  const renderVisible = () => {
    clear(listHost);
    clear(moreHost);
    for (const game of ordered.slice(0, shown)) {
      listHost.append(gameRow(game, { onOpen: (row) => openGameCardModal(row.appid) }));
    }
    if (shown < ordered.length) {
      const more = el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        text: `Показать ещё ${fmtInt(Math.min(GAME_BATCH, ordered.length - shown))}`,
      });
      more.addEventListener('click', () => {
        shown = Math.min(ordered.length, shown + GAME_BATCH);
        renderVisible();
      });
      moreHost.append(more);
    }
  };

  const control = createGameSortSelect({
    scope: 'person',
    fallback: 'hours',
    onChange: (value) => {
      sortKey = value;
      ordered = sortGameRows(games, sortKey);
      noteNode.textContent = sortHint(sortKey);
      renderVisible();
    },
  });
  head.append(control.node);
  renderVisible();

  return openModal({ head, body, labelledBy: titleId });
}

/* =========================================================
   game card modal
   ========================================================= */

function linkMenu(game) {
  const links = [
    game.links && game.links.steam ? { label: 'Steam Store', glyph: 'ST', href: game.links.steam } : null,
    game.links && game.links.community ? { label: 'Steam Community', glyph: 'SC', href: game.links.community } : null,
    game.links && game.links.steamdb ? { label: 'SteamDB', glyph: 'DB', href: game.links.steamdb } : null,
  ].filter(Boolean);
  if (!links.length) return null;

  const wrap = el('div', { class: 'film-menu' });
  const toggle = el('button', {
    type: 'button',
    class: 'film-menu-toggle',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': 'Ссылки на игру',
    title: 'Ссылки на игру',
    html: icon('more', 16),
  });
  wrap.append(toggle);

  let popup = null;
  let openedAt = 0;

  function cleanup() {
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onWindowChange, true);
    window.removeEventListener('resize', onWindowChange);
  }

  function close() {
    cleanup();
    if (popup) {
      popup.remove();
      popup = null;
    }
  }

  function onDocPointerDown(event) {
    if (popup && popup.contains(event.target)) return;
    if (wrap.contains(event.target)) return;
    close();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function onWindowChange(event) {
    if (Date.now() - openedAt < 350) return;
    if (event && event.type === 'scroll' && popup && popup.contains(event.target)) return;
    close();
  }

  function open() {
    close();
    popup = el('div', { class: 'film-menu-popup', role: 'menu', 'aria-label': `Ссылки: ${game.name}` });
    for (const item of links) {
      const anchor = el('a', {
        class: 'film-menu-item',
        role: 'menuitem',
        href: item.href,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      el('span', { class: 'film-menu-icon', text: item.glyph }),
      el('span', { class: 'film-menu-label', text: item.label }));
      anchor.addEventListener('click', close);
      popup.append(anchor);
    }
    document.body.append(popup);
    toggle.setAttribute('aria-expanded', 'true');
    const rect = toggle.getBoundingClientRect();
    popup.style.visibility = 'hidden';
    const popupRect = popup.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - popupRect.width, window.innerWidth - popupRect.width - 8));
    let top = rect.bottom + 6;
    if (top + popupRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - popupRect.height - 6);
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    popup.style.visibility = '';
    openedAt = Date.now();
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onWindowChange, true);
    window.addEventListener('resize', onWindowChange);
  }

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    if (popup) close();
    else open();
  });
  return wrap;
}

function factRow(label, value, title = '') {
  const row = el('div', { class: 'games-fact', title });
  row.append(el('dt', { text: label }));
  row.append(el('dd', { text: value }));
  return row;
}

function detailRow(label, value) {
  if (!value) return null;
  const row = el('div', { class: 'game-detail' });
  row.append(el('dt', { text: label }));
  row.append(el('dd', { text: value }));
  return row;
}

function section(title, ...children) {
  const box = el('section', { class: 'game-section' });
  box.append(el('h3', { class: 'game-section-title', text: title }));
  for (const child of children.flat(Infinity)) if (child) box.append(child);
  return box;
}

function platformText(platforms) {
  if (!platforms) return '';
  return [
    platforms.windows ? 'Windows' : '',
    platforms.mac ? 'macOS' : '',
    platforms.linux ? 'Linux' : '',
  ].filter(Boolean).join(' · ');
}

function renderCardAchievements(game) {
  const block = game.achievements;
  if (!block || (block.total == null && !block.items.length)) {
    return section('Достижения', el('p', {
      class: 'game-note',
      text: 'Статистики достижений для этой игры в кэше нет: Steam не отдал её или профиль скрывает достижения. Это не «0 из 0».',
    }));
  }
  const parts = [];
  if (block.unlocked != null && block.total != null) {
    parts.push(`${fmtInt(block.unlocked)} из ${fmtInt(block.total)}`);
  }
  if (block.percent != null) parts.push(percentText(block.percent, 0));
  const box = el('div');
  if (parts.length) box.append(el('p', { class: 'game-note', text: parts.join(' · ') }));
  const listHost = el('div', { class: 'game-achievements' });
  const moreHost = el('div', { class: 'modal-more' });
  let shown = Math.min(ACHIEVEMENT_BATCH, block.items.length);
  const render = () => {
    clear(listHost);
    clear(moreHost);
    for (const item of block.items.slice(0, shown)) {
      const row = el('div', { class: `game-achievement${item.achieved ? ' is-achieved' : ''}` });
      row.append(el('span', { class: 'game-achievement-mark', text: item.achieved ? '✓' : '·' }));
      const info = el('div', { class: 'game-achievement-info' });
      info.append(el('div', { class: 'game-achievement-name', text: item.name }));
      if (item.description) info.append(el('div', { class: 'game-achievement-desc', text: item.description }));
      row.append(info);
      if (item.unlockTimestamp) {
        row.append(el('span', {
          class: 'game-achievement-date',
          text: formatDateRu(new Date(item.unlockTimestamp * 1000).toISOString()),
        }));
      }
      listHost.append(row);
    }
    if (shown < block.items.length) {
      const more = el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        text: `Показать ещё ${fmtInt(Math.min(ACHIEVEMENT_BATCH, block.items.length - shown))}`,
      });
      more.addEventListener('click', () => {
        shown = Math.min(block.items.length, shown + ACHIEVEMENT_BATCH);
        render();
      });
      moreHost.append(more);
    }
  };
  if (block.items.length) render();
  box.append(listHost, moreHost);
  return section('Достижения', box);
}

function renderCardPersonnel(game) {
  const block = game.personnel;
  if (!block || (!block.studios.length && !block.people.length)) {
    return section('Кредиты', el('p', {
      class: 'game-note',
      text: 'Кредиты этой игры ещё не собраны (MobyGames/Wikidata). Это не «нет разработчика»: данные просто не загружены.',
    }));
  }
  const body = el('div');
  const makeList = (label, items) => {
    if (!items.length) return null;
    const wrap = el('div', { class: 'game-credit-group' });
    wrap.append(el('div', { class: 'game-credit-label', text: label }));
    for (const item of items) {
      const line = el('div', { class: 'game-credit' });
      line.append(el('span', { class: 'game-credit-name', text: item.name }));
      if (item.roles.length) {
        line.append(el('span', {
          class: 'game-credit-roles',
          text: item.roles.map((role) => personnelRoleLabel(role)).join(' · '),
        }));
      }
      wrap.append(line);
    }
    return wrap;
  };
  const studiosList = makeList('Студии', block.studios);
  const peopleList = makeList('Люди', block.people);
  if (studiosList) body.append(studiosList);
  if (peopleList) body.append(peopleList);
  if (block.coverage) {
    const parts = [];
    if (block.coverage.studios) parts.push(`${fmtInt(block.coverage.studios)} студий`);
    if (block.coverage.people) parts.push(`${fmtInt(block.coverage.people)} человек`);
    if (parts.length) body.append(el('p', { class: 'game-note', text: `в кредитах: ${parts.join(' · ')}` }));
  }
  return section('Кредиты', body);
}

function fillGameCard({ head, copy, body, game }) {
  clear(copy);
  clear(body);
  head.insertBefore(gameCoverVerticalEl(game, { className: 'modal-game-cover' }), copy);
  // M6c: the card may be opened for a work owned in several stores. The role
  // line names every store; the hours below stay Steam-only (the journal).
  const extraStores = (Array.isArray(game.sources) ? game.sources : [])
    .filter((source) => source && source !== 'steam')
    .map((source) => (source === 'gog' ? 'GOG' : source === 'epic' ? 'Epic' : source));
  const storeLabel = extraStores.length ? `Steam + ${extraStores.join(' + ')}` : 'Steam';
  copy.append(el('div', {
    class: 'modal-role',
    text: game.type && game.type !== 'game' ? `${storeLabel} · ${game.typeLabel}` : `Игра · ${storeLabel}`,
  }));
  copy.append(el('h2', { class: 'modal-title', id: head.dataset.titleId || '', text: game.name }));
  const subParts = [];
  if (game.typeLabel) subParts.push(game.typeLabel);
  if (game.releaseYear) subParts.push(String(game.releaseYear));
  if (game.hours != null) subParts.push(hoursText(game.hours));
  if (game.completion != null) subParts.push(`completion ${percentText(game.completion, 0)}`);
  copy.append(el('div', { class: 'modal-sub', text: subParts.join(' · ') }));

  // M4 card strip: top-3 SteamSpy tags, then the community review badge.
  // The badge is explicitly labelled as Steam community data, not a personal
  // rating — Steam has no personal scores.
  if (game.tags && game.tags.length) {
    const strip = el('div', { class: 'game-tags-strip', 'aria-label': 'Теги SteamSpy' });
    for (const tag of game.tags.slice(0, 3)) {
      strip.append(el('span', { class: 'game-tag-chip', text: tag }));
    }
    if (game.tags.length > 3) {
      strip.append(el('span', {
        class: 'game-tag-chip is-more',
        text: `+${game.tags.length - 3}`,
        title: game.tags.slice(3).join(', '),
      }));
    }
    copy.append(strip);
  }
  if (game.reviewScore) {
    const score = game.reviewScore.score;
    const reviewLabel = game.reviewScore.label || game.reviewScore.desc || 'оценка Steam';
    const badge = el('div', {
      class: 'game-review-badge',
      title: `community score Steam ${score != null ? `${score}/9` : ''} — оценка сообщества, не ваша личная`,
    });
    badge.append(el('span', {
      class: 'game-review-dot',
      style: { background: game.reviewScore.color || '#8f9464' },
    }));
    badge.append(el('span', { class: 'game-review-score', text: score != null ? `${score}/9` : '—' }));
    badge.append(el('span', { class: 'game-review-label', text: reviewLabel }));
    copy.append(badge);
  }

  const menu = linkMenu(game);
  if (menu) copy.append(menu);

  if (game.franchise && game.franchise.label) {
    const chip = el('button', {
      type: 'button',
      class: 'game-franchise-chip',
      title: 'Открыть игры этой франшизы',
    });
    chip.append(el('span', { class: 'game-franchise-key', text: 'Франшиза' }));
    chip.append(el('strong', { text: game.franchise.label }));
    chip.addEventListener('click', () => {
      const list = sortGameRows(gamesInFranchise(context.gamesIndex, game.franchise), 'year');
      openFranchiseModal({ franchise: game.franchise, games: list });
    });
    copy.append(chip);
  }

  if (game.type && game.type !== 'game') {
    copy.append(el('p', {
      class: 'modal-hint',
      text: `Это запись Steam типа «${game.typeLabel}», а не игра: в статистику часов такие записи не входят, когда сервер умеет их отличать.`,
    }));
  } else if (!game.type) {
    copy.append(el('p', {
      class: 'modal-hint',
      text: 'Тип записи неизвестен: Steam Store ещё не отдал appdetails. Часы при этом настоящие — из библиотеки Steam.',
    }));
  }

  const facts = el('dl', { class: 'games-facts game-card-facts' });
  facts.append(factRow('часы', game.hours != null ? hoursText(game.hours) : '—', 'playtime_forever по данным Steam'));
  facts.append(factRow('за 2 недели', game.hours2w != null ? hoursText(game.hours2w) : '—', 'playtime_2weeks'));
  facts.append(factRow('последний запуск', game.lastPlayedText || '—', game.lastPlayedTitle));
  facts.append(factRow('тип', game.typeLabel || 'неизвестен', 'type из Steam Store appdetails'));
  facts.append(factRow('год релиза', game.releaseYear ? String(game.releaseYear) : 'неизвестен', 'releaseYear из Steam Store / Wikidata'));
  if (game.achievements && game.achievements.total != null) {
    const unlocked = game.achievements.unlocked != null ? fmtInt(game.achievements.unlocked) : '?';
    facts.append(factRow('достижения', `${unlocked} из ${fmtInt(game.achievements.total)}`, 'Публичная статистика достижений Steam'));
  }
  body.append(facts);

  const details = game.details;
  if (details) {
    const grid = el('dl', { class: 'game-detail-grid' });
    const genres = details.genres.join(', ');
    const categories = details.categories.length > 8
      ? `${details.categories.slice(0, 8).join(', ')} и ещё ${details.categories.length - 8}`
      : details.categories.join(', ');
    grid.append(detailRow('жанры', genres));
    grid.append(detailRow('категории', categories));
    grid.append(detailRow('разработчики', details.developers.join(', ')));
    grid.append(detailRow('издатели', details.publishers.join(', ')));
    grid.append(detailRow('платформы', platformText(details.platforms)));
    grid.append(detailRow('доступ', [
      details.isFree === true ? 'бесплатная (F2P)' : '',
      details.earlyAccess === true ? 'Early Access' : '',
    ].filter(Boolean).join(' · ')));
    grid.append(detailRow('метакритик', details.metacritic != null ? String(details.metacritic) : ''));
    grid.append(detailRow('DLC', details.dlcCount != null ? `${fmtInt(details.dlcCount)}` : ''));
    grid.append(detailRow('дата релиза', details.releaseDate));
    body.append(section('Что это за игра', grid));
  } else {
    body.append(section('Что это за игра', el('p', {
      class: 'game-note',
      text: 'Карточка Steam Store ещё не собрана: жанры, категории, разработчики и издатели неизвестны. Часы и достижения — из библиотеки и Community.',
    })));
  }

  body.append(renderCardAchievements(game));
  body.append(renderCardPersonnel(game));

  const links = [
    game.links.steam ? { label: 'Steam Store', href: game.links.steam } : null,
    game.links.community ? { label: 'Steam Community', href: game.links.community } : null,
    game.links.steamdb ? { label: 'SteamDB', href: game.links.steamdb } : null,
  ].filter(Boolean);
  if (links.length) {
    const row = el('div', { class: 'game-links' });
    for (const link of links) {
      row.append(el('a', {
        class: 'btn btn-ghost game-link',
        href: link.href,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: link.label,
      }));
    }
    body.append(section('Ссылки', row));
  }
}

/**
 * Lazy game card. Opens immediately with a loading state, then fills from
 * `GET /api/games/game/:appid`. A failure is shown inside the modal with a
 * retry button instead of a toast that disappears.
 */
export function openGameCardModal(appid, { fallback = null } = {}) {
  const id = Number(appid);
  if (!Number.isFinite(id) || id <= 0) {
    toast('У этой записи нет appid — карточку открыть нельзя', 'error');
    return null;
  }
  seq += 1;
  const titleId = `game-card-title-${seq}`;
  const head = el('div', { class: 'modal-head' });
  head.dataset.titleId = titleId;
  const copy = el('div', { class: 'modal-head-copy' });
  copy.append(el('div', { class: 'modal-role', text: 'Игра · Steam' }));
  copy.append(el('h2', {
    class: 'modal-title',
    id: titleId,
    text: fallback && fallback.name ? fallback.name : `appid ${id}`,
  }));
  copy.append(el('div', { class: 'modal-sub', text: 'Загружаем карточку…' }));
  head.append(copy);

  const body = el('div', { class: 'modal-body' });
  const loading = el('div', { class: 'games-personnel-loading' });
  loading.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
  loading.append(el('span', { text: 'Читаем карточку игры из кэша сервера…' }));
  body.append(loading);

  let closed = false;
  const modal = openModal({
    head,
    body,
    labelledBy: titleId,
    className: 'modal-game',
    onClose: () => { closed = true; },
  });
  if (!modal) return null;

  const load = async () => {
    clear(body);
    body.append(loading);
    try {
      const raw = await getGameDetails(id, { profile: context.profile });
      if (closed) return;
      const game = normalizeGameCard(raw);
      if (!game.name) game.name = fallback && fallback.name ? fallback.name : `appid ${id}`;
      fillGameCard({ head, copy, body, game });
    } catch (error) {
      if (closed) return;
      clear(body);
      if (error && error.status === 401) return;
      const message = error && error.status === 404
        ? 'Карточка этой игры не найдена в кэше сервера: appdetails ещё не собраны. Часы и достижения при этом доступны из библиотеки.'
        : shortErrorMessage(error);
      body.append(errorBox({
        title: 'Не удалось открыть карточку игры',
        message,
        actions: [{ label: 'Повторить', primary: true, onClick: load }],
      }));
    }
  };

  load();
  return modal;
}
