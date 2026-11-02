'use strict';

/**
 * Credentials: environment first, then a local dev file.
 *
 * House rules (`AGENTS.md` §2): the value is never logged, only the source
 * name; a missing credential is a normal condition with a stable error code,
 * not a stack trace. The four loaders in `server/config.js` were copies of this
 * logic; they now share it.
 */

const fs = require('fs');

/** First non-empty environment value among `envKeys`. */
function fromEnv(envKeys = []) {
  for (const key of envKeys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) {
      return { value: value.trim(), source: key };
    }
  }
  return null;
}

/**
 * First non-empty line of a token file. A missing file is silent; any other
 * read error is reported by path and message, never by content.
 */
function fromFile(filePath, label = 'config') {
  if (!filePath) return null;
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    if (value) return { value, source: 'file' };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[${label}] Не удалось прочитать ${filePath}: ${err.message}`);
    }
  }
  return null;
}

/**
 * One lazily loaded credential.
 *
 * @param {object} options
 * @param {string[]} [options.envKeys]   aliases, highest priority first
 * @param {string|Function} [options.file] dev fallback (`Function` is re-evaluated
 *                                        on every load, for env-overridable paths)
 * @param {string} [options.fileLabel]   prefix of the read-error warning
 * @param {boolean} [options.required]   throw when nothing is configured
 * @param {string} [options.missingCode] code of that error
 * @param {string} [options.missingMessage]
 */
function createSecret(options = {}) {
  const envKeys = options.envKeys || [];
  const fileLabel = options.fileLabel || 'config';
  let loaded = false;
  let value = null;
  let source = null;

  function load() {
    if (loaded) return value;
    const filePath = typeof options.file === 'function' ? options.file() : options.file;
    const found = fromEnv(envKeys) || fromFile(filePath, fileLabel);
    if (!found) {
      if (options.required) {
        const err = new Error(options.missingMessage || 'Secret is not configured.');
        err.code = options.missingCode || 'SECRET_MISSING';
        throw err;
      }
      loaded = true;
      return null;
    }
    value = found.value;
    source = found.source;
    loaded = true;
    return value;
  }

  return {
    load,
    /** Source name (`env` key or `file`), never the value. */
    source() {
      load();
      return source;
    },
    /** Test helper: forget the cached value. */
    reset() {
      loaded = false;
      value = null;
      source = null;
    },
  };
}

module.exports = {
  fromEnv,
  fromFile,
  createSecret,
};
