'use strict';

/**
 * Personnel layer for the games tab (ИГРЫ-АРХИТЕКТУРА §2.4, §5.3, §7).
 *
 * Steam gives only `developers[]`/`publishers[]`; people credits come from
 * Wikidata (`wikidata.js`) and MobyGames (`moby.js`). This module is the
 * *aggregation* on top of those caches:
 *
 *   cache-games/details/<appid>.json       studios (M2 enricher writes it)
 *   cache-games/links/<appid>.json         qid / mobyId (M2 resolver writes it)
 *   cache-games/personnel/<appid>.json     credits per game (this module)
 *   cache-games/personnel-overrides.json   manual merges/aliases (this module)
 *
 * Reading never touches the network: a missing details document is reported as
 * `pending.details`, a missing credits document as `pending.credits`, never as
 * «0 people» (ИГРЫ §7.2: «Не знаем» — валидное состояние). The network phase is
 * `enrichPersonnel()`, called by the on-demand job (`jobs.js`: import/refresh/
 * enrich kick + the lazy `GET /api/games/personnel`) and by the manual
 * `backfill.js`; both share `personnel.lock`.
 *
 * Identity rules (§4.2, §4.3, §7.4), deliberately conservative:
 *
 *   studio: QID → Moby company id → slug(name)
 *   person: QID → Moby person id → slug(name)  (never by a bare name when the
 *           same name belongs to two QIDs: such a group is `ambiguous: true`)
 *
 * Two different QIDs are never merged by name. A Steam studio (no QID) is
 * unified with its Wikidata record by normalized name, because that is the same
 * company seen through two sources; the QID stays on the merged item.
 *
 * Weights (§7.3): `count` (games in this role), `hours` (sum of
 * `playtime_forever`), `hoursShare` (of the profile's considered hours),
 * `avgCompletion` (only games with achievements; `null` otherwise, never 0).
 *
 * Roles (§2.4/§7.2, round 01.11.2026): studios are NOT one bucket any more.
 * `developer` (Steam `developers[]`, Wikidata `P178`) and `publisher`
 * (Steam `publishers[]`, Wikidata `P123`) are separate roles, both selectable
 * and both fed by the same studio entity (a company credited as both stays one
 * item whose `roles` says so). `developer` is the default; the old `studio`
 * token is a documented alias for it, so a cached frontend that still asks for
 * `role=studio` keeps working.
 *
 * Manual overrides are union-safe: `applyOverride()` merges into the existing
 * file and never drops keys it did not touch (§5.5).
 */

const {
  OVERRIDES_PATH,
  ROLES,
  ROLE_ALIASES,
  DEFAULT_ROLE,
  STUDIO_ROLES,
  PEOPLE_ROLES,
  SORTS,
  PersonnelError,
  normalizeName,
  normalizeRole,
  resolveRole,
  normalizeSort,
  minutesToHours,
  readOverrides,
  saveOverrides,
  mergeOverrides,
  applyOverride,
} = require('./identity');
const {
  studiosFromSecondaryWork,
  studiosOfSecondaryWork,
  carriedStoreStudios,
  storeStudiosSignature,
  STORE_STUDIO_SOURCES,
  mergeSecondaryStudios,
  secondaryWorksFor,
  studiosFromDetails,
  dedupePeople,
  dedupeStudios,
} = require('./group');
const {
  DETAILS_DIR,
  LINKS_DIR,
  PERSONNEL_DIR,
  PERSONNEL_TTL_MS,
  LABEL_RULE_VERSION,
  WIKIDATA_BADGES,
  wikidataStatus,
  readDetails,
  readLinks,
  readPersonnelDoc,
  isPersonnelFresh,
  savePersonnelDoc,
  secondaryPersonnelPath,
  readSecondaryPersonnelDoc,
  saveSecondaryPersonnelDoc,
  buildPersonnel,
  personnelForGame,
} = require('./build');
const { enrichPersonnel } = require('./enrich');

module.exports = {
  DETAILS_DIR,
  LINKS_DIR,
  PERSONNEL_DIR,
  OVERRIDES_PATH,
  PERSONNEL_TTL_MS,
  LABEL_RULE_VERSION,
  ROLES,
  ROLE_ALIASES,
  DEFAULT_ROLE,
  STUDIO_ROLES,
  PEOPLE_ROLES,
  SORTS,
  WIKIDATA_BADGES,
  PersonnelError,
  normalizeName,
  normalizeRole,
  resolveRole,
  normalizeSort,
  wikidataStatus,
  minutesToHours,
  readDetails,
  readLinks,
  readPersonnelDoc,
  isPersonnelFresh,
  savePersonnelDoc,
  secondaryPersonnelPath,
  readSecondaryPersonnelDoc,
  saveSecondaryPersonnelDoc,
  studiosFromSecondaryWork,
  studiosOfSecondaryWork,
  carriedStoreStudios,
  storeStudiosSignature,
  STORE_STUDIO_SOURCES,
  mergeSecondaryStudios,
  secondaryWorksFor,
  studiosFromDetails,
  readOverrides,
  saveOverrides,
  mergeOverrides,
  applyOverride,
  buildPersonnel,
  personnelForGame,
  enrichPersonnel,
  dedupePeople,
  dedupeStudios,
};
