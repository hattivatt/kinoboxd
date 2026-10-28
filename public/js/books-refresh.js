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
 * Run a synchronous render and return the window scroll to where it was.
 *
 * The books dashboard re-renders its whole DOM while the metadata resolve is
 * polled (every ~5 s). Removing a tall container and building it again can
 * clamp/restore the window scroll, which the user sees as the page jumping to
 * the top (user report, 28.10.2026). `getY`/`setY` are injected so the rule is
 * unit-testable without a DOM: only a non-zero scroll is restored, and a
 * rendering that already preserved the position is left alone.
 */
export function withPreservedScroll(getY, setY, render) {
  const read = typeof getY === 'function' ? getY : () => 0;
  const write = typeof setY === 'function' ? setY : () => {};
  const before = Number(read()) || 0;
  const result = typeof render === 'function' ? render() : undefined;
  const after = Number(read()) || 0;
  if (before > 0 && after !== before) {
    try {
      write(before);
    } catch {
      /* a scroll restore must never break the render */
    }
  }
  return result;
}

/**
 * View model of the "Метадата: N%" badge, or `null` when it must be hidden.
 *
 * Hidden when there is nothing to load (legacy payload, empty profile) and at
 * `pending === 0` — a fully enriched profile needs no apology. `resolvable`
 * (server-side) is the pool minus works the providers were asked about and
 * answered nothing for; `hopeless` is that excluded tail, reported in the
 * hint instead of pinning the badge at 99% forever. `running` adds the
 * «догружается…» suffix and the spinner; `budgetRemaining` (Litres books for
 * the current run) is only present while the job is alive.
 *
 * @param {{resolved:number,total:number,resolvable?:number,hopeless?:number,percent:number,running:boolean,done?:boolean,budgetRemaining:?number}|null} meta
 */
export function metadataBadge(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const total = toCount(meta.total);
  if (total <= 0) return null;
  const resolved = Math.min(total, toCount(meta.resolved));
  const resolvable = meta.resolvable == null
    ? total
    : Math.min(total, toCount(meta.resolvable));
  const hopeless = meta.hopeless == null
    ? Math.max(0, total - resolvable)
    : Math.max(0, toCount(meta.hopeless));
  const pending = Math.max(0, resolvable - resolved);
  const running = meta.running === true;
  // Nothing left in the resolvable pool: no badge, whatever the raw total is
  // (and even while a pass is still walking hopeless keys).
  if (pending === 0) return null;
  const percent = Math.max(0, Math.min(100, Math.round(Number(meta.percent))));
  if (!Number.isFinite(percent)) return null;
  const budget = meta.budgetRemaining != null && Number.isFinite(Number(meta.budgetRemaining))
    ? Math.max(0, Math.floor(Number(meta.budgetRemaining)))
    : null;
  const budgetNote = budget != null
    ? ` Литрес-бюджет на этот прогон: ${budget} ${budget === 1 ? 'книга' : 'книг(и)'}.`
    : '';
  const hopelessNote = hopeless > 0
    ? ` Ещё ${hopeless} ${hopeless === 1 ? 'книга' : 'книг'} без метаданных у провайдеров — в знаменатель не входят.`
    : '';
  const next = running
    ? ' Метадата догружается прямо сейчас — цифра обновится сама.'
    : ' Следующая порция — при обновлении профиля.';
  return {
    percent,
    resolved,
    total,
    resolvable,
    hopeless,
    pending,
    running,
    done: running ? false : pending === 0,
    budgetRemaining: budget,
    text: running ? `Метадата: ${percent}% · догружается…` : `Метадата: ${percent}%`,
    hint:
      `${pending} ${pluralBooks(pending)} метадату ` +
      `(${resolved} из ${resolvable} резолвимых уже с жанрами/сериями/годом).` +
      `${hopelessNote}${budgetNote}${next}`,
  };
}

