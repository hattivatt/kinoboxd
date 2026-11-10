'use strict';

const DEFAULT_PORT_BASE = 6000;
const MIN_PORT_BASE = 1024;
const MAX_PORT_BASE = 60000;
const MAX_TCP_PORT = 65535;

function readBase(raw) {
  if (raw == null || String(raw).trim() === '') return DEFAULT_PORT_BASE;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`KINOBOXD_TEST_PORT_BASE must be an integer, got "${text}"`);
  }
  return Number(text);
}

const PORT_BASE = readBase(process.env.KINOBOXD_TEST_PORT_BASE);

if (PORT_BASE < MIN_PORT_BASE || PORT_BASE > MAX_PORT_BASE) {
  throw new Error(
    `KINOBOXD_TEST_PORT_BASE must be an integer in ${MIN_PORT_BASE}..${MAX_PORT_BASE}, got ${PORT_BASE}`,
  );
}

function portFor(slot) {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`portFor(slot) needs a non-negative integer slot, got ${slot}`);
  }
  const port = PORT_BASE + slot;
  if (port > MAX_TCP_PORT) {
    throw new Error(
      `portFor(${slot}) overflows the TCP range: ${PORT_BASE} + ${slot} = ${port} > ${MAX_TCP_PORT}`,
    );
  }
  return port;
}

module.exports = { PORT_BASE, portFor };
