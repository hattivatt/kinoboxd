'use strict';

const { normalizeAuthorName } = require('../authors');

const MIN_LENGTH = 2;
const MAX_LENGTH = 160;

const NOISE = /\s*\((?:сборник|комплект[^)]*|\+[^)]*|подарочное издание|адаптированн[^)]*|in russian|на английском языке|на русском языке)\)/giu;
const COUNT_WORD = '(?:\\d+|двух|трех|трёх|четырех|четырёх|пяти|шести|семи|восьми|девяти|десяти)';
const VOLUME_SET = new RegExp(
  `[.,:]?\\s*(?:роман\\s+)?в\\s+${COUNT_WORD}\\s+(?:томах|книгах|частях)(?=$|[.,:;\\s])`,
  'iu'
);
const VOLUME_TAIL = /[.,:]?\s*(?:том|книга|книги|часть|части|vol\.?|volume|book)\s+(?:\d+|[ivxlc]+)(?:\s*(?:и|-|–|—)\s*(?:\d+|[ivxlc]+))?\s*$/iu;

function squash(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function withoutNoise(title) {
  return squash(squash(title).replace(NOISE, ' '));
}

function withoutVolume(title) {
  let value = squash(title);
  for (let pass = 0; pass < 2; pass++) {
    value = squash(value.replace(VOLUME_TAIL, ''));
    value = squash(value.replace(VOLUME_SET, ''));
  }
  return value.replace(/[.,:;]+$/, '').trim();
}

function sentenceCase(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : value;
}

function baseForms(title) {
  const raw = squash(title);
  if (raw.length < MIN_LENGTH) return [];
  const out = [raw];
  const noDots = raw.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
  out.push(noDots);
  const stripped = squash(noDots.replace(/[«»"'“”„`]/g, ''));
  out.push(stripped);
  if (/\s-\s/.test(stripped)) out.push(stripped.replace(/\s-\s/g, ' — '));
  if (stripped) out.push(stripped.charAt(0).toLowerCase() + stripped.slice(1));
  const head = stripped.split(/\s*[;:]\s*/)[0].trim();
  if (head) out.push(head);
  const beforeComma = stripped.split(/,\s*/)[0].trim();
  if (beforeComma) out.push(beforeComma);
  return out;
}

function expand(titles) {
  const out = new Set();
  for (const title of titles) {
    for (const form of baseForms(title)) out.add(form);
  }
  for (const form of [...out]) out.add(sentenceCase(form));
  return [...out].filter((value) => value.length >= MIN_LENGTH && value.length <= MAX_LENGTH);
}

function titleVariants(title) {
  const raw = squash(title);
  if (raw.length < MIN_LENGTH) return [];
  const clean = withoutNoise(raw);
  const roots = [raw, clean];
  const halves = clean.split(/\s+\/\s+/).filter(Boolean);
  if (halves.length > 1) roots.push(...halves);
  return expand(roots);
}

function authorKeys(authors) {
  const keys = new Set();
  for (const name of Array.isArray(authors) ? authors : []) {
    const key = normalizeAuthorName(name);
    if (!key) continue;
    keys.add(key);
    const tokens = key.split(' ');
    keys.add(tokens[tokens.length - 1]);
    keys.add(tokens[0]);
  }
  return keys;
}

function partVariants(title, authors = []) {
  const clean = withoutNoise(title);
  const noVolume = withoutVolume(clean);
  const subtitle = [];
  const whole = [];
  if (noVolume && noVolume !== clean) whole.push(noVolume);
  const parts = noVolume.split(/\.\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 2) {
    subtitle.push(parts[1]);
    whole.push(parts[0]);
  }
  const taken = new Set(titleVariants(title));
  const banned = authorKeys(authors);
  const keep = (list) =>
    expand(list).filter(
      (value) => !taken.has(value) && !banned.has(normalizeAuthorName(value))
    );
  const subtitleForms = keep(subtitle);
  const subtitleSet = new Set(subtitleForms);
  return {
    subtitle: subtitleForms,
    whole: keep(whole).filter((value) => !subtitleSet.has(value)),
  };
}

module.exports = {
  titleVariants,
  partVariants,
  withoutNoise,
  withoutVolume,
};
