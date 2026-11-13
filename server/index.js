'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { errorMiddleware } = require('./core/errors');
const auth = require('./auth');
const gzip = require('./gzip');
const booksRouter = require('./books/routes');
const booksManualRouter = require('./books/routes-manual');
const gamesRouter = require('./games/routes');
const gamesGogRouter = require('./games/routes-gog');
const gamesPersonnelRouter = require('./games/personnel/routes-personnel');
const gamesFranchiseRouter = require('./games/routes-franchise');
const gamesEpicRouter = require('./games/routes-epic');
const filmsRouter = require('./films/routes');
const config = require('./config');

if (!config.hasTmdbToken()) {
  console.warn(
    '[server] TMDB-токен не найден: фильмы отдаются только из кэша, импорт и матчинг отвечают 503 tmdb_token_missing'
  );
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');

app.use(gzip());
app.use(express.json({ limit: '1mb' }));

app.use(auth.attachCookies);
app.use('/api/auth', auth.router);
app.use('/api', auth.requireAuth);

app.use('/api/books', booksRouter);
app.use('/api/books', booksManualRouter);

app.use('/api/games', gamesRouter);
app.use('/api/games/gog', gamesGogRouter);
app.use('/api/games', gamesPersonnelRouter);
app.use('/api/games', gamesFranchiseRouter);
app.use('/api/games', gamesEpicRouter);

app.use('/api', filmsRouter);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, tmdb: config.hasTmdbToken() });
});

app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(res, filePath) {
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

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.', code: 'not_found' });
});

app.use(errorMiddleware);

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
  process.exitCode = 1;
});

module.exports = { app, server };
