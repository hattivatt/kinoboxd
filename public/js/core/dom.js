/* Shared DOM/coercion helpers for the tab controllers (U12, P8).
 *
 * These were byte-identical copies in `books.js`, `games.js`,
 * `games-view.js`, `games-epic.js` and `widgets.js`:
 *
 *   - `text` / `firstString` / `arr` / `numOrNull` — tolerant payload readers;
 *   - `safeStorageGet/Set/Remove` — localStorage in private mode must not throw;
 *   - `setLoadingVisible` — the `$('…-loading').hidden = !visible` pattern.
 *
 * Nothing here knows a domain: core must not import books/games/main.
 */

export function text(value) {
  return value == null ? '' : String(value).trim();
}

export function firstString(...values) {
  for (const value of values) {
    const s = text(value);
    if (s) return s;
  }
  return '';
}

export function arr(value) {
  return Array.isArray(value) ? value : [];
}

export function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function safeStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode — the flow still works for this session */
  }
}

export function safeStorageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Toggle a screen's loader by id; a missing node is fine (headless tests). */
export function setLoadingVisible(id, visible) {
  const node = document.getElementById(id);
  if (node) node.hidden = !visible;
}
