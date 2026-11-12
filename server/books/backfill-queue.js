'use strict';

const { storedFirstClaim, isPrintClaimSource } = require('./providers/claim');

function workIdOf(doc) {
  if (!doc) return null;
  return doc.workId || (doc.hcWorkId != null ? `hc:${doc.hcWorkId}` : null);
}

function storedPrintClaim(doc) {
  const claim = storedFirstClaim(doc);
  if (!claim || !isPrintClaimSource(claim.source)) return null;
  if (String((doc && doc.yearSource) || '') === 'manual') return null;
  return claim;
}

function needsYearQuestion(doc) {
  return storedFirstClaim(doc) == null || storedPrintClaim(doc) != null;
}

function recentlyChecked(doc, now, recheckDays) {
  const stamp = doc && doc.firstPublishedYearCheckedAt;
  if (!stamp) return false;
  const ts = Date.parse(String(stamp));
  if (!Number.isFinite(ts)) return false;
  const window = Number(recheckDays);
  if (!Number.isFinite(window) || window <= 0) return false;
  return now - ts < window * 24 * 60 * 60 * 1000;
}

function matchesId(ids, entry) {
  const { key, doc, workId } = entry;
  return [...ids].some(
    (id) => id === workId || id === key || id === doc.workId || id === String(doc.hcWorkId)
  );
}

function selectCandidates(docs, options = {}) {
  const { ids, force, needsYear, needsSeries, checked, covers } = options;
  const candidates = [];
  let skippedChecked = 0;
  for (const { key, doc } of docs) {
    const workId = workIdOf(doc);
    if (!workId) continue;
    const entry = { key, doc, workId };
    if (ids && !matchesId(ids, entry)) continue;
    if (!ids && !force && !needsYear(doc) && !needsSeries(doc)) continue;
    if (!ids && !force && checked(doc) && covers(doc)) {
      skippedChecked++;
      continue;
    }
    candidates.push(entry);
  }
  return { candidates, skippedChecked };
}

function countPending(docs, options = {}) {
  const { ids, force, needsYear, needsSeries, checked, covers } = options;
  let pending = 0;
  for (const { key, doc } of docs) {
    const workId = workIdOf(doc);
    if (!workId) continue;
    if (ids && !matchesId(ids, { key, doc, workId })) continue;
    if (!force && !needsYear(doc) && !needsSeries(doc)) continue;
    if (!force && checked(doc) && covers(doc)) continue;
    pending++;
  }
  return pending;
}

module.exports = {
  workIdOf,
  storedPrintClaim,
  needsYearQuestion,
  recentlyChecked,
  matchesId,
  selectCandidates,
  countPending,
};
