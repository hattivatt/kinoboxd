'use strict';

const gogCache = require('../gog-cache');
const epicCache = require('../epic-cache');

function targetsForOwner(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const gog = [];
  const epic = [];
  if (!key) return { gog, epic, epicNoSlug: 0 };
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
  const epicBinding =
    typeof epicCache.epicBindingForOwnerSync === 'function'
      ? epicCache.epicBindingForOwnerSync(key)
      : { state: 'none', accountId: epicCache.epicAccountForOwner(key) };
  const epicAccount = epicBinding.accountId || null;
  if (epicAccount) {
    const library = epicCache.getEpicLibrary(epicAccount);
    const games = (library && library.games) || [];
    const catalog = epicCache.listEpicCatalogItems(
      games.map((game) => game && game.catalogItemId).filter(Boolean)
    );
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
