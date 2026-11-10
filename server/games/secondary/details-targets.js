'use strict';

const gogCache = require('../gog-cache');
const epicCache = require('../epic-cache');

function targetsForOwner(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const gog = [];
  const epic = [];
  if (!key) return { gog, epic, epicNoSlug: 0 };
  // Both a bound token and a dated snapshot carry the owner: a restored
  // snapshot without a token still deserves metadata (its games are in the
  // union), so libraries are read directly and filtered by `ownerProfile`.
  const seenGog = new Set();
  for (const library of gogCache.listLibraries()) {
    if (!library || library.ownerProfile !== key) continue;
    for (const product of library.products || []) {
      if (!product || !product.gogGameId) continue;
      const id = String(product.gogGameId);
      if (seenGog.has(id)) continue;
      seenGog.add(id);
      gog.push({ id, slug: product.slug || null, title: product.title || null });
    }
  }
  let epicNoSlug = 0;
  // Read-only binding scan: a token the profile has not adopted yet (exactly
  // one, no other owner) still addresses this owner's library. The job adopts
  // it; enumeration here must not report «no Epic» while the games exist.
  const epicBinding =
    typeof epicCache.epicBindingForOwnerSync === 'function'
      ? epicCache.epicBindingForOwnerSync(key)
      : { state: 'none', accountId: epicCache.epicAccountForOwner(key) };
  const epicAccount = epicBinding.accountId || null;
  if (epicAccount) {
    const library = epicCache.getEpicLibrary(epicAccount);
    const games = (library && library.games) || [];
    // The library snapshot's own `slug` is only the productmapping fallback
    // (~1 283 appNames). The catalog bulk (`productSlug`/`urlSlug`) and a
    // previously discovered slug override cover Epic exclusives such as
    // Alan Wake 2, which `productmapping` does not list at all.
    const catalog = epicCache.listEpicCatalogItems(
      games.map((game) => game && game.catalogItemId).filter(Boolean)
    );
    // productmapping keys are appNames or namespaces; an Epic exclusive (Alan
    // Wake 2) is present only under its namespace.
    let productMapping = {};
    try {
      const mapping = epicCache.getProductMapping();
      productMapping = mapping && mapping.byAppName ? mapping.byAppName : {};
    } catch (err) {
      productMapping = {};
    }
    for (const game of games) {
      if (!game) continue;
      const meta = (game.catalogItemId && catalog[game.catalogItemId]) || null;
      const mappedSlug =
        (game.appName && productMapping[game.appName]) ||
        (game.namespace && productMapping[game.namespace]) ||
        null;
      const slug =
        (meta && meta.slug) ||
        game.slug ||
        mappedSlug ||
        (game.catalogItemId ? epicCache.getEpicSlugOverride(game.catalogItemId) : null) ||
        null;
      const title = (meta && meta.title) || game.name || game.appName || null;
      if (!slug) epicNoSlug++;
      epic.push({
        slug: slug || null,
        id: String(game.catalogItemId || game.appName || slug || ''),
        catalogItemId: game.catalogItemId || null,
        appName: game.appName || null,
        namespace: game.namespace || null,
        title,
        catalog: meta,
      });
    }
  }
  return { gog, epic, epicNoSlug, epicBinding };
}

module.exports = {
  targetsForOwner,
};
