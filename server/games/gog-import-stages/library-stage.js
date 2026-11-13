'use strict';

const gogCache = require('../gog-cache');
const gog = require('../gog');

async function runLibraryStage(job, { tokenApi, tokenDoc, userKey, user }) {
  job.stage = 'library';
  job.percent = 15;
  const previous = gogCache.getLibrary(userKey);
  if (!job.force && gogCache.isFresh(previous, gogCache.libraryTtlMs())) {
    job.reused = true;
    job.libraryCount = Array.isArray(previous.products) ? previous.products.length : 0;
    job.pages = Array.isArray(previous.pages) ? previous.pages : null;
    job.warning = job.warning || 'library_fresh';
  } else {
    const fetched = await tokenApi.fetchAllProducts(tokenDoc);
    job.percent = 45;
    const nowIso = new Date().toISOString();
    const doc = {
      userKey,
      ownerProfile: tokenDoc.ownerProfile || null,
      fetchedAt: nowIso,
      partial: !fetched.complete,
      products: fetched.products,
      pages: fetched.pages,
      totalPages: fetched.totalPages,
      totalProducts: fetched.totalProducts,
      productsPerPage: fetched.productsPerPage,
      fingerprint: gog.libraryFingerprint(fetched.products),
      account: {
        username: user.username,
        galaxyUserId: user.galaxyUserId,
        country: user.country,
        avatar: user.avatar,
      },
    };
    gogCache.saveLibrary(userKey, doc);
    job.libraryCount = fetched.products.length;
    job.pages = fetched.pages;
    job.libraryPartial = !fetched.complete;
    job.partial = job.libraryPartial;
  }

  const library = gogCache.getLibrary(userKey) || previous;
  const products = Array.isArray(library && library.products) ? library.products : [];
  if (!products.length) {
    job.warning = job.warning || 'library_empty';
  }
  return { library, products };
}

module.exports = {
  runLibraryStage,
};
