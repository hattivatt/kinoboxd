'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const IMPORT_RE =
  /^\s*(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]|^\s*import\s+['"](\.[^'"]+)['"]/gm;

function entryModules() {
  return [...INDEX.matchAll(/<script type="module" src="\.\/([^"]+)"><\/script>/g)].map((m) => m[1]);
}

function moduleGraph(entries) {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const source = fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1] || match[2])));
    }
  };
  for (const entry of entries) walk(entry);
  return seen;
}

test('index.html preloads exactly the static import graph of its entry modules', () => {
  const entries = entryModules();
  assert.ok(entries.length > 0, 'index.html declares module entry points');
  const graph = moduleGraph(entries);
  for (const entry of entries) graph.delete(entry);
  const preloaded = [...INDEX.matchAll(/<link rel="modulepreload" href="\.\/([^"]+)">/g)].map((m) => m[1]);
  assert.equal(new Set(preloaded).size, preloaded.length, 'no module is preloaded twice');
  assert.deepEqual([...preloaded].sort(), [...graph].sort());
});
