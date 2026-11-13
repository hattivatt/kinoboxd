'use strict';

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const CONTRACTS_DIR = path.join(APP_ROOT, 'contracts');
const MODES = ['api', 'env', 'limits', 'cache'];

function readRel(rel) {
  return fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function squash(value, limit = 160) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function walk(dirRel, filter, out = []) {
  const abs = path.join(APP_ROOT, dirRel);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const rel = path.posix.join(dirRel, entry.name);
    if (entry.isDirectory()) walk(rel, filter, out);
    else if (filter(rel)) out.push(rel);
  }
  return out;
}

function mdEscape(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|');
}

function mdTable(headers, rows) {
  const lines = [];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) lines.push(`| ${row.map(mdEscape).join(' | ')} |`);
  return lines.join('\n');
}

function formatMs(ms) {
  if (ms == null) return '—';
  const value = Number(ms);
  if (!Number.isFinite(value)) return String(ms);
  if (value === 0) return '0';
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  const second = 1000;
  if (value % day === 0) return `${value} ms (${value / day} d)`;
  if (value % hour === 0) return `${value} ms (${value / hour} h)`;
  if (value % minute === 0) return `${value} ms (${value / minute} min)`;
  if (value % second === 0) return `${value} ms (${value / second} s)`;
  return `${value} ms`;
}

function docBefore(text, index) {
  const before = text.slice(0, index);
  const rows = before.split('\n');
  rows.pop();
  let i = rows.length - 1;
  while (i >= 0 && rows[i].trim() === '') i--;
  const collected = [];
  while (i >= 0) {
    const raw = rows[i].trim();
    if (raw.startsWith('*') || raw.startsWith('//') || raw.startsWith('/*')) {
      collected.unshift(raw);
      i--;
      continue;
    }
    break;
  }
  const cleaned = collected
    .map((row) =>
      row
        .replace(/^\/\*+/, '')
        .replace(/\*+\/$/, '')
        .replace(/^\*+/, '')
        .replace(/^\/\/+/, '')
        .trim()
    )
    .filter((row) => row && !/^[-=_*]+$/.test(row));
  const flat = squash(cleaned.join(' '), 220);
  return flat || null;
}

function splitTopLevel(text) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += text[i + 1] || '';
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim());
}

