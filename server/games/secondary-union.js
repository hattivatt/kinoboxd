'use strict';

/**
 * Facade kept for the existing importers: the union of the same owner's
 * libraries now lives in `secondary/index.js` (one place for identity + union,
 * U10). Same names, same behaviour — the file stays until the tests move.
 */

module.exports = require('./secondary');
