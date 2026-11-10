'use strict';

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['server', 'public/js', 'scripts'];
const MODULE_SCAN_DIR = 'server';
const HELPER_SCAN_DIRS = SCAN_DIRS;
const IMPORT_SCAN_DIRS = ['server', 'scripts', 'test'];
const SKIP_DIRS = new Set(['node_modules', 'cache', 'cache-book', 'cache-games']);

const BIG_MODULE_LINES = 800;
const BIG_FUNCTION_LINES = 300;

const HELPERS = [
  'mapError',
  'round2',
  'dayNumber',
  'computeStreaks',
  'profileSummary',
  'safeKey',
  'normalizeStreaks',
  'pad2',
];

const REGEX_PRECEDERS = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
]);
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'delete', 'in', 'of', 'instanceof', 'new', 'void', 'do', 'else', 'yield', 'await',
]);

const FUNCTION_PATTERNS = [
  /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm,
  /^export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm,
  /^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?\(/gm,
];

function toRel(absolutePath) {
  return path.relative(APP_ROOT, absolutePath).split(path.sep).join('/');
}

function listJsFiles(dir, files = []) {
  const absolute = path.join(APP_ROOT, dir);
  if (!fs.existsSync(absolute)) return files;
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listJsFiles(rel, files);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(rel);
    }
  }
  return files;
}

function scanFiles(dirs = SCAN_DIRS) {
  const seen = new Set();
  const files = [];
  for (const dir of dirs) {
    for (const rel of listJsFiles(dir)) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      files.push(rel);
    }
  }
  return files;
}

function readSource(rel) {
  return fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');
}

function countLines(text) {
  if (!text) return 0;
  const newlines = text.split('\n').length;
  return text.endsWith('\n') ? newlines - 1 : newlines;
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function maskSource(text) {
  const chars = text.split('');
  const blank = (index) => {
    if (index >= 0 && index < chars.length && chars[index] !== '\n') chars[index] = ' ';
  };
  let i = 0;
  let lastSignificant = '';
  let lastWord = '';

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        blank(i);
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        blank(i);
        i += 1;
      }
      blank(i);
      blank(i + 1);
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      blank(i);
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') {
          blank(i);
          i += 1;
        }
        blank(i);
        i += 1;
      }
      blank(i);
      i += 1;
      lastSignificant = ch;
      lastWord = '';
      continue;
    }

    if (ch === '`') {
      blank(i);
      i += 1;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') {
          blank(i);
          i += 1;
        }
        blank(i);
        i += 1;
      }
      blank(i);
      i += 1;
      lastSignificant = ch;
      lastWord = '';
      continue;
    }

    if (ch === '/' && (REGEX_PRECEDERS.has(lastSignificant) || REGEX_KEYWORDS.has(lastWord))) {
      blank(i);
      i += 1;
      let inClass = false;
      while (i < text.length) {
        const c = text[i];
        if (c === '\n') break;
        if (c === '\\') {
          blank(i);
          blank(i + 1);
          i += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          blank(i);
          i += 1;
          break;
        }
        blank(i);
        i += 1;
      }
      lastSignificant = '/';
      lastWord = '';
      continue;
    }

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (/[A-Za-z0-9_$]/.test(ch)) {
      let word = '';
      while (i < text.length && /[A-Za-z0-9_$]/.test(text[i])) {
        word += text[i];
        i += 1;
      }
      lastWord = word;
      lastSignificant = word[word.length - 1];
      continue;
    }

    lastSignificant = ch;
    lastWord = '';
    i += 1;
  }

  return chars.join('');
}

