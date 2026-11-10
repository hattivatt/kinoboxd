/* M6c: client-side cards for secondary (non-Steam) works.
 *
 * Split out of `games-view.js` so the «Источники» widget and the games modal
 * card share one normaliser for a GOG/Epic-only work.
 */

import {
  SECONDARY_SOURCE_LABELS, SECONDARY_SOURCE_ORDER, normalizeSecondaryWork,
} from './normalize/secondary.js';
import { hoursText } from './normalize/common.js';

export function asSecondaryWork(work) {
  if (!work || typeof work !== 'object') return null;
  if (work.sourceLabels && work.hoursBySource && work.name) return work;
  return normalizeSecondaryWork(work);
}

/**
 * Client-side card for a secondary work. No network: Steam has no card for a
 * GOG/Epic-only game, and inventing one would be a lie. Every source gets its
 * own hours row, never a combined total.
 */
export function secondaryWorkCardView(work) {
  const row = asSecondaryWork(work);
  if (!row) return null;
  const hourRows = SECONDARY_SOURCE_ORDER.map((source) => {
    const present = row.sources.includes(source) || row.hoursBySource[source] != null;
    const hours = row.hoursBySource[source];
    const known = row.hoursKnown !== false;
    let status = '';
    if (!present) status = 'нет в библиотеке';
    else if (!known || hours == null) status = 'часы не получены';
    else if (hours === 0) status = 'не запущена';
    return {
      source,
      label: SECONDARY_SOURCE_LABELS[source] || source,
      present,
      hours: known ? hours : null,
      hoursText: known && hours != null ? hoursText(hours) : '',
      status,
    };
  });
  return {
    ...row,
    hourRows,
    hasKnownHours: hourRows.some((item) => item.hours != null),
    title: row.name,
    subtitle: [
      row.releaseYear ? String(row.releaseYear) : '',
      row.hoursText,
    ].filter(Boolean).join(' · '),
    note: 'Игра есть только вне Steam: карточка Steam Store, достижения и кредиты для неё не запрашиваются. '
      + 'Данные взяты из объединённой модели источников.',
  };
}
