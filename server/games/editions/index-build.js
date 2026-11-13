'use strict';

const { numericSignature } = require('./normalize');
const {
  nodeOf,
  editionMatch,
  mergeConfidence,
  primaryOf,
  componentKey,
} = require('./match');
const { round1 } = require('../../core/stats');

const ALGORITHM_VERSION = 2;

function buildEditionIndex(input = {}) {
  const games = Array.isArray(input.games) ? input.games : [];
  const details = input.details && typeof input.details === 'object' ? input.details : {};
  const links = input.links && typeof input.links === 'object' ? input.links : {};
  const manual = input.manual && typeof input.manual === 'object' ? input.manual : {};

  const nodes = new Map();
  const gamesByAppid = new Map();
  for (const game of games) {
    const appid = Number(game && game.appid);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    if (nodes.has(appid)) continue;
    const detailsDoc =
      details[String(appid)] && details[String(appid)].success ? details[String(appid)] : null;
    const linkDoc = links[String(appid)] || null;
    nodes.set(appid, nodeOf(game, detailsDoc, linkDoc));
    gamesByAppid.set(appid, game);
  }

  const blocked = new Set();
  for (const pair of Array.isArray(manual.splits) ? manual.splits : []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const left = Number(pair[0]);
    const right = Number(pair[1]);
    if (!Number.isInteger(left) || !Number.isInteger(right)) continue;
    blocked.add(`${Math.min(left, right)}:${Math.max(left, right)}`);
  }

  const adjacency = new Map();
  const confidences = new Map();
  const addEdge = (left, right, confidence) => {
    const key = `${Math.min(left, right)}:${Math.max(left, right)}`;
    if (blocked.has(key)) return;
    if (!adjacency.has(left)) adjacency.set(left, new Set());
    if (!adjacency.has(right)) adjacency.set(right, new Set());
    adjacency.get(left).add(right);
    adjacency.get(right).add(left);
    confidences.set(key, mergeConfidence(confidences.get(key) || 'single', confidence));
  };

  const appids = [...nodes.keys()];
  const byQid = new Map();
  for (const appid of appids) {
    const node = nodes.get(appid);
    for (const qid of new Set([node.qid, node.baseQid].filter(Boolean))) {
      const list = byQid.get(qid) || [];
      if (!list.includes(appid)) list.push(appid);
      byQid.set(qid, list);
    }
  }
  for (const list of byQid.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const match = editionMatch(nodes.get(list[i]), nodes.get(list[j]));
        if (match && match.confidence === 'qid') addEdge(list[i], list[j], 'qid');
      }
    }
  }

  const byTitle = new Map();
  for (const appid of appids) {
    const node = nodes.get(appid);
    for (const name of node.names) {
      const list = byTitle.get(name.key) || [];
      if (!list.includes(appid)) list.push(appid);
      byTitle.set(name.key, list);
    }
  }
  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const match = editionMatch(nodes.get(list[i]), nodes.get(list[j]));
        if (match) addEdge(list[i], list[j], match.confidence);
      }
    }
  }

  const bySignature = new Map();
  for (const appid of appids) {
    const node = nodes.get(appid);
    for (const name of node.names) {
      const signature = numericSignature(name.tokens);
      const list = bySignature.get(signature) || [];
      if (!list.includes(appid)) list.push(appid);
      bySignature.set(signature, list);
    }
  }
  for (const list of bySignature.values()) {
    if (list.length < 2 || list.length > 60) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const match = editionMatch(nodes.get(list[i]), nodes.get(list[j]));
        if (match && match.confidence === 'fuzzy') addEdge(list[i], list[j], 'fuzzy');
      }
    }
  }

  for (const pair of Array.isArray(manual.merges) ? manual.merges : []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const left = Number(pair[0]);
    const right = Number(pair[1]);
    if (!nodes.has(left) || !nodes.has(right)) continue;
    const key = `${Math.min(left, right)}:${Math.max(left, right)}`;
    blocked.delete(key);
    addEdge(left, right, 'manual');
  }

  const seen = new Set();
  const components = [];
  for (const appid of appids) {
    if (seen.has(appid)) continue;
    const stack = [appid];
    const component = [];
    seen.add(appid);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const neighbour of adjacency.get(current) || []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
    components.push(component.sort((a, b) => a - b));
  }

  const canonical = {};
  const groups = [];
  let mergedAppids = 0;
  for (const component of components) {
    const primaryAppid = primaryOf(component, nodes, gamesByAppid);
    const workKey = componentKey(component, nodes);
    let confidence = 'single';
    for (let i = 0; i < component.length; i++) {
      for (let j = i + 1; j < component.length; j++) {
        const key = `${Math.min(component[i], component[j])}:${Math.max(component[i], component[j])}`;
        const edge = confidences.get(key);
        if (edge) confidence = mergeConfidence(confidence, edge);
      }
    }
    const editionList = component.map((appid) => {
      const node = nodes.get(appid) || {};
      const game = gamesByAppid.get(appid) || {};
      return {
        appid,
        name: node.name || null,
        hours: round1((Number(game.playtime_forever) || 0) / 60),
        isPrimary: appid === primaryAppid,
      };
    });
    const entry = {
      workKey,
      primaryAppid,
      appids: component,
      editions: editionList,
      editionCount: component.length,
      confidence,
    };
    for (const appid of component) canonical[String(appid)] = entry;
    if (component.length > 1) {
      mergedAppids += component.length;
      groups.push({
        workKey,
        primaryAppid,
        appids: component,
        editions: editionList,
        confidence,
        names: component
          .map((appid) => (nodes.get(appid) || {}).name)
          .filter(Boolean),
      });
    }
  }

  groups.sort((left, right) => right.appids.length - left.appids.length || left.primaryAppid - right.primaryAppid);

  return {
    schemaVersion: 1,
    algorithmVersion: ALGORITHM_VERSION,
    profileKey: input.profileKey || null,
    libraryFingerprint: input.libraryFingerprint || null,
    inputsFingerprint: input.inputsFingerprint || null,
    builtAt: new Date().toISOString(),
    manual: {
      merges: Array.isArray(manual.merges) ? manual.merges : [],
      splits: Array.isArray(manual.splits) ? manual.splits : [],
    },
    manualFingerprint: manualSignature(manual),
    groups,
    canonical,
    meta: {
      appids: appids.length,
      works: components.length,
      groups: groups.length,
      gamesMerged: mergedAppids,
      savedCount: appids.length - components.length,
    },
  };
}