function balancedEnd(text, open) {
  let depth = 0;
  let quote = null;
  for (let j = open; j < text.length; j++) {
    const ch = text[j];
    if (quote) {
      if (ch === '\\') j++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function findCalls(text, needle) {
  const calls = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    const prev = at > 0 ? text[at - 1] : '';
    if (prev && /[\w$]/.test(prev)) {
      from = at + needle.length;
      continue;
    }
    const open = at + needle.length - 1;
    const end = balancedEnd(text, open);
    calls.push({ index: at, args: text.slice(open + 1, end === -1 ? text.length : end) });
    from = end === -1 ? text.length : end + 1;
  }
  return calls;
}

const MOUNTED_ROUTE_FILES = [
  'server/auth.js',
  'server/films/routes.js',
  'server/books/routes.js',
  'server/games/routes.js',
  'server/games/routes-gog.js',
  'server/games/routes-epic.js',
  'server/games/routes-franchise.js',
  'server/games/personnel/routes-personnel.js',
].concat(['server/books/routes-stats.js', 'server/books/routes-manual.js']);

const ROUTE_BODY_DIRS = [
  { file: 'server/games/routes.js', dir: 'server/games/endpoints' },
  { file: 'server/games/routes-epic.js', dir: 'server/games/endpoints/epic' },
];

function requireMap(text) {
  return new Map([...text.matchAll(/const\s+(\w+)\s*=\s*require\('(\.\/[^']+)'\);/g)].map((m) => [m[1], m[2]]));
}

function discoverMounts() {
  const text = readRel('server/index.js');
  const requires = requireMap(text);
  const mounts = new Map();
  const addMount = (file, prefixes) => mounts.set(file, new Set([...(mounts.get(file) || []), ...prefixes]));
  for (const m of text.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*([\w.]+)\s*\)/g)) {
    const mod = /(Router$|\.router$)/.test(m[2]) && requires.get(m[2].split('.')[0]);
    if (mod) addMount(`${path.posix.normalize(path.posix.join('server', mod))}.js`, [m[1]]);
  }
  for (const [file, prefixes] of [...mounts]) {
    for (const m of readRel(file).matchAll(/router\.use\(\s*(\w+Router)\s*\)/g)) {
      const mod = requireMap(readRel(file)).get(m[1]);
      if (mod) addMount(`${path.posix.join(path.posix.dirname(file), mod)}.js`, prefixes);
    }
  }
  return mounts;
}

function routeDeclarations(text) {
  const decls = [];
  const re = /^[ \t]*(app|router)\.(get|post|put|patch|delete)\(\s*'([^']*)'/gm;
  for (const m of text.matchAll(re)) {
    const open = m.index + m[0].indexOf('(');
    const close = balancedEnd(text, open);
    decls.push({
      index: m.index,
      open,
      close: close === -1 ? text.length : close + 1,
      method: m[2].toUpperCase(),
      rawPath: m[3],
      line: lineOf(text, m.index),
    });
  }
  return decls;
}

function joinPath(prefix, rawPath) {
  if (rawPath === '*') return '*';
  const clean = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const joined = `${prefix}${clean}`;
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
}

function extractAllowedQuery(block) {
  const names = new Set();
  for (const call of findCalls(block, 'assertOnlyParams(')) {
    const parts = splitTopLevel(call.args);
    if (parts.length < 2) continue;
    for (const q of parts[1].matchAll(/'([^']+)'/g)) names.add(q[1]);
  }
  return [...names].sort();
}

function extractQueryReads(block) {
  const names = new Set();
  for (const m of block.matchAll(/req\.query\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return [...names].sort();
}

function parseHttpError(argsText) {
  const parts = splitTopLevel(argsText);
  if (!parts.length) return null;
  const status = /^\d{3}$/.test(parts[0]) ? parts[0] : squash(parts[0], 40);
  let code = null;
  const last = parts[parts.length - 1];
  if (parts.length >= 3 && /^'[^']*'$/.test(last)) code = last.slice(1, -1);
  if (!code) {
    for (const part of parts.slice(1)) {
      const m = /'([a-z][a-z0-9_]{2,})'/.exec(part);
      if (m) {
        code = m[1];
        break;
      }
    }
  }
  return { status, code: code || '—', message: squash(parts[1] || '', 140) };
}

function extractBlockErrors(block) {
  const found = new Map();
  for (const call of findCalls(block, 'HttpError(')) {
    const parsed = parseHttpError(call.args);
    if (!parsed) continue;
    const key = `${parsed.status}:${parsed.code}`;
    if (!found.has(key)) found.set(key, parsed);
  }
  for (const call of findCalls(block, 'parseBoolean(')) {
    const code = /code:\s*'([^']+)'/.exec(call.args);
    if (code) found.set(`400:${code[1]}`, { status: '400', code: code[1], message: 'must be 0 or 1.' });
  }
  const literalRe = /res\.status\((4\d\d|5\d\d)\)\.json\(\{([\s\S]{0,500}?)\}\)/g;
  for (const m of block.matchAll(literalRe)) {
    const codeMatch = /code:\s*'([^']+)'/.exec(m[2]);
    const code = codeMatch ? codeMatch[1] : '—';
    const key = `${m[1]}:${code}`;
    if (!found.has(key)) {
      found.set(key, {
        status: m[1],
        code,
        message: squash(/error:\s*['"`]([^'"`]+)/.exec(m[2])?.[1] || '', 140),
      });
    }
  }
  return [...found.values()].sort(
    (a, b) => String(a.status).localeCompare(String(b.status)) || a.code.localeCompare(b.code)
  );
}

function collectRoutes() {
  const mounts = discoverMounts();
  const files = [{ file: 'server/index.js', prefixes: [''] }];
  for (const file of MOUNTED_ROUTE_FILES) {
    const prefixes = mounts.get(file);
    files.push({ file, prefixes: prefixes ? [...prefixes].sort() : [''] });
  }
  for (const { file, dir } of ROUTE_BODY_DIRS) {
    const prefixes = [...(mounts.get(file) || [''])].sort();
    const names = fs
      .readdirSync(path.join(APP_ROOT, dir))
      .filter((name) => name.endsWith('.js'))
      .sort();
    for (const name of names) files.push({ file: `${dir}/${name}`, prefixes });
  }

  const routes = [];
  for (const { file, prefixes } of files) {
    const text = readRel(file);
    const decls = routeDeclarations(text);
    decls.forEach((decl) => {
      const block = text.slice(decl.index, decl.close);
      const fullPath = joinPath(prefixes[0], decl.rawPath);
      routes.push({
        method: decl.method,
        path: fullPath,
        file,
        line: decl.line,
        params: [...new Set([...decl.rawPath.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1]))],
        query: extractAllowedQuery(block),
        queryReads: extractQueryReads(block),
        errors: extractBlockErrors(block),
        note: docBefore(text, decl.index),
      });
    });
  }
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return { routes, mounts };
}

function renderApi() {
  const { routes, mounts } = collectRoutes();
  const lines = [];
  lines.push('<!-- GENERATED FILE — do not edit by hand. Regenerate: node scripts/gen-contracts.js api -->');
  lines.push('# HTTP API contract');
  lines.push('');
  lines.push(
    'Сгенерировано из объявлений роутов в `server/` (P9, план §3.5). ' +
      'Источник истины — сами роутеры: если таблица расходится с кодом, ' +
      'перегенерируй (`node scripts/gen-contracts.js`), а не правь файл.'
  );
  lines.push('');
  lines.push(
    `Роутов: **${routes.length}**. Тело ошибки всегда \`{ error, code }\` ` +
      '(`server/core/errors.js`); неизвестный query-параметр — 400 ' +
      '`unexpected_parameter` (`server/core/params.js`).'
  );
  lines.push('');
  lines.push('## Точки монтирования');
  lines.push('');
  const mountRows = [];
  for (const [file, prefixes] of [...mounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    mountRows.push([`\`${file}\``, [...prefixes].sort().map((p) => `\`${p}\``).join(', ')]);
  }
  lines.push(mdTable(['Файл', 'Префикс (app.use)'], mountRows));
  lines.push('');
  lines.push('`server/index.js` держит `/api/health` и SPA-catch-all; `server/auth.js` — `/api/auth/*`.');
  lines.push('');
  lines.push('## Сводка');
  lines.push('');
  lines.push(
    mdTable(
      ['Method', 'Path', 'Строгий query (assertOnlyParams)', 'Ошибки (status:code)', 'Источник'],
      routes.map((route) => [
        route.method,
        `\`${route.path}\``,
        route.query.length ? route.query.map((q) => `\`${q}\``).join(', ') : '—',
        route.errors.length
          ? route.errors.map((e) => `${e.status}:${e.code}`).join(', ')
          : '—',
        `\`${route.file}:${route.line}\``,
      ])
    )
  );
  lines.push('');
  lines.push('## Детали');
  lines.push('');
  for (const route of routes) {
    lines.push(`### \`${route.method} ${route.path}\``);
    lines.push('');
    lines.push(`- файл: \`${route.file}:${route.line}\``);
    if (route.params.length) lines.push(`- path-параметры: ${route.params.map((p) => `\`${p}\``).join(', ')}`);
    if (route.query.length) {
      lines.push(`- query (строгий список): ${route.query.map((q) => `\`${q}\``).join(', ')}`);
    } else {
      lines.push('- query: — (строгого `assertOnlyParams` нет)');
    }
    if (!route.query.length && route.queryReads.length) {
      lines.push(
        `- query, читаемый без строгой проверки: ${route.queryReads
          .map((q) => `\`${q}\``)
          .join(', ')} — см. модуль`
      );
    }
    if (route.errors.length) {
      for (const err of route.errors) {
        lines.push(
          `- ошибка \`${err.status}\` \`${err.code}\`${err.message ? `: ${err.message}` : ''}`
        );
      }
    } else {
      lines.push('- ошибки: только общие (400 `unexpected_parameter`, 500 `internal_error`)');
    }
    if (route.note) lines.push(`- описание: ${route.note}`);
    lines.push('');
  }
  return lines.join('\n');
}

