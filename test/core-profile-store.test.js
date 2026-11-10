'use strict';

/*
 * Shared client profile registry (public/js/core/profile-store.js).
 *
 * The headless DOM shim has no IndexedDB, so the store API is exercised through
 * its memory fallback — the same path a private-mode browser takes. The
 * IndexedDB-only part (opening the new database, copying the two legacy
 * databases into it, writing the `schemaVersion` marker) is covered twice:
 *  - the pure decision/merge helpers (`needsMigration`, `dedupeEntries`,
 *    `legacyEntry`) that build the migration plan, tested directly;
 *  - a small in-test IndexedDB double (open/upgrade/transaction/objectStore,
 *    no cursors) that runs the real `ready()` of a fresh module instance over
 *    seeded legacy databases, so the copy and the one-shot marker are executed
 *    as written, not simulated.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { installDom } = require('./helpers/dom-shim.js');

installDom();

const STORE = '../public/js/core/profile-store.js';
const FILMS = '../public/js/profiles.js';
const BOOKS = '../public/js/books-profiles.js';

function freshStore(tag) {
  return import(`${STORE}?${tag}`);
}

function createFakeIndexedDB(seed = {}) {
  const databases = new Map();
  const opened = new Map();
  const clone = (value) => (value == null || typeof value !== 'object' ? value : structuredClone(value));

  class Request {
    constructor() {
      this.result = undefined;
      this.error = null;
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
      this.onblocked = null;
    }
  }

  class Table {
    constructor(keyPath) {
      this.keyPath = keyPath;
      this.records = new Map();
    }
  }

  class Transaction {
    constructor(db, names) {
      this.db = db;
      this.names = Array.isArray(names) ? names : [names];
      this.error = null;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this.pending = 0;
      this.done = false;
    }

    objectStore(name) {
      const table = this.db.tables.get(name);
      if (!table) throw new Error(`object store ${name} is missing`);
      return new Store(this, table);
    }

    run(action) {
      const request = new Request();
      this.pending += 1;
      setTimeout(() => {
        this.pending -= 1;
        try {
          request.result = action();
        } catch (error) {
          request.error = error;
          if (request.onerror) request.onerror();
          return;
        }
        if (request.onsuccess) request.onsuccess();
        this.complete();
      }, 0);
      return request;
    }

    complete() {
      if (this.pending) return;
      setTimeout(() => {
        if (this.pending || this.done) return;
        this.done = true;
        if (this.oncomplete) this.oncomplete();
      }, 0);
    }
  }

  class Store {
    constructor(transaction, table) {
      this.transaction = transaction;
      this.table = table;
    }

    put(value) {
      return this.transaction.run(() => {
        const key = value[this.table.keyPath];
        this.table.records.set(key, clone(value));
        return key;
      });
    }

    get(key) {
      return this.transaction.run(() => (this.table.records.has(key) ? clone(this.table.records.get(key)) : undefined));
    }

    getAll() {
      return this.transaction.run(() => [...this.table.records.values()].map(clone));
    }

    delete(key) {
      return this.transaction.run(() => {
        this.table.records.delete(key);
        return undefined;
      });
    }

    clear() {
      return this.transaction.run(() => {
        this.table.records.clear();
        return undefined;
      });
    }
  }

  class Database {
    constructor(name) {
      this.name = name;
      this.version = 0;
      this.tables = new Map();
    }

    get objectStoreNames() {
      const names = [...this.tables.keys()];
      names.contains = (name) => this.tables.has(name);
      return names;
    }

    createObjectStore(name, options = {}) {
      this.tables.set(name, new Table(options.keyPath));
      return this.tables.get(name);
    }

    transaction(names) {
      return new Transaction(this, names);
    }

    close() {}
  }

  for (const [name, spec] of Object.entries(seed)) {
    const db = new Database(name);
    db.version = Number(spec.version) || 1;
    for (const [storeName, records] of Object.entries(spec.stores || {})) {
      const table = db.createObjectStore(storeName, { keyPath: 'id' });
      for (const record of records) table.records.set(record.id, clone(record));
    }
    databases.set(name, db);
  }

  return {
    names: () => [...databases.keys()],
    opens: (name) => opened.get(name) || 0,
    databases: async () => [...databases.keys()].map((name) => ({ name })),
    deleteDatabase(name) {
      const request = new Request();
      setTimeout(() => {
        databases.delete(name);
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    },
    open(name, version) {
      const request = new Request();
      opened.set(name, (opened.get(name) || 0) + 1);
      setTimeout(() => {
        let db = databases.get(name);
        if (!db) {
          db = new Database(name);
          databases.set(name, db);
        }
        request.result = db;
        const next = version == null ? db.version || 1 : version;
        if (!db.version || next > db.version) {
          const oldVersion = db.version;
          db.version = next;
          if (request.onupgradeneeded) request.onupgradeneeded({ oldVersion, newVersion: next });
        }
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    },
  };
}

function legacySeed() {
  return {
    kinoboxd: {
      version: 1,
      stores: {
        profiles: [
          { id: 'kp:1', type: 'kp', label: 'Кинопоиск · Дом', kpUserId: '1', savedAt: 100 },
          { id: 'kp:2', type: 'kp', label: 'Кинопоиск · Работа', kpUserId: '2', savedAt: 300 },
        ],
        stats: [{ id: 'kp:1', stats: { films: 12 }, savedAt: 100, bytes: 14 }],
        files: [{ id: 'kp:1', name: 'letterboxd.zip', type: 'application/zip', blob: 'zip-bytes', savedAt: 100 }],
      },
    },
    'kinoboxd-books': {
      version: 1,
      stores: {
        profiles: [
          { id: 'bk:1', label: 'LiveLib @Margaret', sources: [{ source: 'livelib', username: 'Margaret' }], savedAt: 200 },
          { id: 'bk:2', label: 'Hardcover 34748', sources: [{ source: 'hardcover', userId: '34748' }], savedAt: 250 },
        ],
      },
    },
  };
}

test('the store falls back to memory when IndexedDB is missing', async () => {
  delete globalThis.indexedDB;
  const store = await freshStore('memory');
  assert.deepEqual(await store.ready(), { available: false, mode: 'memory' });
  assert.equal(store.storageMode(), 'memory');
  assert.deepEqual(await store.getStore('probe').load(), []);
});

test('profile records round-trip per domain, newest first, and bulk save replaces', async () => {
  delete globalThis.indexedDB;
  const store = await freshStore('crud');
  const films = store.getStore('crud-films');
  const books = store.getStore('crud-books');

  await films.put({ id: 'kp:1', label: 'Первый', savedAt: 10 });
  await films.put({ id: 'kp:2', label: 'Второй', savedAt: 20 });
  await books.put({ id: 'bk:1', label: '@Margaret', savedAt: 5 });

  assert.deepEqual((await films.load()).map((record) => record.id), ['kp:2', 'kp:1']);
  assert.deepEqual((await books.load()).map((record) => record.id), ['bk:1']);
  assert.equal((await films.get('kp:1')).label, 'Первый');
  assert.equal(await films.get('kp:missing'), null);

  await films.remove('kp:1');
  assert.deepEqual((await films.load()).map((record) => record.id), ['kp:2']);

  const saved = await films.save([{ id: 'kp:3', label: 'Третий', savedAt: 30 }]);
  assert.deepEqual(saved.map((record) => record.id), ['kp:3']);
  assert.deepEqual((await films.load()).map((record) => record.id), ['kp:3']);
  assert.deepEqual((await books.load()).map((record) => record.id), ['bk:1']);

  await books.clear();
  assert.deepEqual(await books.load(), []);
  assert.deepEqual((await films.load()).map((record) => record.id), ['kp:3']);
});

test('side documents (stats payloads, archives) live next to the records', async () => {
  delete globalThis.indexedDB;
  const store = await freshStore('docs');
  const films = store.getStore('docs-films');

  await films.put({ id: 'kp:1', label: 'Первый', savedAt: 10 });
  assert.equal(await store.writeDoc('docs-films', 'stats', 'kp:1', { stats: { films: 3 }, bytes: 11 }), true);
  await store.writeDoc('docs-films', 'file', 'kp:1', { name: 'dump.zip', type: 'application/zip', blob: 'bytes' });

  const stats = await store.readDoc('docs-films', 'stats', 'kp:1');
  assert.deepEqual(stats.value, { stats: { films: 3 }, bytes: 11 });
  assert.deepEqual((await store.listDocs('docs-films', 'stats')).map((doc) => doc.id), ['kp:1']);
  assert.deepEqual((await store.listDocs('docs-films', 'file')).map((doc) => doc.id), ['kp:1']);

  await store.deleteDoc('docs-films', 'stats', 'kp:1');
  assert.equal(await store.readDoc('docs-films', 'stats', 'kp:1'), null);

  await films.clear();
  assert.deepEqual(await store.listDocs('docs-films', 'file'), []);
});

test('one active profile id per domain, persisted in localStorage', async () => {
  delete globalThis.indexedDB;
  const store = await freshStore('active');
  assert.equal(store.getActive('active-films'), null);

  store.setActive('active-films', 'kp:7');
  store.setActive('active-books', 'bk:9');
  assert.equal(store.getActive('active-films'), 'kp:7');
  assert.equal(store.getActive('active-books'), 'bk:9');
  assert.equal(globalThis.window.localStorage.getItem('kinoboxd.profile.active.v1:active-books'), 'bk:9');

  store.setActive('active-films', null);
  assert.equal(store.getActive('active-films'), null);

  const saved = globalThis.window.localStorage;
  delete globalThis.window.localStorage;
  try {
    assert.equal(store.getActive('private-probe'), null);
    assert.equal(store.setActive('private-probe', 'kp:1'), 'kp:1');
    assert.equal(store.getActive('private-probe'), 'kp:1');
  } finally {
    globalThis.window.localStorage = saved;
  }
});

test('entry keys, ids and the migration decision are normalised', async () => {
  delete globalThis.indexedDB;
  const store = await freshStore('pure');

  assert.equal(store.normalizeId('  kp:1 '), 'kp:1');
  assert.equal(store.normalizeId(null), '');
  assert.equal(store.entryKey(' films ', 'profile', ' kp:1 '), 'films:profile:kp:1');
  assert.equal(store.entryFrom('films', 'profile', '', { id: '' }), null);
  assert.equal(store.entryFrom('', 'profile', 'kp:1', {}), null);

  const entry = store.entryFrom('films', 'profile', 'kp:1', { id: 'kp:1', label: 'A', savedAt: 5 }, 7);
  assert.deepEqual(entry, {
    key: 'films:profile:kp:1', domain: 'films', kind: 'profile', id: 'kp:1',
    savedAt: 7, value: { id: 'kp:1', label: 'A', savedAt: 5 },
  });

  assert.equal(store.needsMigration(undefined), true);
  assert.equal(store.needsMigration({ version: 0 }), true);
  assert.equal(store.needsMigration({ version: store.SCHEMA_VERSION }), false);

  const stats = store.legacyEntry('films', 'stats', { id: 'kp:1', stats: { a: 1 }, bytes: 3, savedAt: 4 });
  assert.deepEqual(stats.value, { stats: { a: 1 }, bytes: 3 });
  const file = store.legacyEntry('films', 'file', { id: 'kp:1', name: 'x.zip', type: 'application/zip', blob: 'b', savedAt: 4 });
  assert.deepEqual(file.value, { name: 'x.zip', type: 'application/zip', blob: 'b' });
  const profile = store.legacyEntry('books', 'profile', { id: 'bk:1', label: '@Margaret', savedAt: 4 });
  assert.equal(profile.key, 'books:profile:bk:1');
  assert.equal(profile.value.label, '@Margaret');
  assert.equal(store.legacyEntry('books', 'profile', { label: 'no id' }), null);
});

test('a user with labels in both old databases keeps every label', async () => {
  delete globalThis.indexedDB;
  const store = await freshStore('merge');
  const films = [store.legacyEntry('films', 'profile', { id: 'kp:1', label: 'Кинопоиск · Дом', savedAt: 100 })];
  const books = [
    store.legacyEntry('books', 'profile', { id: 'bk:1', label: 'LiveLib @Margaret', savedAt: 200 }),
    store.legacyEntry('books', 'profile', { id: 'bk:2', label: 'Hardcover 34748', savedAt: 250 }),
  ];

  const plan = store.dedupeEntries([...films, ...books, ...films]);
  assert.deepEqual(plan.map((entry) => entry.key).sort(), [
    'books:profile:bk:1', 'books:profile:bk:2', 'films:profile:kp:1',
  ]);
  assert.deepEqual(plan.map((entry) => entry.value.label).sort(), [
    'Hardcover 34748', 'LiveLib @Margaret', 'Кинопоиск · Дом',
  ]);

  const newer = store.legacyEntry('films', 'profile', { id: 'kp:1', label: 'Кинопоиск · Дом (new)', savedAt: 400 });
  const merged = store.dedupeEntries([...films, newer]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].value.label, 'Кинопоиск · Дом (new)');
});

test('the first run copies both legacy databases into one store and marks the schema', async (t) => {
  globalThis.indexedDB = createFakeIndexedDB(legacySeed());
  const fake = globalThis.indexedDB;
  t.after(() => { delete globalThis.indexedDB; });

  const store = await freshStore('migrate-1');
  assert.deepEqual(await store.ready(), { available: true, mode: 'idb' });

  const films = await store.getStore('films').load();
  const books = await store.getStore('books').load();
  assert.deepEqual(films.map((record) => record.id), ['kp:2', 'kp:1']);
  assert.deepEqual(films.map((record) => record.label), ['Кинопоиск · Работа', 'Кинопоиск · Дом']);
  assert.deepEqual(books.map((record) => record.id), ['bk:2', 'bk:1']);

  assert.deepEqual((await store.readDoc('films', 'stats', 'kp:1')).value, { stats: { films: 12 }, bytes: 14 });
  assert.equal((await store.readDoc('films', 'file', 'kp:1')).value.name, 'letterboxd.zip');

  assert.ok(fake.names().includes('kinoboxd-registry'));
  assert.ok(fake.names().includes('kinoboxd'), 'legacy data is left in place');
  const registry = await fake.databases();
  assert.ok(registry.some((entry) => entry.name === 'kinoboxd-registry'));
});

test('the migration runs once: the schema marker stops the legacy reads', async (t) => {
  globalThis.indexedDB = createFakeIndexedDB(legacySeed());
  const fake = globalThis.indexedDB;
  t.after(() => { delete globalThis.indexedDB; });

  const once = await freshStore('migrate-once-1');
  await once.ready();
  assert.equal(fake.opens('kinoboxd'), 1);
  assert.equal(fake.opens('kinoboxd-books'), 1);

  const again = await freshStore('migrate-once-2');
  await again.ready();
  assert.equal(fake.opens('kinoboxd'), 1, 'legacy films database is not read twice');
  assert.equal(fake.opens('kinoboxd-books'), 1, 'legacy books database is not read twice');
  assert.deepEqual((await again.getStore('books').load()).map((record) => record.id), ['bk:2', 'bk:1']);
});

test('a failed legacy read defers the copy instead of dropping the labels', async (t) => {
  const fake = createFakeIndexedDB(legacySeed());
  const realOpen = fake.open;
  let failures = 1;
  fake.open = (name, version) => {
    if (name === 'kinoboxd' && failures > 0) {
      failures -= 1;
      throw new Error('legacy database is locked');
    }
    return realOpen(name, version);
  };
  globalThis.indexedDB = fake;
  t.after(() => { delete globalThis.indexedDB; });

  const first = await freshStore('migrate-defer-1');
  await first.ready();
  assert.deepEqual(await first.getStore('films').load(), []);
  assert.deepEqual((await first.getStore('books').load()).map((record) => record.id), ['bk:2', 'bk:1']);

  const second = await freshStore('migrate-defer-2');
  await second.ready();
  assert.deepEqual((await second.getStore('films').load()).map((record) => record.id), ['kp:2', 'kp:1']);
  assert.deepEqual((await second.getStore('books').load()).map((record) => record.id), ['bk:2', 'bk:1']);
});

test('a first run without legacy databases creates nothing beside the registry', async (t) => {
  const fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;
  t.after(() => { delete globalThis.indexedDB; });

  const store = await freshStore('migrate-empty');
  await store.ready();
  assert.deepEqual(fake.names(), ['kinoboxd-registry']);
  assert.equal(fake.opens('kinoboxd'), 0);
  assert.equal(fake.opens('kinoboxd-books'), 0);
});

test('a blocked or broken IndexedDB keeps the memory fallback', async () => {
  globalThis.indexedDB = {
    open() {
      throw new Error('indexedDB blocked');
    },
    databases: async () => [],
  };
  const store = await freshStore('blocked');
  try {
    assert.deepEqual(await store.ready(), { available: false, mode: 'memory' });
    const films = store.getStore('blocked-films');
    await films.put({ id: 'kp:1', label: 'Первый', savedAt: 1 });
    assert.deepEqual((await films.load()).map((record) => record.id), ['kp:1']);
  } finally {
    delete globalThis.indexedDB;
  }
});

test('books facade: same labels, order and active switch over the shared store', async () => {
  delete globalThis.indexedDB;
  const books = await import(`${BOOKS}?facade`);
  assert.equal(books.MAX_PROFILES, 8);

  const margaret = await books.saveProfile({ label: 'Дом', savedAt: 100, sources: [{ source: 'livelib', username: 'Margaret' }] });
  const hardcover = await books.saveProfile({ label: 'Работа', savedAt: 200, sources: [{ source: 'hardcover', userId: '34748' }] });
  assert.deepEqual((await books.listProfiles()).map((record) => record.label), ['Работа', 'Дом']);

  books.setActiveId(margaret.id);
  assert.equal(books.getActiveId(), margaret.id);
  assert.equal(globalThis.window.localStorage.getItem('kinoboxd.books.profile.v1'), margaret.id);
  const registry = await books.loadRegistry();
  assert.equal(registry.active.id, margaret.id);
  assert.deepEqual(registry.profiles.map((record) => record.id), [hardcover.id, margaret.id]);

  await books.removeProfile(margaret.id);
  assert.equal(books.getActiveId(), null, 'deleting the active profile clears the slot');
  assert.equal(globalThis.window.localStorage.getItem('kinoboxd.books.profile.v1'), null);
  assert.deepEqual((await books.listProfiles()).map((record) => record.id), [hardcover.id]);
});

test('films facade: label fallback, six-profile trim and stats cache', async () => {
  delete globalThis.indexedDB;
  const films = await import(`${FILMS}?facade`);
  assert.equal(films.MAX_PROFILES, 6);

  const first = await films.saveProfile({ kpUserId: '1', kpNick: 'Дом', savedAt: 1 });
  assert.equal(first.label, 'Кинопоиск · Дом');
  for (let index = 2; index <= 7; index += 1) {
    await films.saveProfile({ kpUserId: String(index), savedAt: index });
  }
  const list = await films.listProfiles();
  assert.equal(list.length, 6);
  assert.deepEqual(list.map((record) => record.kpUserId), ['7', '6', '5', '4', '3', '2']);

  const target = list[0];
  assert.equal(await films.saveStatsCache(target.id, { meta: { films: 3 } }), true);
  const cached = await films.getStatsCache(target.id);
  assert.deepEqual(cached.stats, { meta: { films: 3 } });
  assert.equal(await films.getFile(target.id), null);
  await films.removeStatsCache(target.id);
  assert.equal(await films.getStatsCache(target.id), null);

  await films.saveFile(target.id, new Blob(['zip'], { type: 'application/zip' }));
  assert.equal(await films.hasFile(target.id), true);
  assert.equal((await films.getFile(target.id)).name, 'letterboxd-export.zip');

  const raw = await import(STORE);
  await raw.getStore('films').put({ id: 'lb:77', type: 'lb', label: 'Letterboxd', savedAt: 9 });
  await raw.writeDoc('films', 'stats', 'lb:77', { stats: {}, bytes: 2 });
  const removed = await films.migrateLetterboxdProfiles();
  assert.equal(await raw.readDoc('films', 'stats', 'lb:77'), null);
  assert.equal(removed, 1);
  assert.equal(await films.getProfile('lb:77'), null);
  assert.equal(await films.hasFile(target.id), true, 'KinoPoisk attachments survive the migration');

  await films.clearProfiles();
  assert.deepEqual(await films.listProfiles(), []);
});