function matchBracket(masked, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i += 1) {
    if (masked[i] === open) depth += 1;
    else if (masked[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipSpace(masked, index) {
  let i = index;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;
  return i;
}

function bodySpan(masked, startIndex, isArrow) {
  const openParen = startIndex;
  const closeParen = matchBracket(masked, openParen, '(', ')');
  if (closeParen < 0) return null;
  let cursor = skipSpace(masked, closeParen + 1);
  if (isArrow) {
    if (masked[cursor] !== '=' || masked[cursor + 1] !== '>') return null;
    cursor = skipSpace(masked, cursor + 2);
  }
  if (masked[cursor] !== '{') return null;
  const end = matchBracket(masked, cursor, '{', '}');
  return end < 0 ? null : end;
}

function functionsIn(file, options = {}) {
  const text = readSource(file);
  return functionsInText(file, text, options);
}

function functionsInText(file, text, options = {}) {
  const minLines = options.minLines || 0;
  const masked = maskSource(text);
  const starts = lineIndex(text);
  const found = [];

  FUNCTION_PATTERNS.forEach((pattern, patternIndex) => {
    const isArrow = patternIndex === 2;
    for (const match of masked.matchAll(pattern)) {
      if (match.index !== 0 && text[match.index - 1] !== '\n') continue;
      const name = match[1];
      const openParen = match.index + match[0].length - 1;
      const end = bodySpan(masked, openParen, isArrow);
      if (end == null) continue;
      const startLine = lineAt(starts, match.index);
      const endLine = lineAt(starts, end);
      if (endLine < startLine) continue;
      const length = endLine - startLine + 1;
      if (length < minLines) continue;
      found.push({ file, name, line: startLine, endLine, length });
    }
  });

  found.sort((a, b) => a.line - b.line);
  return found;
}

function longestFunctions(options = {}) {
  const files = options.files || SCAN_DIRS;
  const dirs = Array.isArray(files) ? files : [files];
  const minLines = options.minLines || 0;
  const result = [];
  for (const file of scanFiles(dirs)) {
    result.push(...functionsIn(file, { minLines }));
  }
  return result.sort((a, b) => b.length - a.length || a.file.localeCompare(b.file));
}

function modulesOver(limit = BIG_MODULE_LINES, dirs = SCAN_DIRS) {
  return moduleSizes(dirs).filter((entry) => entry.lines > limit);
}

function moduleSizes(dirs = SCAN_DIRS) {
  return scanFiles(dirs)
    .map((file) => ({ file, lines: countLines(readSource(file)) }))
    .sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
}

function helperPatterns(name) {
  const escaped = name.replace(/[$]/g, '\\$');
  return [
    new RegExp(`^function\\s+${escaped}\\s*\\(`, 'gm'),
    new RegExp(`^export\\s+(?:default\\s+)?function\\s+${escaped}\\s*\\(`, 'gm'),
    new RegExp(`^(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\(`, 'gm'),
    new RegExp(`^(?:const|let|var)\\s+${escaped}\\s*=\\s*[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*\\s*;`, 'gm'),
  ];
}

function helperDefinitions(names = HELPERS, dirs = HELPER_SCAN_DIRS) {
  const files = scanFiles(dirs);
  const sources = new Map(files.map((file) => [file, readSource(file)]));
  const result = {};
  for (const name of names) {
    const sites = [];
    for (const file of files) {
      const text = sources.get(file);
      for (const pattern of helperPatterns(name)) {
        for (const match of text.matchAll(pattern)) {
          if (match.index !== 0 && text[match.index - 1] !== '\n') continue;
          sites.push({ file, line: lineAt(lineIndex(text), match.index) });
        }
      }
    }
    sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    result[name] = sites;
  }
  return result;
}

function helperCounts(names = HELPERS, dirs = HELPER_SCAN_DIRS) {
  const definitions = helperDefinitions(names, dirs);
  const counts = {};
  for (const name of names) counts[name] = definitions[name].length;
  return counts;
}

function scriptEntryTokens() {
  const pkg = JSON.parse(readSource('package.json'));
  const tokens = new Set();
  for (const body of Object.values(pkg.scripts || {})) {
    for (const token of String(body).split(/\s+/)) {
      if (token.endsWith('.js')) tokens.add(token);
    }
  }
  return { main: pkg.main || null, tokens };
}

function isEntryPoint(file, entry) {
  if (file === 'server/index.js') return true;
  if (entry.main && file === entry.main) return true;
  if (entry.tokens.has(file)) return true;
  return /require\.main\s*===\s*module/.test(readSource(file));
}

function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), specifier),
  );
  const candidates = [base, `${base}.js`, `${base}/index.js`];
  for (const candidate of candidates) {
    if (candidate.startsWith('../') || candidate.startsWith('/')) continue;
    const absolute = path.join(APP_ROOT, candidate);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return candidate;
  }
  return null;
}

