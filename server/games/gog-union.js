'use strict';

/**
 * Facade kept for the existing importers: the GOG side of the cross-store
 * union now lives in `secondary/index.js` (one place for identity + union,
 * U10). Same names, same behaviour — the file stays until the tests move.
 */

module.exports = require('./secondary');
