'use strict';

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (!entry) continue;
    const name = typeof entry === 'string' ? entry : entry.name;
    if (typeof name === 'string' && name.trim() && !out.includes(name.trim())) out.push(name.trim());
  }
  return out;
}

function normalizeTitle(title) {
  let value = cleanText(title).toLowerCase();
  value = value.replace(/ё/g, 'е');
  value = value.replace(/[«»“”„"']/g, ' ');
  value = value.replace(/[—–]/g, '-');
  value = value.replace(/\((?:[^()]*?(?:#\s*\d+|кн\.?\s*\d+|том\s*\d+|book\s*\d+)[^()]*?)\)/g, ' ');
  value = value.replace(
    /(?<![\p{L}])(?:кн\.?|том|часть|книга|book|vol(?:ume)?)\s*\d+/giu,
    ' '
  );
  value = value.replace(/#\s*\d+\b/g, ' ');
  const split = value.split(/\s*:\s*|\s+-\s+/);
  if (split.length > 1 && split[0].trim().split(/\s+/).filter(Boolean).length >= 3) {
    value = split[0];
  }
  value = value.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return value.replace(/\s+/g, ' ').trim();
}

function strictTitleKey(title) {
  return String(title == null ? '' : title)
    .replace(/\u00a0/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(
      /(?<![\p{L}])(?:vol(?:ume)?|том|книга|book|часть|кн)\s*\.?\s*(\d+)/giu,
      ' vol $1 '
    )
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(value) {
  return normalizeTitle(value).split(' ').filter(Boolean);
}

function tokenJaccard(left, right) {
  const a = new Set(tokensOf(left));
  const b = new Set(tokensOf(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function surnameOf(name) {
  const tokens = cleanText(name)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
  return tokens.length ? tokens[tokens.length - 1] : '';
}

function isbn10to13(isbn10) {
  const value = String(isbn10 == null ? '' : isbn10).replace(/[^\dXx]/g, '').toUpperCase();
  if (value.length !== 10) return null;
  const core = `978${value.slice(0, 9)}`;
  if (!/^\d{12}$/.test(core)) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return `${core}${check}`;
}

function isbn10Of(isbn13) {
  const value = String(isbn13 || '');
  if (!/^978\d{10}$/.test(value)) return null;
  const core = value.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(core[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return `${core}${check === 10 ? 'X' : check}`;
}

function normalizeIsbn(value) {
  const digits = String(value == null ? '' : value).replace(/[^\dXx]/g, '').toUpperCase();
  if (digits.length === 13) return digits;
  if (digits.length === 10) return isbn10to13(digits) || digits;
  return null;
}

const VOLUME_MARKER = /(?<![\p{L}])(?:том|книга|книги|часть|кн\.|vol(?:ume)?|book|#)\s*\.?\s*(\d{1,4})(?!\d)/iu;

function volumeNumberOf(title) {
  if (!title) return null;
  const text = String(title).normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
  const match = VOLUME_MARKER.exec(text);
  return match ? Number(match[1]) : null;
}

module.exports = {
  cleanText,
  volumeNumberOf,
  namesOf,
  normalizeTitle,
  strictTitleKey,
  tokensOf,
  tokenJaccard,
  surnameOf,
  isbn10to13,
  isbn10Of,
  normalizeIsbn,
};
