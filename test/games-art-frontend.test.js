'use strict';

/**
 * Frontend contract of the resolved vertical capsule and the small-icon
 * fallback (`public/js/games-modal.js`, `public/js/games-view.js`).
 *
 *   - `verticalCapsule` (server-resolved) is the first URL, and the guessed
 *     `library` variants are not requested after it;
 *   - `verticalCapsuleKnown === false` suppresses the library chain entirely
 *     (Steam has no vertical art for this SKU — every attempt would 404);
 *   - no field at all keeps the pre-resolve chain (old cached payloads);
 *   - a 32×32 icon that 404s falls back to the small capsule, then initials.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { installDom } = require('./helpers/dom-shim');

installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const ART = '/api/games/steam-art';
const APPID = 3669870;
const HEADER = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/1e0c76e4253d347bb1304c3f213570251d924edf/header.jpg`;
const CAPSULE = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/867a73afa5f21c28aaa14e9b0a4d895c540d4a0c/capsule_231x87.jpg`;
const LIB = '7d4b4f430dc4d07e6562eb445456f9615cb52f77';
const SMALL = '867a73afa5f21c28aaa14e9b0a4d895c540d4a0c';

async function modal() {
  return import('../public/js/games-modal.js');
}

function configure(mod, gamesIndex = {}) {
  mod.configureGamesModals({ profile: '', gamesIndex, secondaryWorks: [] });
}

test('resolved verticalCapsule is first and the guessed library paths are skipped', async () => {
  const mod = await modal();
  configure(mod);
  const urls = mod.gameVerticalCoverUrls({
    appid: APPID,
    headerImage: HEADER,
    capsuleImage: CAPSULE,
    verticalCapsule: `${ART}/library_capsule/${APPID}?h=${LIB}`,
    verticalCapsuleKnown: true,
  });
  assert.equal(urls[0], `${ART}/library_capsule/${APPID}?h=${LIB}`);
  assert.equal(urls.includes(`${ART}/library/${APPID}`), false);
  assert.equal(urls.includes(`${ART}/library/${APPID}?h=1e0c76e4253d347bb1304c3f213570251d924edf`), false);
  assert.equal(urls[1], `${ART}/header/${APPID}?h=1e0c76e4253d347bb1304c3f213570251d924edf`);
});

test('verticalCapsuleKnown=false skips every library variant and starts with the header', async () => {
  const mod = await modal();
  configure(mod);
  const urls = mod.gameVerticalCoverUrls({
    appid: APPID,
    headerImage: HEADER,
    verticalCapsule: null,
    verticalCapsuleKnown: false,
  });
  assert.equal(urls.some((url) => url.includes('/steam-art/library/')), false);
  assert.equal(urls[0], `${ART}/header/${APPID}?h=1e0c76e4253d347bb1304c3f213570251d924edf`);
});

test('no resolve fields keeps the legacy chain (old cached payloads)', async () => {
  const mod = await modal();
  configure(mod);
  const urls = mod.gameVerticalCoverUrls({ appid: APPID, headerImage: HEADER });
  assert.equal(urls[0], `${ART}/library/${APPID}?h=1e0c76e4253d347bb1304c3f213570251d924edf`);
  assert.equal(urls[1], `${ART}/library/${APPID}`);
});

test('gamesIndex provides both the resolved capsule and the none verdict', async () => {
  const mod = await modal();
  configure(mod, {
    [APPID]: {
      appid: APPID,
      headerImage: HEADER,
      verticalCapsule: `${ART}/library_capsule/${APPID}?h=${LIB}`,
      verticalCapsuleKnown: true,
    },
  });
  const withArt = mod.gameVerticalCoverUrls({ appid: APPID });
  assert.equal(withArt[0], `${ART}/library_capsule/${APPID}?h=${LIB}`);

  configure(mod, {
    [APPID]: {
      appid: APPID,
      headerImage: HEADER,
      verticalCapsule: null,
      verticalCapsuleKnown: false,
    },
  });
  const none = mod.gameVerticalCoverUrls({ appid: APPID });
  assert.equal(none.some((url) => url.includes('/steam-art/library/')), false);
});

test('gameIconEl: icon → small capsule → initials', async () => {
  const mod = await modal();
  configure(mod, {
    [APPID]: {
      appid: APPID,
      iconFallbackUrl: `${ART}/capsule/${APPID}?h=${SMALL}`,
    },
  });
  const icon = `https://media.steampowered.com/steamcommunity/public/images/apps/${APPID}/f9f5.jpg`;
  const img = mod.gameIconEl({ appid: APPID, name: 'CONTROL Resonant', iconUrl: icon });
  assert.equal(img.tagName, 'IMG');
  assert.equal(
    img.getAttribute('src'),
    `${ART}/icon/${APPID}?h=f9f5`,
    'a Steam CDN icon goes through the proxy'
  );
  const host = document.createElement('div');
  host.append(img);
  img.dispatch('error');
  assert.equal(
    img.getAttribute('src'),
    `${ART}/capsule/${APPID}?h=${SMALL}`,
    'a 404 community icon falls back to the small capsule'
  );
  img.dispatch('error');
  const fallback = host.children[0];
  assert.equal(fallback.tagName, 'DIV');
  assert.equal(fallback.className.includes('game-icon-fallback'), true);
  assert.equal(fallback.textContent, 'C');
});

test('gameIconEl: no iconUrl uses the fallback directly; nothing → initials', async () => {
  const mod = await modal();
  configure(mod);
  const img = mod.gameIconEl({
    appid: APPID,
    name: 'CONTROL Resonant',
    iconFallbackUrl: `${ART}/capsule/${APPID}?h=${SMALL}`,
  });
  assert.equal(img.tagName, 'IMG');
  assert.equal(img.getAttribute('src'), `${ART}/capsule/${APPID}?h=${SMALL}`);

  const empty = mod.gameIconEl({ name: 'No art' });
  assert.equal(empty.tagName, 'DIV');
  assert.equal(empty.className.includes('game-icon-fallback'), true);
});
