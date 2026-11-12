'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const census = require('../scripts/census');

const BIG_MODULE_LINES = 800;
const BIG_FUNCTION_LINES = 300;

const MODULE_ALLOWLIST = {
  'public/js/books.js': 4294,
  'public/js/games-view.js': 2017,
  'public/js/games.js': 3465,
  'public/js/widgets.js': 1971,
  'public/js/main.js': 1819,
  'server/games/franchise.js': 1569,
  'server/books/livelib.js': 1508,
  'public/js/games-modal.js': 1474,
  'scripts/gen-contracts.js': 1343,
  'server/kp.js': 1337,
  'server/books/livelib-file.js': 1284,
  'server/tmdb.js': 1187,
  'server/books/import.js': 1008,
  'server/games/enrich.js': 1005,
  'server/games/sources/epic.js': 1003,
  'server/books/hardcover.js': 992,
  'public/js/modal.js': 982,
  'server/books/book-cache.js': 927,
  'server/wikidata.js': 918,
  'server/games/steam.js': 876,
  'server/books/routes.js': 844,
};
};

const FUNCTION_ALLOWLIST = {};

const HELPER_BASELINE = {
  mapError: 0,
  round2: 6,
  dayNumber: 3,
  computeStreaks: 2,
  profileSummary: 3,
  safeKey: 3,
  normalizeStreaks: 2,
  pad2: 2,
};

const DEAD_MODULE_ALLOWLIST = new Set(['server/core/store.js']);

function functionKey(entry) {
  return `${entry.file}:${entry.name}`;
}

function moduleViolations(measured, allowlist, limit) {
  const violations = [];
  for (const entry of measured) {
    const allowed = allowlist[entry.file];
    if (allowed == null) violations.push(`${entry.file} rode to ${entry.lines} lines, not in the allowlist`);
    else if (entry.lines > allowed) violations.push(`${entry.file} grew to ${entry.lines} lines, allowlist records ${allowed}`);
  }
  return violations.length ? `${measured.length} modules over ${limit} lines: ${violations.join('; ')}` : null;
}

test(`module-size ratchet: every .js module over ${BIG_MODULE_LINES} lines is allowlisted, none may grow`, () => {
  const measured = census.modulesOver(BIG_MODULE_LINES);
  const failure = moduleViolations(measured, MODULE_ALLOWLIST, BIG_MODULE_LINES);
  assert.equal(failure, null, failure || '');
});

test(`function-size ratchet: every top-level function over ${BIG_FUNCTION_LINES} lines is allowlisted, none may grow`, () => {
  const measured = census.longestFunctions({ minLines: BIG_FUNCTION_LINES });
  const violations = [];
  for (const entry of measured) {
    const key = functionKey(entry);
    const allowed = FUNCTION_ALLOWLIST[key];
    if (allowed == null) violations.push(`${key} is ${entry.length} lines, not in the allowlist`);
    else if (entry.length > allowed) violations.push(`${key} grew to ${entry.length} lines, allowlist records ${allowed}`);
  }
  assert.deepEqual(
    violations,
    [],
    `${measured.length} functions over ${BIG_FUNCTION_LINES} lines: ${violations.join('; ')}`,
  );
});

test('census function lengths calibrate on the two known giants', () => {
  const measured = new Map(
    census.longestFunctions({ minLines: 1 }).map((entry) => [functionKey(entry), entry.length]),
  );
  assert.equal(measured.get('server/games/epic.js:createClient'), 38, 'epic createClient');
  assert.equal(measured.get('server/books/resolve.js:resolveProfile'), 17, 'books resolveProfile');
});

test('charts renderYearBars stays within the split budget', () => {
  const renderYearBars = census
    .longestFunctions({ minLines: 1 })
    .find((entry) => entry.file === 'public/js/charts/year-bars.js' && entry.name === 'renderYearBars');
  assert.ok(renderYearBars, 'charts renderYearBars is still measured by the census');
  assert.ok(
    renderYearBars.length <= 150,
    `charts renderYearBars is ${renderYearBars.length} lines, budget 150`,
  );
});

test('helper copies do not multiply: definition counts equal the pinned baseline', () => {
  const counts = census.helperCounts();
  const grown = [];
  for (const [name, baseline] of Object.entries(HELPER_BASELINE)) {
    const actual = counts[name] == null ? 0 : counts[name];
    if (actual > baseline) grown.push(`${name} has ${actual} definitions, baseline ${baseline}`);
  }
  assert.deepEqual(grown, [], `helper-copy census: ${JSON.stringify(counts)}; ${grown.join('; ')}`);
});

test('dead modules: nothing but the allowlisted orphan', () => {
  const dead = census.deadModules();
  const unexpected = dead.filter((file) => !DEAD_MODULE_ALLOWLIST.has(file));
  assert.deepEqual(unexpected, [], `dead modules found: ${dead.join(', ') || '(none)'}`);
});

test('test ports: declared PORTs and portFor slots are unique, every port comes from the helper', () => {
  const duplicates = census.duplicatePorts();
  const described = duplicates
    .map((entry) => `port ${entry.port} used by ${entry.sites.map((site) => `${site.file}:${site.line}`).join(', ')}`)
    .join('; ');
  assert.deepEqual(duplicates, [], `test-port uniqueness: ${duplicates.length} duplicate(s); ${described}`);

  const literals = census.hardcodedPortLiterals();
  const literalSites = literals.map((entry) => `${entry.file}:${entry.line} ${entry.literal}`).join('; ');
  assert.deepEqual(
    literals,
    [],
    `helper-only ports: ${literals.length} hardcoded PORT literal(s); ${literalSites}`,
  );

  const listens = census.hardcodedListenPorts();
  const listenSites = listens.map((entry) => `${entry.file}:${entry.line} listen(${entry.port})`).join('; ');
  assert.deepEqual(
    listens,
    [],
    `helper-only listen: ${listens.length} fixed .listen(N) port(s); ${listenSites}`,
  );

  const slots = census.duplicatePortSlots();
  const slotSites = slots
    .map((entry) => `slot ${entry.slot} used by ${entry.sites.map((site) => `${site.file}:${site.line}`).join(', ')}`)
    .join('; ');
  assert.deepEqual(slots, [], `portFor slot uniqueness: ${slots.length} duplicate(s); ${slotSites}`);

  const declared = census.portHelperSlots();
  assert.ok(declared.length >= 20, `portFor census found only ${declared.length} slots`);
});

test('census walks only the app tree and skips cache and dependency dirs', () => {
  const files = census.listJsFiles('server');
  const leaking = files.filter(
    (file) => file.includes('node_modules') || /(?:^|\/)cache(?:-|$)/.test(file),
  );
  assert.deepEqual(leaking, [], `census file walk leaks: ${leaking.join(', ')}`);
  assert.ok(files.length > 100, `server scan found ${files.length} files`);
});
