/* M6a: the «Источники» widget — Steam as the journal, GOG/Epic as same-owner
 * secondary libraries. Split out of `games-view.js`; wording and numbers are
 * unchanged, only the definition moved.
 */

import { arr, numOrNull, text } from '../core/dom.js';
import { fmtInt, plural } from '../ui.js';
import { SECONDARY_WORK_PLURAL, formatDateRu } from './labels.js';
import { toCount } from './normalize/common.js';
import { secondaryChartStatus } from './normalize/secondary.js';
import { asSecondaryWork } from './secondary-card.js';

const GOG_STATUS_LABEL = {
  ok: 'подключён',
  stale: 'данные устарели',
  auth_expired: 'требуется переподключение',
  connected_no_import: 'подключён, библиотека не импортирована',
  not_connected: 'не подключён',
  snapshot_only: 'GOG отключён — показан сохранённый снимок',
};

/** Human status of the GOG source: never a bare `status` code in the UI. */
export function gogStatusText(status, fetchedAt = null) {
  const key = text(status) || 'not_connected';
  const base = GOG_STATUS_LABEL[key] || key;
  const date = formatDateRu(fetchedAt);
  if (key === 'ok' && date) return `данные от ${date}`;
  if (key === 'snapshot_only' && date) return `снимок от ${date} — подключите GOG заново`;
  if (key === 'stale' && date) return `данные от ${date} — обновим`;
  return base;
}

/**
 * View model for the «Источники» widget. Steam is the journal (its hours are
 * the headline); GOG and Epic are same-owner secondary libraries and their
 * hours are **separate** numbers — the view model never adds them together
 * (§14.4 п. 2). A library that is not connected shows a connect hint instead
 * of a fake zero.
 */
export function gogSourcesView(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const summary = p.summary && typeof p.summary === 'object' ? p.summary : {};
  const sources = p.sources && typeof p.sources === 'object' ? p.sources : {};
  const gog = sources.gog && typeof sources.gog === 'object' ? sources.gog : {};
  const epic = sources.epic && typeof sources.epic === 'object' ? sources.epic : {};
  const hoursBySource = summary.hoursBySource && typeof summary.hoursBySource === 'object'
    ? summary.hoursBySource
    : {};
  const ownedBySource = summary.ownedBySource && typeof summary.ownedBySource === 'object'
    ? summary.ownedBySource
    : {};
  const gogConnected = gog.connected === true || gog.configured === true;
  const gogHasData = gogConnected || numOrNull(gog.productCount) != null;
  const gogStatus = gogConnected ? text(gog.status) || 'ok' : text(gog.status) || 'not_connected';
  const gogFetchedAt = gog.libraryFetchedAt || gog.lastImportAt || null;
  const epicConnected = epic.connected === true || epic.configured === true;
  const epicHasData = epicConnected || numOrNull(epic.productCount) != null;
  const epicStatus = epicConnected ? text(epic.status) || 'ok' : text(epic.status) || 'not_connected';
  const epicFetchedAt = epic.libraryFetchedAt || epic.lastImportAt || null;
  // A disconnected Epic account keeps its dated snapshot (the layer reports
  // `not_connected` with a summary, never zeros) — say «снимок», not «не
  // подключён», while numbers are on screen.
  const epicSnapshot = !epicConnected && numOrNull(epic.productCount) != null;
  const epicStatusText = epicSnapshot
    ? (formatDateRu(epicFetchedAt)
        ? `снимок от ${formatDateRu(epicFetchedAt)} — подключите Epic заново`
        : 'снимок — подключите Epic заново')
    : gogStatusText(epicStatus, epicFetchedAt);
  const secondaryWorks = arr(p.secondaryWorks).map(asSecondaryWork).filter(Boolean);
  const secondaryOnly =
    toCount(summary.secondaryWorksTotal)
    || toCount(summary.secondaryOnlyWorks)
    || secondaryWorks.length;
  // `summary.worksTotal` is the union over `workKey`; when a backend has not
  // sent it yet, the honest fallback is Steam works + secondary-only works
  // (overlapping GOG/Epic rows are already excluded from `secondaryOnly`).
  const steamWorks = numOrNull(summary.gameCount);
  const worksTotal = numOrNull(summary.worksTotal)
    ?? (steamWorks != null ? steamWorks + secondaryOnly : null);
  // `normalizeGamesPayload` keeps the raw chart flags on the top-level
  // `secondaryChart`; a raw `/stats` payload is read directly.
  const secondaryChart = p.secondaryChart && typeof p.secondaryChart === 'object'
    ? p.secondaryChart
    : secondaryChartStatus(p);
  // Per-source hours for the compact «Вне Steam» summary line. They are never
  // added together: GOG and Epic are separate libraries.
  const secondaryHours = [
    { source: 'gog', label: 'GOG', hours: numOrNull(hoursBySource.gog) },
    { source: 'epic', label: 'Epic', hours: numOrNull(hoursBySource.epic) },
  ].filter((row) => row.hours != null);

  const rows = [
    {
      key: 'steam',
      label: 'Steam',
      games: numOrNull(ownedBySource.steam) ?? numOrNull(summary.ownedCount),
      hours: numOrNull(hoursBySource.steam) ?? numOrNull(summary.totalHours),
      status: 'ok',
      statusText: 'журнал',
      journal: true,
      canConnect: false,
    },
    {
      key: 'gog',
      label: 'GOG',
      games: gogHasData ? numOrNull(ownedBySource.gog) ?? numOrNull(gog.productCount) : null,
      hours: gogHasData ? numOrNull(hoursBySource.gog) ?? numOrNull(gog.hours) : null,
      status: gogStatus,
      statusText: gogStatusText(gogStatus, gogFetchedAt),
      fetchedAt: gogFetchedAt,
      username: text(gog.username) || null,
      journal: false,
      canConnect: !gogConnected,
    },
    {
      key: 'epic',
      label: 'Epic Games Store',
      games: epicHasData ? numOrNull(ownedBySource.epic) ?? numOrNull(epic.productCount) : null,
      hours: epicHasData ? numOrNull(hoursBySource.epic) ?? numOrNull(epic.hours) : null,
      status: epicStatus,
      statusText: epicStatusText,
      fetchedAt: epicFetchedAt,
      username: text(epic.displayName) || null,
      journal: false,
      // The Epic card itself lives in «Подключения»; the row only links there
      // (no second connect form), so an unconnected Epic still offers the link.
      canConnect: !epicConnected,
    },
  ];

  return {
    rows,
    gogConnected,
    gogStatus,
    gogStatusText: gogStatusText(gogStatus, gogFetchedAt),
    epicConnected,
    epicStatus,
    epicStatusText,
    secondaryOnly,
    secondaryWorks,
    secondaryHours,
    secondaryChart,
    worksTotal,
    unionText: worksTotal != null
      ? `${fmtInt(worksTotal)} ${plural(worksTotal, SECONDARY_WORK_PLURAL)} в объединённой библиотеке`
        + (secondaryOnly > 0 ? ` (включая вне Steam: ${fmtInt(secondaryOnly)})` : '')
      : '',
  };
}