const ENV_LITERAL_CONTEXT =
  /(env|budget|ttl|pause|timeout|breaker|ENV_KEYS|envKeys|_ENV|_KEYS|KEY_FILE|fromEnv|envMs|envTtl|envInt)[\w$]*[=:(,\[\s]{0,8}$/i;

function collectCredentials() {
  const text = readRel('server/config.js');
  const arrays = new Map();
  for (const m of text.matchAll(/const\s+([A-Z_]+)\s*=\s*\[([^\]]*)\];/g)) {
    arrays.set(
      m[1],
      [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])
    );
  }
  const files = new Map();
  for (const m of text.matchAll(
    /const\s+([A-Z_]+)\s*=\s*path\.join\(__dirname,\s*'\.\.',\s*'config',\s*'([^']+)'\);/g
  )) {
    files.set(m[1], `config/${m[2]}`);
  }
  const groups = [];
  for (const m of text.matchAll(/const\s+(\w+)\s*=\s*createSecret\(\{([\s\S]*?)\}\);/g)) {
    const body = m[2];
    const envKeysVar = (/envKeys:\s*([A-Z_]+)/.exec(body) || [])[1];
    const fileVar = (/file:\s*([\w]+)/.exec(body) || [])[1];
    const snake = fileVar
      ? fileVar.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
      : null;
    groups.push({
      name: m[1],
      envKeys: arrays.get(envKeysVar) || [],
      file: files.get(fileVar) || (snake && files.get(snake)) || (fileVar ? `\`${fileVar}\`` : '—'),
    });
  }

  for (const rel of walk('server', (file) => file.endsWith('.js'))) {
    if (rel === 'server/config.js') continue;
    const source = readRel(rel);
    for (const m of source.matchAll(/const\s+([A-Z][A-Z0-9_]*)_ENV_KEYS\s*=\s*\[([^\]]*)\];/g)) {
      const prefix = m[1];
      const envKeys = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      const fileMatch = new RegExp(
        `const\\s+${prefix}_FILE\\s*=\\s*path\\.join\\(([^;]+)\\);`
      ).exec(source);
      let filePath = '—';
      if (fileMatch) {
        const resolved = resolveDirnameJoin(fileMatch[1], rel);
        if (resolved) filePath = `app/${resolved}`;
      }
      groups.push({ name: `\`${rel}\` (${prefix.toLowerCase()}_ENV_KEYS)`, envKeys, file: filePath });
    }
  }
  return groups;
}

function collectEnvNames(texts) {
  const names = new Map();

  function add(name, file, text, index) {
    if (names.has(name)) return;
    const lineStart = text.lastIndexOf('\n', index) + 1;
    const lineEnd = text.indexOf('\n', index);
    const snippet = squash(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd), 130);
    names.set(name, {
      file,
      line: lineOf(text, index),
      snippet,
      purpose: docBefore(text, lineStart) || null,
    });
  }

  for (const [file, text] of texts) {
    for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      add(m[1], file, text, m.index);
    }
    for (const m of text.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) {
      add(m[1], file, text, m.index);
    }
    for (const m of text.matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)) {
      const context = text.slice(Math.max(0, m.index - 80), m.index);
      if (!ENV_LITERAL_CONTEXT.test(context)) continue;
      add(m[1], file, text, m.index);
    }
  }
  return names;
}

const SOURCE_ENV_FIELDS = [
  ['pauseEnv', (entry) => `pauseMs = ${formatMs(entry.pauseMs)}`],
  ['pauseMaxEnv', (entry) => `pauseMaxMs = ${formatMs(entry.pauseMaxMs)}`],
  ['playtimePauseEnv', (entry) => `playtimePauseMs = ${formatMs(entry.playtimePauseMs)}`],
  ['timeoutEnv', (entry) => `timeoutMs = ${formatMs(entry.timeoutMs)}`],
  ['budgetEnv', (entry) => `budget = ${entry.budgetDefault} (0 = off)`],
  ['breakerEnv', (entry) => `breakerMs = ${formatMs(entry.breakerMs)}`],
  ['ttlEnv', (entry) =>
    `ttlMs = ${formatMs(entry.ttlMs)}${String(entry.ttlEnv || '').endsWith('_DAYS') ? ' (env in days)' : ''}`],
];

