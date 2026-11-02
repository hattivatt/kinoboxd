'use strict';

/**
 * Films «Подключения»: the Letterboxd archive is a connection of the current
 * KinoPoisk profile, so it lives on its own screen (a card with the attach
 * action) instead of the topbar. The attach flow itself is unchanged: the
 * button keeps `id="attach-lb"`, which `attach.js` binds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');

test('the films topbar offers «Подключения» instead of the archive button', () => {
  const html = read('index.html');
  assert.match(html, /id="films-connections-btn"[\s\S]*?Подключения/);
  // One attach button, and it is not in the topbar block any more.
  const attach = html.match(/id="attach-lb"/g) || [];
  assert.equal(attach.length, 1);
  const topbarStart = html.indexOf('<header class="topbar" id="app-topbar">');
  const topbarEnd = html.indexOf('</header>', topbarStart);
  const topbar = html.slice(topbarStart, topbarEnd);
  assert.doesNotMatch(topbar, /id="attach-lb"/);
});

test('the connections screen carries the archive card and a way back', () => {
  const html = read('index.html');
  const screen = html.slice(
    html.indexOf('<section class="view" data-view="films-connections" hidden>'),
    html.indexOf('<section class="view" data-view="dashboard" hidden>')
  );
  assert.ok(screen.length > 0, 'экран подключений должен существовать');
  assert.match(screen, /id="attach-lb"/);
  assert.match(screen, /data-source="letterboxd"/);
  assert.match(screen, /id="films-attach-status"/);
  assert.match(screen, /id="films-connections-back"/);
});

test('main.js opens the screen and returns to the dashboard', () => {
  const js = read('js/main.js');
  assert.match(js, /getElementById\('films-connections-btn'\)/);
  assert.match(js, /showView\('films-connections'\)/);
  assert.match(js, /getElementById\('films-connections-back'\)/);
});
