const SOURCE_TITLE = { hardcover: 'Hardcover', livelib: 'LiveLib' };

function toCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

export function snapshotCounts(payload) {
  const summary = payload && typeof payload === 'object' ? payload.summary : null;
  return {
    eventCount: summary ? toCount(summary.eventCount) : 0,
    datedCount: summary ? toCount(summary.finishedCount) : 0,
    undatedCount: summary ? toCount(summary.undatedEventCount) : 0,
  };
}

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

export function refreshToastMessage(before, after, options = {}) {
  const source = String(options.source || 'livelib').toLowerCase();
  const title = SOURCE_TITLE[source] || source;
  const failure = String(options.failure || '').trim();
  if (failure) {
    return `Не удалось обновить профиль ${title}: ${failure}`;
  }
  const diff = diffRefresh(before, after);
  const count = toCount(after && after.eventCount);
  return `Профиль обновлён: ${title} ${count} (${deltaSuffix(diff)})`;
}

function pluralBooks(count) {
  const n = Math.abs(toCount(count)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return 'книг ждут';
  if (n1 === 1) return 'книга ждёт';
  if (n1 >= 2 && n1 <= 4) return 'книги ждут';
  return 'книг ждут';
}

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
    }
  }
  return result;
}

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
  const keyless = meta.keyless == null ? 0 : Math.max(0, toCount(meta.keyless));
  const linked = meta.linked == null ? null : Math.max(0, toCount(meta.linked));
  const unlinked = meta.unlinked == null ? 0 : Math.max(0, toCount(meta.unlinked));
  const pending = Math.max(0, resolvable - resolved);
  const running = meta.running === true;
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
  const keylessNote = keyless > 0
    ? ` ${keyless} ${keyless === 1 ? 'книга' : 'книг'} без ключа привязки (в знаменатель не входят).`
    : '';
  const unlinkedNote = unlinked > 0
    ? ` Всего без привязки к метаданным: ${unlinked} ${unlinked === 1 ? 'книга' : 'книг'}.`
    : '';
  const linkedNote = linked != null ? ` Из них ${linked} с привязкой к провайдеру.` : '';
  const next = running
    ? ' Метадата догружается прямо сейчас — цифра обновится сама.'
    : ' Следующая порция — по расписанию (kinoboxd-resolve-books).';
  return {
    percent,
    resolved,
    total,
    resolvable,
    hopeless,
    keyless,
    linked,
    unlinked,
    pending,
    running,
    done: running ? false : pending === 0,
    budgetRemaining: budget,
    text: running ? `Метадата: ${percent}% · догружается…` : `Метадата: ${percent}%`,
    hint:
      `${pending} ${pluralBooks(pending)} метадату ` +
      `(${resolved} из ${resolvable} резолвимых уже с жанрами/сериями/годом).` +
      `${linkedNote}${hopelessNote}${keylessNote}${unlinkedNote}${budgetNote}${next}`,
  };
}

