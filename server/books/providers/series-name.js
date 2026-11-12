'use strict';

const { sanitizeSeriesName, seriesKeyOf } = require('../series-identity');

const TRAILING_VOLUME =
  /[\s,;:.(\[]+(?:(?:vol(?:ume)?|book|part|том|книга|кн|часть)\.?\s*|#\s*)?(\d{1,3})[)\]}.]?$/iu;
const TRAILING_SEPARATOR = /[\s,;:–—-]+$/u;

function collapseSpace(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

function splitVolume(raw) {
  const text = collapseSpace(String(raw == null ? '' : raw).normalize('NFKC'));
  const match = TRAILING_VOLUME.exec(text);
  if (!match) return { name: text, position: null };
  const head = collapseSpace(text.slice(0, match.index).replace(TRAILING_SEPARATOR, ''));
  if (!head) return { name: text, position: null };
  const position = Number(match[1]);
  if (!Number.isFinite(position) || position <= 0) return { name: text, position: null };
  return { name: head, position };
}

function seriesEntryOf(raw, options = {}) {
  if (raw == null) return null;
  const record = typeof raw === 'object' ? raw : null;
  const rawName = record ? record.name : raw;
  if (typeof rawName !== 'string' && typeof rawName !== 'number') return null;
  const parts = splitVolume(rawName);
  const name = sanitizeSeriesName(parts.name);
  if (!name) return null;
  const explicit = record && record.position != null && record.position !== '' ? Number(record.position) : null;
  const position = Number.isFinite(explicit) && explicit > 0 ? explicit : parts.position;
  const source = (record && record.source) || options.source || null;
  return {
    name,
    position,
    ...(record && record.hcId != null ? { hcId: record.hcId } : {}),
    ...(source ? { source: String(source) } : {}),
  };
}

function seriesEntriesOf(values, options = {}) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const entry = seriesEntryOf(value, options);
    if (entry) out.push(entry);
  }
  return out;
}

module.exports = {
  sanitizeSeriesName,
  seriesKeyOf,
  seriesEntryOf,
  seriesEntriesOf,
};
