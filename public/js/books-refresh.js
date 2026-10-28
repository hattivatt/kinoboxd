/**
 * Pure helpers for the books "↻ Обновить профиль" flow.
 *
 * Kept in a separate DOM-free module so the before/after event-count maths can
 * be unit-tested with `node --test` (no browser, no jsdom). `books.js` owns the
 * network/job orchestration and only calls these functions for the toast.
 *
 * A profile is ONE source (single-profile contract), so there is no per-source
 * breakdown any more: the toast compares the profile's own event count.
 */

const SOURCE_TITLE = { hardcover: 'Hardcover', livelib: 'LiveLib' };

function toCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

/**
 * Reduce a raw `/api/books/stats` payload to the numbers the refresh toast
 * compares. `undated` is reported separately: a deep scan that is still
 * running changes dates without changing the event count.
 */
export function snapshotCounts(payload) {
  const summary = payload && typeof payload === 'object' ? payload.summary : null;
  return {
    eventCount: summary ? toCount(summary.eventCount) : 0,
    datedCount: summary ? toCount(summary.finishedCount) : 0,
    undatedCount: summary ? toCount(summary.undatedEventCount) : 0,
  };
}

/**
 * Numeric before/after diff. `eventDelta` is `after - before` (negative when
 * the user deleted books from the source, which is exactly what the manual
 * refresh exists for).
 */
export function diffRefresh(before, after) {
  const left = before && typeof before === 'object' ? before : snapshotCounts(null);
  const right = after && typeof after === 'object' ? after : snapshotCounts(null);
  return {
    eventDelta: toCount(right.eventCount) - toCount(left.eventCount),
    datedDelta: toCount(right.datedCount) - toCount(left.datedCount),
    undatedDelta: toCount(right.undatedCount) - toCount(left.undatedCount),
  };
}

function deltaSuffix(diff) {
  if (diff.eventDelta > 0) return `+${diff.eventDelta} новых событий`;
  if (diff.eventDelta < 0) return `−${Math.abs(diff.eventDelta)} событий (удалены или скрыты)`;
  if (diff.datedDelta > 0) return `+${diff.datedDelta} событий с точной датой`;
  return 'данных новых нет';
}

/**
 * Toast text for a finished (or partially failed) profile refresh.
 *
 * @param {{eventCount:number,datedCount:number,undatedCount:number}} before
 * @param {{eventCount:number,datedCount:number,undatedCount:number}} after
 * @param {{source?:string, failure?:string, deep?:object}} [options]
 */
export function refreshToastMessage(before, after, options = {}) {
  const source = String(options.source || 'livelib').toLowerCase();
  const title = SOURCE_TITLE[source] || source;
  const failure = String(options.failure || '').trim();
  if (failure) {
    return `Не удалось обновить профиль ${title}: ${failure}`;
  }
  const diff = diffRefresh(before, after);
  const count = toCount(after && after.eventCount);
  const deep = options.deep && typeof options.deep === 'object' ? options.deep : null;
  const tail = deep && deep.done !== true && deep.pageTotal
    ? ` · история датируется в фоне (${Math.round(Number(deep.percent) || 0)}%)`
    : '';
  return `Профиль обновлён: ${title} ${count} (${deltaSuffix(diff)})${tail}`;
}

/**
 * Badge text for the "Обновить профиль" button while a deep scan runs in the
 * background. Empty string = no badge (job done or nothing running).
 */
export function deepBadgeText(deep) {
  if (!deep || typeof deep !== 'object') return '';
  if (deep.done === true) return '';
  const percent = Math.round(Number(deep.percent));
  if (!Number.isFinite(percent) || percent >= 100) return '';
  return `История ${Math.max(0, Math.min(99, percent))}%`;
}

/* ------------------------------------------------------------------ */
/* Metadata coverage badge                                            */
/* ------------------------------------------------------------------ */

function pluralBooks(count) {
  const n = Math.abs(toCount(count)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return 'книг ждут';
  if (n1 === 1) return 'книга ждёт';
  if (n1 >= 2 && n1 <= 4) return 'книги ждут';
  return 'книг ждут';
}

/**
 * View model of the "Метадата: N%" badge, or `null` when it must be hidden.
 *
 * Hidden when there is nothing to load (legacy payload, empty profile) and at
 * 100% — a fully enriched profile needs no apology. `running` adds the
 * «догружается…» suffix and the spinner; `budgetRemaining` (Litres books for
 * the current run) is only present while the job is alive.
 *
 * @param {{resolved:number,total:number,percent:number,running:boolean,budgetRemaining:?number}|null} meta
 */
export function metadataBadge(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const total = toCount(meta.total);
  if (total <= 0) return null;
  const resolved = Math.min(total, toCount(meta.resolved));
  const percent = Math.max(0, Math.min(100, Math.round(Number(meta.percent))));
  if (!Number.isFinite(percent) || percent >= 100) return null;
  const pending = total - resolved;
  const running = meta.running === true;
  const budget = meta.budgetRemaining != null && Number.isFinite(Number(meta.budgetRemaining))
    ? Math.max(0, Math.floor(Number(meta.budgetRemaining)))
    : null;
  const budgetNote = budget != null
    ? ` Литрес-бюджет на этот прогон: ${budget} ${budget === 1 ? 'книга' : 'книг(и)'}.`
    : '';
  const next = running
    ? ' Метадата догружается прямо сейчас — цифра обновится сама.'
    : ' Следующая порция — при обновлении профиля.';
  return {
    percent,
    resolved,
    total,
    pending,
    running,
    budgetRemaining: budget,
    text: running ? `Метадата: ${percent}% · догружается…` : `Метадата: ${percent}%`,
    hint:
      `${pending} ${pluralBooks(pending)} метадату ` +
      `(${resolved} из ${total} уже с жанрами/сериями/годом).${budgetNote}${next}`,
  };
}

