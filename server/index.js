'use strict';

/**
 * Application bootstrap (P7). Domain routes live in their own routers:
 * `books/routes.js`, `games/routes*.js`, `films/routes.js`. This file only
 * assembles the chain (gzip → JSON body → auth gate → routers → static →
 * SPA fallback → 404/error), listens and prints the LAN addresses. Mount order
 * is part of the contract: `/api/auth/*` precedes the password gate.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { errorMiddleware } = require('./core/errors');
const auth = require('./auth');
const compression = require('compression');
const gzipGames = require('./gzip');
const booksRouter = require('./books/routes');
const gamesRouter = require('./games/routes');
const gamesGogRouter = require('./games/routes-gog');
const gamesPersonnelRouter = require('./games/personnel/routes-personnel');
const gamesFranchiseRouter = require('./games/routes-franchise');
const gamesEpicRouter = require('./games/routes-epic');
const filmsRouter = require('./films/routes');
const config = require('./config');

// Fail fast, before the HTTP server starts, if TMDB credentials are missing.
// Missing config is an expected condition: print one clean line and exit 1
// without a stack trace.
try {
  config.loadTmdbToken();
} catch (err) {
  if (err && err.code === 'TMDB_TOKEN_MISSING') {
    console.error(`[server] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');

// /api/stats is several megabytes of JSON; gzip cuts it by ~85% and is the
// single biggest transfer win. Also compresses static JS/CSS.
//
// `/api/games/*` goes through our own zlib middleware (server/gzip.js): the
// games payload is ~290 KB of JSON (the gamesIndex is ~90% of it) and an
// explicit layer keeps the ratio measurable and testable. The filter below
// keeps `compression()` away from that prefix so a response is never
// compressed twice.
app.use(
  compression({
    filter: gzipGames.skipPrefix('/api/games', compression.filter),
  })
);
app.use(express.json({ limit: '1mb' }));

// Password protection (KINOBOXD_PASSWORD). Without it the API stays open.
// /api/auth/* is always reachable; everything else under /api is gated.
app.use(auth.attachCookies);
app.use('/api/auth', auth.router);
app.use('/api', auth.requireAuth);

// Books (cache-book/) and games (cache-games/) come first, exactly as before.
app.use('/api/books', booksRouter);

app.use('/api/games', gzipGames());
app.use('/api/games', gamesRouter);
// GOG (M6a): /api/games/gog/* — connect, status, import, logout.
app.use('/api/games/gog', gamesGogRouter);
// Personnel (M3): GET /api/games/personnel + POST /api/games/override.
app.use('/api/games', gamesPersonnelRouter);
// Franchises (M4-B): GET /api/games/franchises + POST /api/games/franchise-enrich.
app.use('/api/games', gamesFranchiseRouter);
// Epic secondary library (M6b): /api/games/epic/*.
app.use('/api/games', gamesEpicRouter);

// Films (P7): the 12 API endpoints that used to be inline here.
app.use('/api', filmsRouter);

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

/* Static frontend + SPA fallback. */
app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(res, filePath) {
      // The HTML spec's current JS type (mime-types still says application/javascript).
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.js' || ext === '.mjs') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      }
    },
  })
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  return res
    .status(404)
    .json({ error: 'Frontend not built yet (app/public/index.html is missing).' });
});

/* Errors. */

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.', code: 'not_found' });
});

app.use(errorMiddleware);

// Non-internal IPv4 addresses, so the startup log shows the LAN URLs.
function getLanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      const isIpv4 = info.family === 'IPv4' || info.family === 4;
      if (isIpv4 && !info.internal) {
        result.push({ name, address: info.address });
      }
    }
  }
  return result;
}

const server = app.listen(PORT, () => {
  const lanAddresses = getLanAddresses();
  console.log(`[server] Слушаю на http://localhost:${PORT} (локально) и в локальной сети:`);
  if (lanAddresses.length === 0) {
    console.log('[server]   → IPv4-адреса не найдены (нет активных сетевых интерфейсов)');
  } else {
    for (const { name, address } of lanAddresses) {
      console.log(`[server]   → http://${address}:${PORT}  (${name})`);
    }
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `Порт ${PORT} занят. Возможно, сервер уже запущен на http://localhost:${PORT}, ` +
        `либо запусти с другим портом: PORT=${PORT + 1} npm start`
    );
  } else {
    console.error('[server] Failed to start:', err);
  }
  // Nothing is listening: the loop drains and Node exits with this code.
  process.exitCode = 1;
});

module.exports = { app, server };
