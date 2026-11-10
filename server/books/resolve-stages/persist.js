'use strict';

async function persistLinks(ctx) {
  const { plan, report, cache, force } = ctx;
  for (const [bookId, link] of plan.links) {
    const previous = cache.getLink(bookId);
    if (previous && previous.workId === link.workId && !force) {
      // Still record the method of an already-cached link for the report.
      report.methods[link.method] = (report.methods[link.method] || 0) + 1;
      continue;
    }
    await cache.saveLink(bookId, link);
    const hcNumeric = /^hc:(\d+)$/.exec(String(link.workId || ''));
    if (hcNumeric) {
      cache.setIndexValue(`ll:${bookId}`, Number(hcNumeric[1]));
      if (link.method === 'isbn' && link.evidence && link.evidence.isbn) {
        cache.setIndexValue(`isbn:${link.evidence.isbn}`, Number(hcNumeric[1]));
      }
    } else if (link.workId) {
      cache.setIndexValue(`ll:${bookId}`, link.workId);
    } else {
      cache.setIndexValue(`ll:${bookId}`, false);
    }
    cache.setWorkLink(link.workId, { livelib: [bookId] });
    report.methods[link.method] = (report.methods[link.method] || 0) + 1;
  }
  cache.flushIndex();
  cache.flushLinks();
}

module.exports = {
  persistLinks,
};