function sourceEnvIndex() {
  const { SOURCES } = require(path.join(APP_ROOT, 'server', 'core', 'sources.js'));
  const index = new Map();
  for (const entry of Object.values(SOURCES)) {
    for (const [field, describe] of SOURCE_ENV_FIELDS) {
      const env = entry[field];
      if (!env) continue;
      if (!index.has(env)) index.set(env, []);
      index.get(env).push({ id: entry.id, defaultText: describe(entry) });
    }
  }
  return index;
}

function resolveIdentifierDefault(value, where, texts, { ms = true } = {}) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) return null;
  const entry = texts.find(([file]) => file === where);
  if (!entry) return null;
  const m = new RegExp(`const\\s+${value}\\s*=\\s*([^;]+);`).exec(entry[1]);
  if (!m) return null;
  const numeric = evaluateMs(m[1], new Map());
  if (numeric != null) {
    return `${ms ? formatMs(numeric) : numeric} (${value})`;
  }
  const literal = /^'([^']*)'$/.exec(m[1].trim());
  if (literal) return `${literal[1]} (${value})`;
  return null;
}

function cleanDefault(raw) {
  let value = squash(raw, 90);
  if (/^path\.join\(/.test(value)) return value;
  value = value.replace(/\)+$/, '');
  value = value.split(/\)\.|\|\||\?/)[0].trim();
  return value;
}

