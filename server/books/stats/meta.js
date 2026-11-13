'use strict';

const { HARDCOVER_PROFILE_STATUS_IDS, READ_SHELF_LABELS } = require('./constants');

function buildMeta(ctx, elapsedMs) {
  const { prepared, profiles, profile } = ctx;
  return {
    buildMs: Number(elapsedMs.toFixed(1)),
    statusFilter: {
      excluded: prepared.statusFilter.excluded,
      byStatus: prepared.statusFilter.byStatus,
      keepStatusIds: HARDCOVER_PROFILE_STATUS_IDS,
      legacyExcluded: prepared.statusFilter.missingStatusId,
      shelfExcluded: prepared.statusFilter.shelfExcluded,
      byShelf: prepared.statusFilter.byShelf,
      keepShelves: READ_SHELF_LABELS,
    },
    profiles: profiles.map((entry) => {
      const audit = prepared.profileStatus.get(`${entry.source}:${entry.userKey}`) || {
        kept: entry.events.length,
        excluded: 0,
        missingStatusId: 0,
        shelfExcluded: 0,
      };
      return {
        key: `${entry.source}-${entry.userKey}`,
        source: entry.source,
        userKey: entry.userKey,
        origin: entry.origin || entry.source,
        importedAt: entry.importedAt || null,
        events: entry.events.length,
        keptEvents: audit.kept,
        statusExcluded: audit.excluded,
        shelfExcluded: audit.shelfExcluded || 0,
        missingStatusId: audit.missingStatusId,
        needsReimport: entry.source === 'hardcover' && audit.missingStatusId > 0,
      };
    }),
    deepScan: profile.deepScan || null,
  };
}

module.exports = { buildMeta };
