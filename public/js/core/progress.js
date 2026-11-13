import { numOrNull, text } from './dom.js';

export function progressPercent(status) {
  if (!status) return 0;
  const doneFlag = status.done || status.stage === 'done';
  const percentValue = numOrNull(status.percent);
  if (percentValue != null) {
    return Math.max(doneFlag ? 100 : 2, Math.min(100, Math.round(percentValue)));
  }
  const page = numOrNull(status.page ?? status.current);
  const pageTotal = numOrNull(status.pageTotal ?? status.totalPages ?? status.pagesTotal ?? status.pages);
  if (page != null && pageTotal && pageTotal > 0) {
    return Math.max(2, Math.min(100, Math.round((page / pageTotal) * 100)));
  }
  const batch = numOrNull(status.batch ?? status.batchIndex);
  const batchTotal = numOrNull(status.batchTotal ?? status.batchesTotal ?? status.batches);
  if (batch != null && batchTotal && batchTotal > 0) {
    return Math.max(2, Math.min(100, Math.round((batch / batchTotal) * 100)));
  }
  return doneFlag ? 100 : 0;
}

export function jobProgress(status) {
  if (!status || typeof status !== 'object') return 0;
  const explicit = numOrNull(status.percent ?? status.progress ?? status.pct);
  if (explicit != null) return Math.max(0, Math.min(100, explicit));
  const stage = text(status.stage || status.phase || status.status).toLowerCase();
  if (stage === 'done' || status.done === true) return 100;
  if (stage === 'failed' || status.failed === true) return 100;
  const weights = {
    start: 4, init: 8, queued: 6, bootstrap: 10, profile: 18, 'steam-profile': 18, community: 18,
    library: 52, 'owned-games': 52, games: 52, summaries: 62, achievements: 74, global: 84, stats: 92, done: 100,
  };
  return weights[stage] != null ? weights[stage] : 10;
}
