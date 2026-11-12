'use strict';

const OPENERS = '([{';
const CLOSERS = ')]}';
const TRAILING_GROUP = /\s*[([{][^()[\]{}]*[)\]}]$/u;
const TRAILING_SEPARATOR = /[\s,;:–—-]+$/u;

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

function normalizeSeriesName(name) {
  return sanitizeSeriesName(name)
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim();
}

module.exports = {
  sanitizeSeriesName,
  seriesKeyOf,
  normalizeSeriesName,
};
