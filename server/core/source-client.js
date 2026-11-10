'use strict';

const { createBreaker } = require('./breaker');

function numberSource(option, fallback) {
  if (typeof option === 'function') return () => Number(option());
  if (option == null) return () => Number(fallback);
  return () => Number(option);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSourceGate(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  const pauseOf = numberSource(options.pauseMs, 0);
  const breaker =
    options.breaker ||
    createBreaker({
      now,
      cooldownMs: options.breakerMs == null ? undefined : numberSource(options.breakerMs),
      read: options.breakerStore ? () => options.breakerStore.read() : options.read,
      write: options.breakerStore ? (state) => options.breakerStore.write(state) : options.write,
      encode: options.encode,
      decode: options.decode,
      swallowWriteErrors: options.swallowWriteErrors,
    });
  const createError = typeof options.createError === 'function' ? options.createError : null;
  const mapTransportError =
    typeof options.mapTransportError === 'function' ? options.mapTransportError : null;

  let lastRequestAt = null;

  async function pause() {
    const pauseMs = pauseOf();
    if (!(pauseMs > 0)) return;
    if (lastRequestAt != null) {
      const wait = pauseMs - (now() - lastRequestAt);
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt = now();
  }

  function breakerFor(key, at) {
    return breaker.entry(key, at);
  }

  function tripBreaker(key, details) {
    return breaker.trip(key, details);
  }

  function assertNotBlocked(key, at) {
    const entry = breakerFor(key, at);
    if (!entry) return entry;
    if (createError) throw createError(key, entry);
    const err = new Error(`source ${key} is resting until ${new Date(entry.until).toISOString()}`);
    err.code = 'source_rate_limited';
    err.host = key;
    err.retryAt = new Date(entry.until).toISOString();
    throw err;
  }

  async function request(key, call, context) {
    assertNotBlocked(key);
    await pause();
    try {
      return await call();
    } catch (err) {
      throw mapTransportError ? mapTransportError(err, context) : err;
    }
  }

  return {
    get paused() {
      return pauseOf() > 0;
    },
    pause,
    breaker,
    assertNotBlocked,
    tripBreaker,
    breakerFor,
    request,
  };
}

module.exports = { createSourceGate };