function defaultFromCode(texts, name) {
  const patterns = [
    new RegExp(`envNonNegative\\(\\s*'${name}'\\s*,\\s*([^)]+)\\)`),
    new RegExp(`envPositive\\(\\s*'${name}'\\s*,\\s*([^)]+)\\)`),
    new RegExp(`envInt\\(\\s*'${name}'\\s*,\\s*([^)]+)\\)`),
    new RegExp(`envMs\\(\\s*'${name}'\\s*,\\s*([^)]+)\\)`),
    new RegExp(`envTtl\\(\\s*'${name}'\\s*,\\s*([^)]+)\\)`),
    new RegExp(`budgetLimitFromEnv\\(\\s*'${name}'\\s*,\\s*([^)]+)\\)`),
    new RegExp(
      `process\\.env\\.${name}\\s*\\?\\s*[\\s\\S]{0,120}?:\\s*(path\\.join\\([^)]*\\))`
    ),
    new RegExp(`Number\\(process\\.env\\.${name}\\)\\s*\\|\\|\\s*([^;\\n,]+)`),
    new RegExp(`process\\.env\\.${name}\\s*\\|\\|\\s*([^;\\n,]+)`),
    new RegExp(`process\\.env\\.${name}\\s*\\?\\s*[^:\\n]+:\\s*([^;\\n]+)`),
    new RegExp(`process\\.env\\[['"]${name}['"]\\]\\s*\\|\\|\\s*([^;\\n,]+)`),
  ];
  for (const [file, text] of texts) {
    for (let i = 0; i < patterns.length; i++) {
      const re = patterns[i];
      const m = re.exec(text);
      if (!m) continue;
      const value = cleanDefault(m[1]);
      if (!value || /[=!<>]=|\|\||\(/.test(value)) continue;
      const isBudget = i === 5 || /_BUDGET$/.test(name);
      const resolved = resolveIdentifierDefault(value, file, texts, { ms: !isBudget });
      return { value: resolved || value, where: file };
    }
  }
  return null;
}

function renderEnv() {
  const texts = walk('server', (rel) => rel.endsWith('.js'))
    .filter((rel) => rel !== 'scripts/gen-contracts.js')
    .map((rel) => [rel, readRel(rel)]);
  texts.push(
    ...walk('scripts', (rel) => rel.endsWith('.js'))
      .filter((rel) => rel !== 'scripts/gen-contracts.js')
      .map((rel) => [rel, readRel(rel)])
  );

  const names = collectEnvNames(texts);
  const sourceEnv = sourceEnvIndex();
  const credentials = collectCredentials();

  const credByEnv = new Map();
  for (const group of credentials) {
    group.envKeys.forEach((env, i) => {
      credByEnv.set(env, {
        group: group.name,
        file: group.file,
        aliasOf: i === 0 ? null : group.envKeys[0],
      });
    });
  }

  const rows = [];
  for (const [name, meta] of names) {
    const sourceUses = sourceEnv.get(name) || [];
    let defaultText = '—';
    if (sourceUses.length) {
      defaultText = sourceUses.map((u) => `${u.defaultText} (\`${u.id}\`)`).join('; ');
    } else if (credByEnv.has(name)) {
      const cred = credByEnv.get(name);
      defaultText = cred.aliasOf
        ? `alias \`${cred.aliasOf}\`; фоллбек — \`${cred.file}\``
        : `env или файл \`${cred.file}\` (значение не эхоится)`;
    } else {
      const fromCode = defaultFromCode(texts, name);
      defaultText = fromCode ? `\`${fromCode.value}\` (${fromCode.where})` : 'см. файл';
    }
    let owner = `\`${meta.file}:${meta.line}\``;
    if (sourceUses.length) owner = `\`server/core/sources.js\` (${sourceUses.map((u) => u.id).join(', ')})`;
    else if (credByEnv.has(name)) owner = `\`server/config.js\` (${credByEnv.get(name).group})`;
    rows.push([
      `\`${name}\``,
      defaultText,
      owner,
      meta.purpose || meta.snippet || '—',
    ]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));

  const lines = [];
  lines.push('<!-- GENERATED FILE — do not edit by hand. Regenerate: node scripts/gen-contracts.js env -->');
  lines.push('# Environment contract');
  lines.push('');
  lines.push(
    'Все имена переменных окружения, которые читает сервер (P9, план §3.5). ' +
      'Источник — `process.env.*`, поля `*Env` таблицы `server/core/sources.js` ' +
      'и алиасы `server/config.js`.'
  );
  lines.push('');
  lines.push(
    `Имён: **${rows.length}**. Конвенция таблицы источников: ` +
      '`0` = «выключено», пустое/незаданное значение = значение по умолчанию ' +
      '(`server/core/sources.js`). Секреты не эхоятся: в отчётах только имя и источник.'
  );
  lines.push('');
  lines.push('## Секреты и алиасы (`server/config.js`)');
  lines.push('');
  lines.push(
    mdTable(
      ['Секрет', 'Env-имена (первое — основное)', 'Dev-фоллбек'],
      credentials.map((group) => [
        `\`${group.name}\``,
        group.envKeys.map((env) => `\`${env}\``).join(', ') || '—',
        `\`${group.file}\``,
      ])
    )
  );
  lines.push('');
  lines.push('## Все переменные');
  lines.push('');
  lines.push(mdTable(['Имя', 'По умолчанию', 'Где объявлено/используется', 'Назначение'], rows));
  lines.push('');
  lines.push('## Общие env-пары (одно имя — несколько источников)');
  lines.push('');
  const shared = [...sourceEnv.entries()]
    .filter(([, uses]) => uses.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (!shared.length) {
    lines.push('Нет.');
  } else {
    lines.push(
      mdTable(
        ['Env', 'Источники', 'Значение по умолчанию'],
        shared.map(([env, uses]) => [
          `\`${env}\``,
          uses.map((u) => `\`${u.id}\``).join(', '),
          uses.map((u) => u.defaultText).join('; '),
        ])
      )
    );
  }
  lines.push('');
  return lines.join('\n');
}

const STANDARD_FIELDS = new Set([
  'id',
  'host',
  'hosts',
  'breakerKey',
  'pauseMs',
  'pauseMaxMs',
  'pauseEnv',
  'pauseMaxEnv',
  'timeoutMs',
  'timeoutEnv',
  'budgetEnv',
  'budgetDefault',
  'breakerMs',
  'breakerEnv',
  'ttlMs',
  'ttlEnv',
  'userAgent',
  'note',
  'playtimePauseEnv',
  'playtimePauseMs',
]);

function formatExtra(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

const SPECIAL_LIMITS = [
  {
    source: 'hardcover',
    limit: 'сервер: 60 запросов/60 s, burst 10; сутки: 5000',
    origin: 'server/books/hardcover.js:12 (RateLimit-Policy из ответа API)',
    note: 'локальный гейт — `maxPerMinute: 55` в таблице; суточный лимит кодом не проверяется',
  },
  {
    source: 'googlebooks',
    limit: 'free-tier ~1000 запросов/сутки (с ключом), без ключа — per-IP квота',
    origin: 'AGENTS.md §1; server/books/providers/googlebooks.js:13',
    note: 'числа в коде нет; бюджет прогона — `BOOKS_GB_BUDGET` (таблица)',
  },
  {
    source: 'litres',
    limit: '2 запроса на книгу',
    origin: 'AGENTS.md §1; server/books/providers/litres.js:12',
    note: 'бюджет `BOOKS_LITRES_BUDGET` считает книги, не запросы',
  },
  {
    source: 'livelib',
    limit: 'живой скрап-спайк: ≤4 запроса; пагинация — только HTML-страницы',
    origin: 'AGENTS.md §1 (процессное правило, не код)',
    note: 'штатный путь — загрузка файла `livelib-backup`; скрап — аварийный',
  },
  {
    source: 'kinopoisk',
    limit: 'живой скрап — только штатный bootstrapped flow (импорт профиля владельцем)',
    origin: 'AGENTS.md §1 (процессное правило, не код)',
    note: 'для тестов/регрессий live-запросы запрещены',
  },
  {
    source: 'steamCommunity',
    limit: '1 запрос на игру; числовой лимит не документирован',
    origin: 'AGENTS.md §1 (эмпирика 01.11.2026)',
    note: 'пауза 2000 ms и breaker 30 min — в таблице',
  },
  {
    source: 'steam',
    limit: '`GAMES_STEAM_BUDGET` — план, в коде бюджета нет',
    origin: 'AGENTS.md §1',
    note: 'в таблице у `steam` нет `budgetEnv` — это честно отражено',
  },
  {
    source: 'secondary',
    limit: 'негативный кэш: 30 d (реальный 404/empty), 7 d (угаданный slug)',
    origin: 'server/games/secondary/store.js (DEFAULT_NOT_FOUND_TTL_MS / DEFAULT_PROBE_TTL_MS)',
    note: 'отдельные env-ручки: `GAMES_SECONDARY_NOT_FOUND_TTL_MS`, `GAMES_SECONDARY_PROBE_TTL_MS`',
  },
  {
    source: 'books-resolve',
    limit: 'промах «ничего не найдено» помнится 90 дней (`--recheck-days`)',
    origin: 'server/books/scheduled-resolve.js:55 (DEFAULT_RECHECK_DAYS)',
    note: 'бюджет/breaker/сеть не кэшируются',
  },
];

function renderLimits() {
  const sources = require(path.join(APP_ROOT, 'server', 'core', 'sources.js'));
  const { SOURCES, SOURCE_IDS } = sources;
  const ids = [...SOURCE_IDS].sort();

  const rows = ids.map((id) => {
    const entry = SOURCES[id];
    const pause = entry.pauseMaxMs
      ? `${formatMs(entry.pauseMs)}…${formatMs(entry.pauseMaxMs)}`
      : formatMs(entry.pauseMs);
    const budget = entry.budgetEnv
      ? `\`${entry.budgetEnv}\` = ${entry.budgetDefault}`
      : '—';
    const breaker = entry.breakerMs == null ? '—' : formatMs(entry.breakerMs);
    const ttl = entry.ttlMs == null ? '—' : formatMs(entry.ttlMs);
    const envBits = [
      entry.pauseEnv && `pause: \`${entry.pauseEnv}\``,
      entry.timeoutEnv && `timeout: \`${entry.timeoutEnv}\``,
      entry.breakerEnv && `breaker: \`${entry.breakerEnv}\``,
      entry.ttlEnv && `ttl: \`${entry.ttlEnv}\``,
    ].filter(Boolean);
    return [
      `\`${id}\``,
      `\`${entry.host || '—'}\``,
      pause,
      formatMs(entry.timeoutMs),
      budget,
      breaker,
      ttl,
      envBits.length ? envBits.join('<br>') : '—',
    ];
  });

  const extraRows = [];
  for (const id of ids) {
    const entry = SOURCES[id];
    for (const key of Object.keys(entry).sort()) {
      if (STANDARD_FIELDS.has(key)) continue;
      extraRows.push([`\`${id}\``, `\`${key}\``, formatExtra(entry[key])]);
    }
  }

  const lines = [];
  lines.push('<!-- GENERATED FILE — do not edit by hand. Regenerate: node scripts/gen-contracts.js limits -->');
  lines.push('# Politeness limits per source');
  lines.push('');
  lines.push(
    'Единственная нормативная таблица пауз/бюджетов/breaker/TTL. ' +
      'Сгенерирована из `server/core/sources.js` (декларативная таблица `SOURCES`); ' +
      'runtime читает те же значения через `pauseMs`/`timeoutMs`/`budgetLimit`/`breakerMs`/`ttlMs`. ' +
      'Если число в `AGENTS.md` §1 расходится с этой таблицей — правится `core/sources.js`, ' +
      'а не документ и не AGENTS.'
  );
  lines.push('');
  lines.push('## Конвенция');
  lines.push('');
  lines.push(
    '- `0` = «выключено»: pause 0 — без паузы, budget 0 — ноль запросов, TTL 0 — всегда stale, ' +
      'breaker 0 — без кулдауна, timeout 0 — без дедлайна.'
  );
  lines.push('- Незаданная/пустая переменная = значение из таблицы.');
  lines.push(
    '- Известное исключение: `GAMES_FRANCHISE_BUDGET=0` — `franchise.js` применяет ' +
      '`Math.max(1, …)`, то есть всё равно задаёт один вопрос (сохранено намеренно).'
  );
  lines.push(
    '- TTL у игровых источников местами ещё принадлежит runtime-модулю ' +
      '(`game-cache.js`, `secondary-details.js`); таблица зеркалит константы.'
  );
  lines.push('');
  lines.push('## Таблица источников');
  lines.push('');
  lines.push(
    mdTable(
      ['Источник', 'Host', 'Pause', 'Timeout', 'Бюджет/прогон', 'Breaker', 'TTL', 'Env-ручки'],
      rows
    )
  );
  lines.push('');
  lines.push('## Дополнительные ручки из таблицы');
  lines.push('');
  lines.push(
    'Поля `SOURCES`, не входящие в стандартный набор (concurrency, batchSize, ' +
      'maxPerMinute, варианты паузы и т. п.). Это тоже контракт: их читают модули ' +
      'напрямую из таблицы.'
  );
  lines.push('');
  lines.push(mdTable(['Источник', 'Поле', 'Значение'], extraRows));
  lines.push('');
  lines.push('## Особые лимиты, не выводимые из таблицы');
  lines.push('');
  lines.push(
    'Числа, которые живут в коде/эмпирике и не являются полем `SOURCES` ' +
      '(суточные квоты, процессные правила, счётчики запросов на книгу). ' +
      'Источник указан точно; при изменении кода строка правится здесь же.'
  );
  lines.push('');
  lines.push(
    mdTable(
      ['Источник', 'Лимит', 'Происхождение', 'Комментарий'],
      SPECIAL_LIMITS.map((row) => [
        `\`${row.source}\``,
        row.limit,
        row.origin,
        row.note,
      ])
    )
  );
  lines.push('');
  return lines.join('\n');
}

const CACHE_MODULES = [
  'server/cache.js',
  'server/books/book-cache.js',
  'server/books/livelib-cookies.js',
  'server/books/resolve-lock.js',
  'server/games/game-cache.js',
  'server/games/gog-cache.js',
  'server/games/epic-cache.js',
  'server/games/epic-token-store.js',
  'server/games/secondary/store.js',
];

function resolveJoinArgs(argsText, fileRel, resolveRef) {
  const parts = splitTopLevel(argsText);
  if (!parts.length) return null;
  const first = parts[0];
  let base = null;
  if (first === '__dirname') base = fileRel ? path.posix.dirname(fileRel) : '';
  else base = resolveRef ? resolveRef(first) : null;
  if (base == null) return null;
  const segs = [];
  for (const part of parts.slice(1)) {
    const literal = /^'([^']*)'$/.exec(part);
    if (!literal) return null;
    segs.push(literal[1]);
  }
  const joined = path.posix.normalize(path.posix.join(base, ...segs));
  return joined === '.' ? '' : joined;
}

function resolveDirnameJoin(argsText, fileRel = '') {
  return resolveJoinArgs(argsText, fileRel, () => null);
}

function resolveCacheModule(file, parents = {}) {
  const text = readRel(file);
  const map = new Map();
  const envRoots = [];
  const order = [];

  function resolveRef(token) {
    if (!token) return null;
    const parts = String(token).split('.');
    if (parts.length === 2) {
      const parent = parents[parts[0]];
      return parent && parent.has(parts[1]) ? parent.get(parts[1]) : null;
    }
    return map.has(parts[0]) ? map.get(parts[0]) : null;
  }

  for (const m of text.matchAll(
    /const\s+([A-Z][A-Z0-9_]*)\s*=\s*process\.env\.([A-Z0-9_]+)\s*\?\s*path\.resolve\(process\.env\.\2\)\s*:\s*path\.join\(([^;]*?)\);/g
  )) {
    const dir = resolveJoinArgs(m[3], file, resolveRef);
    if (dir == null) continue;
    map.set(m[1], dir);
    envRoots.push({ name: m[1], env: m[2], fallback: dir });
    order.push(m[1]);
  }

  for (const m of text.matchAll(
    /const\s+([A-Z][A-Z0-9_]*)\s*=\s*process\.env\.([A-Z0-9_]+)\s*\?\s*path\.join\(path\.resolve\(process\.env\.\2\),\s*'([^']+)'\)\s*:\s*path\.join\((\w+),\s*'([^']+)'\);/g
  )) {
    const parent = resolveRef(m[4]);
    if (!parent) continue;
    const fallback = path.posix.join(parent, m[5]);
    map.set(m[1], fallback);
    envRoots.push({
      name: m[1],
      env: m[2],
      fallback,
      envLayout: `<${m[2]}>/${m[3]}`,
    });
    order.push(m[1]);
  }

  for (const m of text.matchAll(
    /const\s+([A-Z][A-Z0-9_]*)\s*=\s*(gameCache|bookCache|filmCache)\.([A-Z][A-Z0-9_]*);/g
  )) {
    const parent = resolveRef(`${m[2]}.${m[3]}`);
    if (parent != null) map.set(m[1], parent);
  }

  for (const m of text.matchAll(
    /const\s+([A-Z][A-Z0-9_]*)\s*=\s*path\.join\(([\w.]+),\s*((?:'[^']*'(?:,\s*)?)+)\);/g
  )) {
    if (map.has(m[1])) continue;
    const parent = resolveRef(m[2]);
    if (!parent) continue;
    const segs = [...m[3].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    map.set(m[1], path.posix.join(parent, ...segs));
    order.push(m[1]);
  }

  for (const m of text.matchAll(/path:\s*path\.join\(([\w.]+),\s*([A-Z][A-Z0-9_]*)\)/g)) {
    const parent = resolveRef(m[1]);
    const literal = new RegExp(`const\\s+${m[2]}\\s*=\\s*'([^']+)'`).exec(text);
    if (parent && literal) {
      map.set('LOCK_PATH', path.posix.join(parent, literal[1]));
      order.push('LOCK_PATH');
    }
  }

  const ttls = [];
  for (const m of text.matchAll(/const\s+([A-Z][A-Z0-9_]*_TTL_MS)\s*=\s*([^;]+);/g)) {
    const raw = m[2].trim();
    ttls.push({ name: m[1], raw: squash(raw, 60), value: evaluateMs(raw, map) });
  }

  const paths = [...new Set(order)]
    .map((name) => ({ name, value: map.get(name) }))
    .filter((entry) => entry.value && !entry.value.startsWith('..'));

  return { map, envRoots, paths, ttls };
}

function evaluateMs(raw, map) {
  const substituted = raw
    .replace(/\bDAY_MS\b/g, String(24 * 60 * 60 * 1000))
    .replace(/\bMINUTE_MS\b/g, String(60 * 1000))
    .replace(/\bHOUR_MS\b/g, String(60 * 60 * 1000));
  const identifiers = [...substituted.matchAll(/[A-Z][A-Z0-9_]*/g)].map((m) => m[0]);
  let expression = substituted;
  for (const id of identifiers) {
    if (id === 'DAY_MS' || id === 'MINUTE_MS' || id === 'HOUR_MS') continue;
    const value = map.get(id);
    if (value == null || !/^\d+$/.test(String(value))) return null;
    expression = expression.replace(new RegExp(`\\b${id}\\b`, 'g'), String(value));
  }
  if (!/^[\d\s*+/().-]+$/.test(expression)) return null;
  try {
    const value = Function(`'use strict'; return (${expression});`)();
    return Number.isFinite(value) ? value : null;
  } catch (err) {
    return null;
  }
}

function renderCache() {
  const gameCache = resolveCacheModule('server/games/game-cache.js');
  const bookCache = resolveCacheModule('server/books/book-cache.js');
  const filmCache = resolveCacheModule('server/cache.js');
  const parents = {
    gameCache: gameCache.map,
    bookCache: bookCache.map,
    filmCache: filmCache.map,
  };
  const sections = [];
  for (const file of CACHE_MODULES) {
    if (file === 'server/games/game-cache.js' || file === 'server/books/book-cache.js') continue;
    if (file === 'server/cache.js') continue;
    sections.push({ file, resolved: resolveCacheModule(file, parents) });
  }

  const lines = [];
  lines.push('<!-- GENERATED FILE — do not edit by hand. Regenerate: node scripts/gen-contracts.js cache -->');
  lines.push('# Cache layout');
  lines.push('');
  lines.push(
    'Раскладка кэша и state-каталогов, сгенерированная из path-констант ' +
      '`server/cache.js`, `server/books/book-cache.js`, `server/games/*-cache.js`, ' +
      '`server/games/epic-token-store.js` и `server/games/secondary/store.js` (P9). ' +
      'Корни переопределяются env-переменными (см. `contracts/env.md`).'
  );
  lines.push('');
  lines.push('## Корни');
  lines.push('');
  const roots = [
    ...gameCache.envRoots.map((r) => ({ ...r, file: 'server/games/game-cache.js' })),
    ...bookCache.envRoots.map((r) => ({ ...r, file: 'server/books/book-cache.js' })),
    ...filmCache.envRoots.map((r) => ({ ...r, file: 'server/cache.js' })),
  ];
  for (const section of sections) {
    for (const r of section.resolved.envRoots) roots.push({ ...r, file: section.file });
  }
  lines.push(
    mdTable(
      ['Env', 'Константа', 'По умолчанию (env не задан)', 'Когда env задан', 'Модуль'],
      roots.map((r) => [
        `\`${r.env}\``,
        `\`${r.name}\``,
        `\`app/${r.fallback || ''}\``,
        r.envLayout ? `\`${r.envLayout}\`` : '`$ENV`',
        `\`${r.file}\``,
      ])
    )
  );
  lines.push('');
  lines.push('## Пути по модулям');
  lines.push('');
  const allSections = [
    { file: 'server/cache.js', resolved: filmCache },
    { file: 'server/books/book-cache.js', resolved: bookCache },
    { file: 'server/games/game-cache.js', resolved: gameCache },
    ...sections,
  ];
  for (const { file, resolved } of allSections) {
    lines.push(`### \`${file}\``);
    lines.push('');
    if (!resolved.paths.length) {
      lines.push('Нет собственных path-констант (делегирует в другой модуль).');
    } else {
      lines.push(
        mdTable(
          ['Константа', 'Путь'],
          resolved.paths.map((entry) => [`\`${entry.name}\``, `\`app/${entry.value}\``])
        )
      );
    }
    if (resolved.ttls.length) {
      lines.push('');
      lines.push(
        mdTable(
          ['TTL-константа', 'Выражение', 'Значение'],
          resolved.ttls.map((ttl) => [
            `\`${ttl.name}\``,
            `\`${ttl.raw}\``,
            ttl.value == null ? 'см. модуль' : formatMs(ttl.value),
          ])
        )
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

const RENDERERS = {
  api: { file: 'api.md', render: renderApi },
  env: { file: 'env.md', render: renderEnv },
  limits: { file: 'limits.md', render: renderLimits },
  cache: { file: 'cache.md', render: renderCache },
};

function generate(modes = MODES) {
  const selected = modes.length ? modes : MODES;
  for (const mode of selected) {
    if (!RENDERERS[mode]) throw new Error(`unknown contract mode: ${mode}`);
  }
  return selected
    .map((mode) => ({ file: RENDERERS[mode].file, content: `${RENDERERS[mode].render()}\n` }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function writeContracts({ modes = MODES, outDir = CONTRACTS_DIR } = {}) {
  const docs = generate(modes);
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const doc of docs) {
    const target = path.join(outDir, doc.file);
    fs.writeFileSync(target, doc.content);
    written.push(target);
  }
  return written;
}

function staleContracts({ modes = MODES, outDir = CONTRACTS_DIR } = {}) {
  const stale = [];
  for (const doc of generate(modes)) {
    const target = path.join(outDir, doc.file);
    let current = null;
    try {
      current = fs.readFileSync(target, 'utf8');
    } catch (err) {
      current = null;
    }
    if (current !== doc.content) stale.push(doc.file);
  }
  return stale;
}

function parseArgv(argv) {
  const options = { modes: [], outDir: CONTRACTS_DIR, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--out') {
      options.outDir = path.resolve(argv[++i] || '');
    } else if (arg.startsWith('--out=')) {
      options.outDir = path.resolve(arg.slice('--out='.length));
    } else if (arg === 'all') options.modes = [];
    else if (MODES.includes(arg)) options.modes.push(arg);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main(argv) {
  const options = parseArgv(argv);
  if (options.help) {
    process.stdout.write(
      'usage: node scripts/gen-contracts.js [api|env|limits|cache|all] [--out DIR] [--check]\n'
    );
    return 0;
  }
  const modes = options.modes.length ? options.modes : MODES;
  if (options.check) {
    const stale = staleContracts({ modes, outDir: options.outDir });
    if (stale.length) {
      process.stderr.write(
        `contracts stale: ${stale.join(', ')} — run: node scripts/gen-contracts.js\n`
      );
      return 1;
    }
    process.stdout.write('contracts up to date\n');
    return 0;
  }
  const written = writeContracts({ modes, outDir: options.outDir });
  process.stdout.write(`wrote ${written.length} file(s): ${written.map((f) => path.basename(f)).join(', ')}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[gen-contracts] ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  APP_ROOT,
  CONTRACTS_DIR,
  MODES,
  generate,
  writeContracts,
  staleContracts,
  main,
  collectRoutes,
  resolveCacheModule,
  collectEnvNames,
};