function requireEdges() {
  const edges = [];
  for (const from of scanFiles(IMPORT_SCAN_DIRS)) {
    const text = readSource(from);
    for (const match of text.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
      const target = resolveSpecifier(from, match[1]);
      if (target) edges.push({ from, to: target });
    }
    for (const match of text.matchAll(/require\(\s*"([^"]+)"\s*\)/g)) {
      const target = resolveSpecifier(from, match[1]);
      if (target) edges.push({ from, to: target });
    }
  }
  return edges;
}

function ownTestFiles(module) {
  const rel = module.replace(/^server\//, '').replace(/\.js$/, '');
  return new Set([rel.replace(/\//g, '-'), path.posix.basename(module, '.js')]);
}

function isOwnTest(module, importer) {
  if (!importer.startsWith('test/')) return false;
  const stem = path.posix.basename(importer, '.js').replace(/\.test$/, '');
  return ownTestFiles(module).has(stem);
}

function deadModuleReport(options = {}) {
  const dir = options.dir || MODULE_SCAN_DIR;
  const entry = scriptEntryTokens();
  const edges = requireEdges();
  const importers = new Map();
  for (const { from, to } of edges) {
    if (!importers.has(to)) importers.set(to, new Set());
    importers.get(to).add(from);
  }
  const modules = listJsFiles(dir).filter((file) => file.startsWith(`${dir}/`));
  const dead = [];
  const entries = [];
  for (const module of modules) {
    if (isEntryPoint(module, entry)) {
      entries.push(module);
      continue;
    }
    const live = [...(importers.get(module) || [])].some((from) => !isOwnTest(module, from));
    if (!live) dead.push(module);
  }
  return { dead, entries: entries.sort(), modules, edges };
}

function deadModules(options = {}) {
  return deadModuleReport(options).dead;
}

function testPorts(dir = 'test') {
  const result = [];
  for (const file of listJsFiles(dir).filter((name) => name.endsWith('.test.js'))) {
    const text = readSource(file);
    const starts = lineIndex(text);
    for (const match of text.matchAll(/const\s+PORT\s*=\s*([^;\n]+)/g)) {
      const numbers = match[1].match(/\d{2,5}/g);
      if (!numbers) continue;
      result.push({
        file,
        line: lineAt(starts, match.index),
        port: Number(numbers[numbers.length - 1]),
      });
    }
  }
  return result;
}

function duplicatePorts(ports = testPorts()) {
  const byPort = new Map();
  for (const entry of ports) {
    if (!byPort.has(entry.port)) byPort.set(entry.port, []);
    byPort.get(entry.port).push(entry);
  }
  const duplicates = [];
  for (const [port, sites] of [...byPort.entries()].sort((a, b) => a[0] - b[0])) {
    if (sites.length > 1) duplicates.push({ port, sites });
  }
  return duplicates;
}

function portHelperSlots(dir = 'test') {
  const result = [];
  for (const file of listJsFiles(dir).filter((name) => name.endsWith('.test.js'))) {
    const text = readSource(file);
    const starts = lineIndex(text);
    for (const match of text.matchAll(/portFor\(\s*(\d+)\s*\)/g)) {
      result.push({
        file,
        line: lineAt(starts, match.index),
        slot: Number(match[1]),
      });
    }
  }
  return result;
}

function duplicatePortSlots(slots = portHelperSlots()) {
  const owners = new Map();
  for (const entry of slots) {
    if (!owners.has(entry.slot)) owners.set(entry.slot, new Set());
    owners.get(entry.slot).add(entry.file);
  }
  const duplicates = [];
  for (const [slot, files] of [...owners.entries()].sort((a, b) => a[0] - b[0])) {
    if (files.size < 2) continue;
    duplicates.push({
      slot,
      sites: slots.filter((entry) => entry.slot === slot),
    });
  }
  return duplicates;
}

function hardcodedPortLiterals(dir = 'test') {
  const result = [];
  for (const file of listJsFiles(dir).filter((name) => name.endsWith('.test.js'))) {
    const text = readSource(file);
    const starts = lineIndex(text);
    for (const match of text.matchAll(/(?:^|[^A-Za-z0-9])(?:PREFERRED_)?PORT\s*=\s*['"]?\d+/g)) {
      result.push({ file, line: lineAt(starts, match.index), literal: match[0].trim() });
    }
  }
  return result;
}

function hardcodedListenPorts(dir = 'test') {
  const result = [];
  for (const file of listJsFiles(dir).filter((name) => name.endsWith('.test.js'))) {
    const text = readSource(file);
    const starts = lineIndex(text);
    for (const match of text.matchAll(/\.listen\(\s*(\d+)\b/g)) {
      if (Number(match[1]) === 0) continue;
      result.push({ file, line: lineAt(starts, match.index), port: Number(match[1]) });
    }
  }
  return result;
}

function pad(value, width) {
  return String(value).padStart(width, ' ');
}

function reportSection(title, lines) {
  return [`${title}`, ...lines.map((line) => `  ${line}`), ''];
}

function formatCensus() {
  const lines = [];
  const sizes = moduleSizes();
  const bigModules = sizes.filter((entry) => entry.lines > BIG_MODULE_LINES);
  lines.push('module sizes (lines, largest first):');
  lines.push(`  scanned ${sizes.length} .js files in ${SCAN_DIRS.join(', ')}`);
  for (const entry of sizes.slice(0, 20)) {
    lines.push(`  ${pad(entry.lines, 5)}  ${entry.file}`);
  }
  lines.push('');
  lines.push(...reportSection(`modules over ${BIG_MODULE_LINES} lines: ${bigModules.length}`, bigModules.map(
    (entry) => `${pad(entry.lines, 5)}  ${entry.file}`,
  )));

  const functions = longestFunctions({ minLines: BIG_FUNCTION_LINES });
  const pairs = new Set();
  for (const fn of functions) pairs.add(`${fn.file}\u0000${fn.name}`);
  const functionLines = functions.map(
    (fn) => `${pad(fn.length, 5)}  ${fn.file}:${fn.line}  ${fn.name}()`,
  );
  lines.push(...reportSection(
    `functions over ${BIG_FUNCTION_LINES} lines: ${pairs.size}`,
    functionLines,
  ));

  const definitions = helperDefinitions();
  const helperLines = [];
  for (const name of HELPERS) {
    const sites = definitions[name];
    helperLines.push(`${pad(sites.length, 2)}  ${name}`);
    for (const site of sites) helperLines.push(`      ${site.file}:${site.line}`);
  }
  lines.push(...reportSection('helper definition sites:', helperLines));

  const report = deadModuleReport();
  const deadLines = report.dead.length
    ? report.dead.map((file) => file)
    : ['(none)'];
  deadLines.push(`entry points (excluded): ${report.entries.length}`);
  for (const file of report.entries) deadLines.push(`    ${file}`);
  lines.push(...reportSection(
    `dead server modules: ${report.dead.length} of ${report.modules.length}`,
    deadLines,
  ));

  const ports = testPorts();
  const duplicates = duplicatePorts(ports);
  const slots = portHelperSlots();
  const duplicateSlots = duplicatePortSlots(slots);
  const portLines = [
    `declared const PORT: ${ports.length}`,
    `portFor slots: ${slots.length}`,
    `hardcoded PORT literals: ${hardcodedPortLiterals().length}`,
    `hardcoded listen(N): ${hardcodedListenPorts().length}`,
  ];
  for (const entry of ports) portLines.push(`    ${pad(entry.port, 5)}  ${entry.file}:${entry.line}`);
  if (duplicates.length) {
    for (const duplicate of duplicates) {
      portLines.push(`  DUPLICATE ${duplicate.port}:`);
      for (const site of duplicate.sites) portLines.push(`      ${site.file}:${site.line}`);
    }
  } else {
    portLines.push('duplicates: none');
  }
  for (const duplicate of duplicateSlots) {
    portLines.push(`  DUPLICATE SLOT ${duplicate.slot}:`);
    for (const site of duplicate.sites) portLines.push(`      ${site.file}:${site.line}`);
  }
  lines.push(...reportSection('test ports:', portLines));

  return lines.join('\n');
}

function main() {
  process.stdout.write(`${formatCensus()}\n`);
  return 0;
}

module.exports = {
  BIG_FUNCTION_LINES,
  BIG_MODULE_LINES,
  HELPERS,
  SCAN_DIRS,
  countLines,
  deadModuleReport,
  deadModules,
  duplicatePorts,
  duplicatePortSlots,
  formatCensus,
  functionsInText,
  hardcodedListenPorts,
  hardcodedPortLiterals,
  helperCounts,
  helperDefinitions,
  listJsFiles,
  longestFunctions,
  maskSource,
  moduleSizes,
  modulesOver,
  portHelperSlots,
  readSource,
  requireEdges,
  testPorts,
};

if (require.main === module) main();
