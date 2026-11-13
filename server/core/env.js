'use strict';

function envMs(name, fallback) {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

module.exports = {
  envMs,
  envTtl: envMs,
};