function inputSignature(library, details, links) {
  const libraryFingerprint = (library && library.fingerprint) || '';
  const describe = (map) => {
    let count = 0;
    let latest = '';
    for (const doc of Object.values(map && typeof map === 'object' ? map : {})) {
      if (!doc || typeof doc !== 'object') continue;
      if (doc.success === false) continue;
      count++;
      const stamp = String(doc.fetchedAt || '');
      if (stamp > latest) latest = stamp;
    }
    return `${count}:${latest}`;
  };
  return `${libraryFingerprint}|d${describe(details)}|l${describe(links)}`;
}

function manualSignature(manual) {
  const pairs = (value) =>
    (Array.isArray(value) ? value : [])
      .map((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return null;
        const left = Number(pair[0]);
        const right = Number(pair[1]);
        if (!Number.isInteger(left) || !Number.isInteger(right)) return null;
        return `${Math.min(left, right)}:${Math.max(left, right)}`;
      })
      .filter(Boolean)
      .sort();
  const merges = pairs(manual && manual.merges);
  const splits = pairs(manual && manual.splits);
  return `m[${merges.join(',')}]s[${splits.join(',')}]`;
}

function covers(doc, games) {
  if (!doc || !doc.canonical || typeof doc.canonical !== 'object') return false;
  for (const game of Array.isArray(games) ? games : []) {
    const appid = Number(game && game.appid);
    if (!Number.isInteger(appid)) continue;
    if (!doc.canonical[String(appid)]) return false;
  }
  return true;
}

function editionKeyOf(doc, appid) {
  const entry = doc && doc.canonical ? doc.canonical[String(appid)] : null;
  return entry && entry.workKey ? entry.workKey : `steam:${appid}`;
}

module.exports = {
  ALGORITHM_VERSION,
  buildEditionIndex,
  inputSignature,
  manualSignature,
  covers,
  editionKeyOf,
};
