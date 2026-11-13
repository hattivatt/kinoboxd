import { arr, firstString, numOrNull, text } from '../../core/dom.js';
import { boolOrNull, toCount } from './common.js';

export function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const persona = firstString(raw.personaName, raw.persona, raw.name, raw.userKey, raw.key);
  if (!persona) return null;
  const memberSinceRaw = raw.memberSince ?? raw.timeCreated ?? null;
  const memberSinceSeconds = numOrNull(memberSinceRaw);
  const memberSince =
    memberSinceSeconds != null && memberSinceSeconds >= 100000000
      ? new Date(memberSinceSeconds * 1000).toISOString()
      : memberSinceRaw;
  return {
    key: text(raw.key),
    source: text(raw.source) || 'steam',
    userKey: text(raw.userKey),
    personaName: persona,
    avatarUrl: /^https?:\/\//i.test(text(raw.avatarUrl)) ? text(raw.avatarUrl) : '',
    privacy: text(raw.privacy).toLowerCase(),
    importedAt: text(raw.importedAt) || null,
    memberSince,
    gameCount: numOrNull(raw.gameCount),
    libraryPartial: boolOrNull(raw.libraryPartial),
  };
}

export function normalizeCardPersonnel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const people = arr(raw.people)
    .map((person) => {
      if (!person || typeof person !== 'object') return null;
      const name = firstString(person.name, person.label);
      if (!name) return null;
      return {
        name,
        roles: arr(person.roles).map((role) => text(role)).filter(Boolean),
        qid: text(person.qid) || null,
        sources: arr(person.sources).map((source) => text(source)).filter(Boolean),
      };
    })
    .filter(Boolean);
  const studios = arr(raw.studios)
    .map((studio) => {
      if (!studio || typeof studio !== 'object') return null;
      const name = firstString(studio.name, studio.label);
      if (!name) return null;
      return {
        name,
        roles: arr(studio.roles).map((role) => text(role)).filter(Boolean),
        qid: text(studio.qid) || null,
        sources: arr(studio.sources).map((source) => text(source)).filter(Boolean),
      };
    })
    .filter(Boolean);
  const coverage = raw.coverage && typeof raw.coverage === 'object'
    ? {
      people: toCount(raw.coverage.people),
      studios: toCount(raw.coverage.studios),
      roles: arr(raw.coverage.roles).map((role) => text(role)).filter(Boolean),
    }
    : null;
  if (!people.length && !studios.length && !coverage) return null;
  return {
    people,
    studios,
    coverage,
    pending: arr(raw.pending).map((entry) => text(entry)).filter(Boolean),
    sources: arr(raw.sources).map((source) => text(source)).filter(Boolean),
  };
}
