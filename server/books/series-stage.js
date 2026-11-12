'use strict';

const SOURCE = 'wikidata';

function hasSeries(doc) {
  return Boolean(
    doc && Array.isArray(doc.series) && doc.series.some((entry) => entry && entry.name)
  );
}

function seriesOfResult(result, source = SOURCE) {
  const list = Array.isArray(result && result.seriesAll) ? result.seriesAll : [];
  const entry = list.find((item) => item && String(item.name || '').trim());
  if (!entry) return null;
  const position = entry.position == null ? null : Number(entry.position);
  return {
    hcId: null,
    name: String(entry.name).trim(),
    position: Number.isFinite(position) && position > 0 ? position : null,
    source,
  };
}

function seriesCheckedAt(doc) {
  const ts = doc && doc.seriesCheckedAt ? Date.parse(String(doc.seriesCheckedAt)) : NaN;
  return Number.isFinite(ts) ? ts : null;
}

function needsSeriesQuestion(doc, nowMs, recheckDays) {
  if (hasSeries(doc)) return false;
  const ts = seriesCheckedAt(doc);
  if (ts == null) return true;
  const window = Number(recheckDays);
  if (!Number.isFinite(window) || window <= 0) return false;
  return nowMs - ts >= window * 24 * 60 * 60 * 1000;
}

function seriesPatch(doc, result, options = {}) {
  if (hasSeries(doc)) return null;
  const found = seriesOfResult(result);
  if (found) {
    return {
      series: [found],
      seriesCheckedAt: options.now || null,
      seriesCheckedBy: SOURCE,
    };
  }
  if (!options.asked) return null;
  return { seriesCheckedAt: options.now || null, seriesCheckedBy: SOURCE };
}

module.exports = {
  SERIES_SOURCE: SOURCE,
  hasSeries,
  seriesOfResult,
  seriesCheckedAt,
  needsSeriesQuestion,
  seriesPatch,
};
