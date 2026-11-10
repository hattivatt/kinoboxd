'use strict';

/**
 * People aggregation (actors, directors, writers, composers, studios).
 *
 * A bucket is a Map id → { id, name, profilePath, films: Map }. Every role is
 * recorded with its `counted` flag and the reason it is not counted, so the
 * frontend never guesses from the character string.
 */

function bucketAdd(bucket, person) {
  let entry = bucket.get(person.id);
  if (!entry) {
    entry = {
      id: person.id,
      name: person.name || '',
      profilePath: person.profile_path || null,
      films: new Map(),
    };
    bucket.set(person.id, entry);
  } else if (!entry.profilePath && person.profile_path) {
    entry.profilePath = person.profile_path;
  }
  return entry;
}

function addRole(bucket, person, filmSlug, counted, extra) {
  if (!person || person.id == null) return;
  const entry = bucketAdd(bucket, person);
  const existing = entry.films.get(filmSlug);
  if (!existing) {
    const row = { filmSlug, counted, ...extra };
    if (!counted) {
      const reason = (extra && extra.reason) || null;
      if (reason) row.reason = reason;
    }
    entry.films.set(filmSlug, row);
  } else if (counted && !existing.counted) {
    existing.counted = true;
    delete existing.reason;
    Object.assign(existing, extra);
  }
}

function serializePeople(bucket, onlyCounted) {
  const list = [];
  for (const entry of bucket.values()) {
    const films = [...entry.films.values()];
    const counted = films.filter((f) => f.counted).length;
    if (onlyCounted && counted < 1) continue;
    list.push({
      id: entry.id,
      name: entry.name,
      profilePath: entry.profilePath,
      counted,
      total: films.length,
      films,
    });
  }
  list.sort((a, b) => {
    if (b.counted !== a.counted) return b.counted - a.counted;
    return a.name.localeCompare(b.name, 'ru');
  });
  return list;
}

/** The five person buckets of the payload, in its key order. */
function buildPersons(ctx) {
  return {
    actor: serializePeople(ctx.actors, true),
    director: serializePeople(ctx.directors, false),
    writer: serializePeople(ctx.writers, false),
    composer: serializePeople(ctx.composers, false),
    studio: serializePeople(ctx.studios, true),
  };
}

module.exports = {
  bucketAdd,
  addRole,
  serializePeople,
  buildPersons,
};
