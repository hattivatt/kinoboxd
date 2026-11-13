'use strict';

const fs = require('fs');

function fromEnv(envKeys = []) {
  for (const key of envKeys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) {
      return { value: value.trim(), source: key };
    }
  }
  return null;
}

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
    source() {
      load();
      return source;
    },
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
