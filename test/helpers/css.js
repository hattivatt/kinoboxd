'use strict';

/**
 * Read the whole stylesheet in cascade order.
 *
 * `public/style.css` was split by domain in P8 (U12/§10.3.2) into four files
 * that `index.html` links in this exact order. Structural UI tests still want
 * "the stylesheet", so this helper concatenates the four sources instead of
 * each test hard-coding a path.
 */

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const CSS_FILES = ['core.css', 'films.css', 'books.css', 'games.css'];

/** Full CSS text of the four linked files, in link (= cascade) order. */
function readPublicCss() {
  return CSS_FILES
    .map((name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8'))
    .join('\n');
}

module.exports = { readPublicCss, CSS_FILES, PUBLIC_DIR };
