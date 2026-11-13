'use strict';

function isYearOnlyDetails(doc) {
  return Boolean(doc && doc.yearOnly === true);
}

function liveLibMetadata(doc) {
  return doc && !isYearOnlyDetails(doc) ? doc : null;
}

module.exports = { isYearOnlyDetails, liveLibMetadata };
