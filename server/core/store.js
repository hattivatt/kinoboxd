'use strict';

/**
 * Namespaced document store on top of `core/fs-store.js`.
 *
 * WHY: every cache domain used to spell out the same three steps — build a
 * path, `readJsonWithFingerprint`, `writeJsonAtomic` — and each one invented
 * its own key sanitising and schema handling. This module is the one place
 * that maps `(namespace, key)` to a file and decides what a document version
 * means. It does NOT move any file: the directory layout stays exactly where
 * the domain put it (`dirs`), because 130+ tests and every deployed cache
 * depend on the current names.
 *
 * Layout:
 *
 *   createStore({ root: '/cache-games', dirs: { details: 'details' } })
 *     .put('details', 292030, doc)  -> /cache-games/details/292030.json
 *
 * A namespace maps to `dirs[namespace]` (a path relative to `root`, or an
 * absolute path). Without a `dirs` map the namespace name itself is used as
 * the subdirectory. A namespace that the map does not know is an error rather
 * than a silently created directory: a typo must not grow a new cache tree.
 * Keys go through `safeKey`, so `../etc/passwd` stays inside the namespace.
 *
 * Schema versions (U7):
 *
 *   - a store created with `schemaVersion: N` stamps every `put()` with
 *     `schemaVersion: N` (the store owns the field for its namespaces);
 *   - reading accepts documents WITHOUT a version — that is the state of every
 *     cache file written before U7 — and treats them as compatible;
 *   - a document whose numeric version is GREATER than the store's is a
 *     document from a newer binary. `get()` refuses to interpret it: it
 *     returns `null` and logs one warning per `(file, version)`. Silently
 *     feeding an unknown shape to a caller is how a cache corrupts a payload;
 *     `null` degrades to a refetch, which is safe;
 *   - `read()` is the explicit escape hatch for callers that want to decide:
 *     it returns `{ doc, path, fingerprint, schemaVersion, futureVersion }`
 *     and never filters. A future migrator (and the unit test) use it.
 *
 * `fresh()` mirrors `game-cache.isFresh` / `gog-cache.isFresh` exactly: the
 * timestamp is `doc[field] || doc.importedAt`, parsed as a date, and the
 * document is fresh while `0 <= age < ttlMs`. No second notion of time.
 */

const path = require('path');

const {
  readJsonWithFingerprint,
  writeJsonAtomic,
  removeQuietly,
  listJsonFiles,
  safeKey,
} = require('./fs-store');

function storeError(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeVersion(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {{
 *   root: string,
 *   dirs?: Record<string, string>,
 *   schemaVersion?: number,
 * }} options
 */
function createStore(options = {}) {
  const root = path.resolve(options.root || '.');
  const dirs = options.dirs || null;
  const schemaVersion = normalizeVersion(options.schemaVersion);
  // One warning per (path, version): a hot loop over one future document must
  // not flood the log.
  const warned = new Set();

  function namespaceDir(namespace) {
    const name = String(namespace == null ? '' : namespace);
    if (!name) throw storeError('Store namespace is required.', 'store_namespace_required');
    if (dirs && Object.prototype.hasOwnProperty.call(dirs, name)) {
      const value = String(dirs[name] == null ? '' : dirs[name]);
      if (!value) throw storeError(`Store namespace "${name}" has no directory.`, 'store_unknown_namespace');
      return path.isAbsolute(value) ? value : path.join(root, value);
    }
    if (dirs) {
      throw storeError(`Unknown store namespace: ${name}`, 'store_unknown_namespace');
    }
    return path.join(root, safeKey(name));
  }

  function pathFor(namespace, key) {
    const safe = safeKey(key);
    if (!safe) throw storeError('Store key is required.', 'store_key_required');
    return path.join(namespaceDir(namespace), `${safe}.json`);
  }

  /**
   * Raw read: `{ doc, path, fingerprint, schemaVersion, futureVersion }` or
   * `null` for a missing/corrupt file. Never filters on the version.
   */
  function read(namespace, key) {
    const filePath = pathFor(namespace, key);
    const hit = readJsonWithFingerprint(filePath, { label: `store:${namespace}` });
    if (!hit) return null;
    const doc = hit.data;
    const version =
      doc && typeof doc === 'object' && !Array.isArray(doc)
        ? normalizeVersion(doc.schemaVersion)
        : null;
    return {
      doc,
      path: filePath,
      fingerprint: hit.fingerprint,
      schemaVersion: version,
      futureVersion: schemaVersion !== null && version !== null && version > schemaVersion,
    };
  }

  /** Document or `null`; a newer-than-known document is refused (see header). */
  function get(namespace, key) {
    const hit = read(namespace, key);
    if (!hit) return null;
    if (hit.futureVersion) {
      const stamp = `${hit.path}:${hit.schemaVersion}`;
      if (!warned.has(stamp)) {
        warned.add(stamp);
        console.warn(
          `[store:${namespace}] ${hit.path} has schemaVersion ${hit.schemaVersion} > ${schemaVersion}; not read.`
        );
      }
      return null;
    }
    return hit.doc;
  }

  /**
   * Write one document atomically. Returns the written document (with the
   * store's `schemaVersion`), its fingerprint and its path — the fingerprint
   * is what callers keep for cross-process invalidation.
   */
  async function put(namespace, key, doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw storeError('Store documents must be JSON objects.', 'store_document_required');
    }
    const filePath = pathFor(namespace, key);
    const data = schemaVersion === null ? doc : { ...doc, schemaVersion };
    const fingerprint = await writeJsonAtomic(filePath, data);
    return { data, fingerprint, path: filePath };
  }

  /** Keys of one namespace (file names without `.json`), sorted. */
  function list(namespace) {
    return listJsonFiles(namespaceDir(namespace))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
  }

  /** Idempotent delete; `true` when a file was removed. */
  function remove(namespace, key) {
    return removeQuietly(pathFor(namespace, key));
  }

  /**
   * Same contract as `game-cache.isFresh(doc, ttlMs, field)`.
   * A document with no parsable timestamp is stale.
   */
  function fresh(doc, ttlMs, field = 'fetchedAt') {
    if (!doc) return false;
    const ts = Date.parse(String(doc[field] || doc.importedAt || ''));
    if (!Number.isFinite(ts)) return false;
    const age = Date.now() - ts;
    return age >= 0 && age < ttlMs;
  }

  return {
    root,
    schemaVersion,
    namespaceDir,
    pathFor,
    read,
    get,
    put,
    list,
    remove,
    fresh,
  };
}

module.exports = {
  createStore,
};
