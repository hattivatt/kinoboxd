'use strict';

const OPENERS = '([{';
const CLOSERS = ')]}';
const TRAILING_GROUP = /\s*[([{][^()[\]{}]*[)\]}]$/u;
const TRAILING_SEPARATOR = /[\s,;:–—-]+$/u;
const TRAILING_VOLUME =
  /[\s,;:.(\[]+(?:(?:vol(?:ume)?|book|part|том|книга|кн|часть)\.?\s*|#\s*)?(\d{1,3})[)\]}.]?$/iu;

function collapseSpace(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

function stripUnbalanced(text) {
  const opens = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (OPENERS.includes(char)) {
      opens.push(index);
      continue;
    }
    if (!CLOSERS.includes(char)) continue;
    if (!opens.length) return text.slice(0, index);
    opens.pop();
  }
  return opens.length ? text.slice(0, opens[0]) : text;
}

function sanitizeSeriesName(raw) {
  let text = collapseSpace(String(raw == null ? '' : raw).normalize('NFKC'));
  for (let pass = 0; pass < 8 && text; pass += 1) {
    const balanced = stripUnbalanced(text);
    if (balanced !== text) {
      text = collapseSpace(balanced);
      continue;
    }
    const stripped = collapseSpace(
      text.replace(TRAILING_SEPARATOR, '').replace(TRAILING_GROUP, '').replace(TRAILING_SEPARATOR, '')
    );
    if (stripped !== text) {
      text = stripped;
      continue;
    }
    break;
  }
  return text;
}

function seriesKeyOf(raw) {
  return sanitizeSeriesName(raw)
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
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
