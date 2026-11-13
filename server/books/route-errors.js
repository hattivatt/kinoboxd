'use strict';

const livelibCookies = require('./livelib-cookies');
const livelibFile = require('./livelib-file');
const { HardcoverError } = require('./hardcover');
const { LivelibError } = require('./livelib');

const LIVELIB_ERROR_STATUS = {
  livelib_invalid_username: 400,
  livelib_import_running: 409,
  livelib_blocked: 429,
  livelib_bulk_error: 404,
};

const HARDCOVER_ERROR_STATUS = {
  hardcover_token_missing: 400,
  hardcover_foreign_user: 400,
};

const BOOKS_ERROR_PROFILE = {
  rules: [
    { is: livelibCookies.CookieError, defaultStatus: 400 },
    { is: livelibFile.LivelibFileError, defaultStatus: 400 },
    { is: LivelibError, statuses: LIVELIB_ERROR_STATUS, defaultStatus: 502 },
    { is: HardcoverError, statuses: HARDCOVER_ERROR_STATUS, defaultStatus: 502 },
  ],
};

module.exports = { BOOKS_ERROR_PROFILE, LIVELIB_ERROR_STATUS, HARDCOVER_ERROR_STATUS };
