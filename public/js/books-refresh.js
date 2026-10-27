/**
 * Pure helpers for the books "↻ Обновить профиль" flow.
 *
 * Kept in a separate DOM-free module so the before/after event-count maths can
 * be unit-tested with `node --test` (no browser, no jsdom). `books.js` owns the
 * network/job orchestration and only calls these functions for the toast.
 */

export const REFRESH_SOURCES = ['hardcover', 'livelib'];

const SOURCE_TITLE = { hardcover: 'Hardcover', livelib: 'LiveLib' };

function toCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

/**
 * Reduce a raw `/api/books/stats` payload to the numbers the refresh toast
 * compares. `eventCount` is the union count (all selected sources), while
 * `bySource` keeps the per-source counts from `sourceBreakdown`.
 */
export function snapshotCounts(payload) {
  const summary = payload && typeof payload === 'object' ? payload.summary : null;
  const bySource = {};
  const breakdown = payload && Array.isArray(payload.sourceBreakdown) ? payload.sourceBreakdown : [];
  for (const item of breakdown) {
    if (!item || typeof item !== 'object') continue;
    const source = String(item.source || '').trim().toLowerCase();
    if (!source) continue;
    bySource[source] = toCount(item.events);
  }
  return {
    eventCount: summary ? toCount(summary.eventCount) : 0,
    bySource,
  };
}

/**
 * Numeric before/after diff. `eventDelta` is `after - before` (negative when
 * the user deleted books from a source, which is exactly what the manual
 * refresh exists for).
 */
export function diffRefresh(before, after) {
  const left = before && typeof before === 'object' ? before : { eventCount: 0, bySource: {} };
  const right = after && typeof after === 'object' ? after : { eventCount: 0, bySource: {} };
  const sources = new Set([
    ...Object.keys(left.bySource || {}),
    ...Object.keys(right.bySource || {}),
    ...REFRESH_SOURCES,
  ]);
  const bySource = {};
  for (const source of sources) {
    const from = toCount(left.bySource && left.bySource[source]);
    const to = toCount(right.bySource && right.bySource[source]);
    bySource[source] = { before: from, after: to, delta: to - from };
  }
  return {
    eventDelta: toCount(right.eventCount) - toCount(left.eventCount),
    bySource,
  };
}

function deltaSuffix(delta) {
  if (delta > 0) return `+${delta} новых событий`;
  if (delta < 0) return `−${Math.abs(delta)} событий (удалены или скрыты)`;
  return 'данных новых нет';
}

/**
 * Toast text for a finished (or partially failed) profile refresh.
 *
 * Both sources are always named: a manual refresh is explicitly a two-source
 * check, and a silently missing source would look like the button did nothing.
 *
 * @param {{eventCount:number,bySource:object}} before
 * @param {{eventCount:number,bySource:object}} after
 * @param {{sources?:string[], failures?:object}} [options]
 */
export function refreshToastMessage(before, after, options = {}) {
  const sources = Array.isArray(options.sources) && options.sources.length
    ? options.sources.map((source) => String(source).toLowerCase())
    : REFRESH_SOURCES;
  const failures = options.failures && typeof options.failures === 'object' ? options.failures : {};
  const diff = diffRefresh(before, after);

  const okParts = [];
  const failedParts = [];
  for (const source of sources) {
    if (failures[source]) {
      const message = String(failures[source] || '').trim();
      failedParts.push(`${SOURCE_TITLE[source] || source}: ошибка${message ? ` — ${message}` : ''}`);
      continue;
    }
    const count = diff.bySource[source] ? diff.bySource[source].after : 0;
    okParts.push(`${source} ${count}`);
  }

  if (!okParts.length) {
    return `Не удалось обновить профиль: ${failedParts.join(' · ')}`;
  }

  const suffix = deltaSuffix(diff.eventDelta);
  const base = `Профиль обновлён: ${okParts.join(' · ')} (${suffix})`;
  return failedParts.length ? `${base} · ${failedParts.join(' · ')}` : base;
}
