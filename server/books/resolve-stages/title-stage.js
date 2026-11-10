'use strict';

const { eventKeyOf } = require('./identity');
const { buildCorpus, corpusCandidates } = require('./corpus');
const { bestCandidate } = require('./matching');

function matchCorpus(ctx) {
  const { plan, report, cache, now } = ctx;
  const corpus = buildCorpus([...plan.works.values()]);
  plan.corpus = corpus;
  report.corpusSize = corpus.works.length;

  for (const event of plan.pending) {
    const bookId = eventKeyOf(event);
    if (plan.links.has(bookId)) continue;
    const candidates = corpusCandidates(corpus, event.title);
    if (candidates.length === 0) continue;
    const best = bestCandidate(event, candidates);
    if (!best) continue;
    if (best.ambiguous) {
      report.ambiguous++;
      cache.appendMatchLog({
        ts: now,
        source: 'livelib',
        livelibBookId: bookId,
        query: event.title,
        decision: 'ambiguous',
        score: best.score,
        evidence: best.evidence,
        candidates: candidates.slice(0, 5).map((work) => work.hcWorkId),
      });
      continue;
    }
    const workId = `hc:${best.candidate.hcWorkId}`;
    const link = {
      schemaVersion: 1,
      livelibBookId: bookId,
      workId,
      method: best.method,
      score: best.score,
      evidence: best.evidence,
      resolvedAt: now,
    };
    plan.links.set(bookId, link);
    report.resolvedTitle++;
    if (best.method !== 'title-author-year') {
      cache.appendMatchLog({
        ts: now,
        source: 'livelib',
        livelibBookId: bookId,
        query: event.title,
        candidateId: best.candidate.hcWorkId,
        score: best.score,
        titleSim: best.evidence.titleSim,
        authorHit: best.evidence.authorHit,
        yearDelta: best.evidence.yearDelta,
        ratingsCount: best.evidence.ratingsCount,
        decision: 'match',
      });
    }
  }
}

module.exports = {
  matchCorpus,
};
