'use strict';

/**
 * `meta` of the books payload: build time, the journal-status filter audit,
 * the per-profile audit and the Deep Scan progress of a LiveLib profile.
 *
 * S2 «распил god-функции»: pure reads of the prepared event set and the
 * profile catalog; `buildMs` is measured by the assembly line and passed in,
 * so the number still covers the whole build.
 */

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
      // Plan shelves of a file import (reading/wish) — excluded from the
      // reading statistics on purpose, kept in the profile document.
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
        // Events without `statusId` come from imports made before the
        // journal schema learned the raw status; a Hardcover re-import
        // refresh is advised (the label fallback keeps the numbers honest
        // in the meantime).
        missingStatusId: audit.missingStatusId,
        needsReimport: entry.source === 'hardcover' && audit.missingStatusId > 0,
      };
    }),
    // Deep Scan progress of a LiveLib profile: the frontend shows it on the
    // "Обновить профиль" button without blocking the dashboard.
    deepScan: profile.deepScan || null,
  };
}

module.exports = { buildMeta };
