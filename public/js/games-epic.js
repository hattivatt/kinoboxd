/**
 * Epic secondary library — «Подключения» slot (M6b).
 *
 * This module is intentionally self-contained: it renders ONE Epic slot into
 * `#games-connections` and never touches the Steam dashboard, the profile
 * switcher or the shared connections layout. The integration round (M6c) will
 * render the GOG slot next to it on the same screen; nothing here assumes it
 * is the only source.
 *
 * Flow (device-code, §14.2):
 *   POST /api/games/epic/auth   → { userCode, verificationUriComplete, authId }
 *   GET  /api/games/epic/auth/:authId (polled; backend polls Epic)
 *   POST /api/games/epic/import → job (polled)
 *   GET  /api/games/epic/status?owner=steam-<id64>
 *   POST /api/games/epic/disconnect
 *
 * The device code never reaches the browser; the access/refresh tokens never
 * leave the server. The UI only shows presence/expiry and the library counts.
 */

const PROFILE_KEY = 'kinoboxd.games.profile.v1';
const STATUS_REFRESH_MS = 15000;

const state = {
  mounted: false,
  initialized: false,
  host: null,
  owner: '',
  status: null,
  loading: false,
  error: '',
  auth: null, // { authId, userCode, verificationUri, verificationUriComplete, expiresAt, intervalMs }
  authTimer: null,
  importJobId: null,
  importTimer: null,
  stylesInjected: false,
};

function text(value) {
  return value == null ? '' : String(value).trim();
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function fmtInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString('ru-RU');
}

function fmtHours(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ч`;
}

function fmtDate(value) {
  const ts = Date.parse(String(value || ''));
  if (!Number.isFinite(ts)) return null;
  try {
    return new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

function currentOwner() {
  try {
    return text(window.localStorage.getItem(PROFILE_KEY));
  } catch {
    return '';
  }
}

function injectStyles() {
  if (state.stylesInjected || document.getElementById('epic-conn-styles')) return;
  const style = document.createElement('style');
  style.id = 'epic-conn-styles';
  style.textContent = `
.epic-conn-card{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;
  padding:14px 16px;border:1px solid rgba(255,255,255,.10);border-radius:14px;
  background:rgba(255,255,255,.035);margin:14px 0}
.epic-conn-main{display:flex;gap:12px;align-items:center;min-width:240px;flex:1}
.epic-conn-logo{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;
  border-radius:10px;background:#2a2a2a;color:#fff;font-weight:700;font-size:15px;letter-spacing:.5px}
.epic-conn-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.epic-conn-title{font-weight:600;color:#e8edf2}
.epic-conn-sub{color:#9aa7b4;font-size:13px}
.epic-conn-badge{font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:2px 7px;
  border-radius:999px;border:1px solid rgba(255,255,255,.16);color:#9aa7b4}
.epic-conn-badge.is-ok{color:#8ee6a8;border-color:rgba(142,230,168,.4)}
.epic-conn-badge.is-warn{color:#ffcf7a;border-color:rgba(255,207,122,.4)}
.epic-conn-badge.is-bad{color:#ff9b9b;border-color:rgba(255,155,155,.4)}
.epic-conn-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.epic-conn-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;
  letter-spacing:2px;padding:6px 10px;border-radius:8px;background:rgba(255,255,255,.08);color:#fff}
.epic-conn-link{color:#7cc4ff;text-decoration:none;word-break:break-all}
.epic-conn-link:hover{text-decoration:underline}
.epic-conn-note{color:#9aa7b4;font-size:12px;line-height:1.45;flex-basis:100%}
.epic-conn-error{color:#ff9b9b;font-size:13px;flex-basis:100%}
.epic-conn-progress{color:#9aa7b4;font-size:12px;flex-basis:100%}
`;
  document.head.append(style);
  state.stylesInjected = true;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    ...options,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      (body && (body.error || body.message)) || `Epic API ответил ${response.status}`;
    const error = new Error(message);
    error.code = (body && body.code) || null;
    error.status = response.status;
    throw error;
  }
  return body;
}

function statusLabel(status) {
  switch (status) {
    case 'ok':
      return { text: 'подключено', cls: 'is-ok' };
    case 'stale':
      return { text: 'данные устарели', cls: 'is-warn' };
    case 'auth_expired':
      return { text: 'требуется переподключение', cls: 'is-bad' };
    case 'not_imported':
      return { text: 'библиотека не импортирована', cls: 'is-warn' };
    case 'not_connected':
    default:
      return { text: 'не подключено', cls: '' };
  }
}

function clearAuthTimer() {
  if (state.authTimer) {
    clearInterval(state.authTimer);
    state.authTimer = null;
  }
}

function clearImportTimer() {
  if (state.importTimer) {
    clearInterval(state.importTimer);
    state.importTimer = null;
  }
}

function render() {
  const host = state.host;
  if (!host) return;
  host.hidden = false;
  host.replaceChildren();
  injectStyles();

  const card = el('div', { class: 'epic-conn-card', 'data-source': 'epic' });
  const status = state.status || {};
  const label = statusLabel(status.status);
  const summary = status.summary || {};
  const account = status.account || {};
  const owner = state.owner;

  const main = el('div', { class: 'epic-conn-main' }, [
    el('span', { class: 'epic-conn-logo', text: 'E', 'aria-hidden': 'true' }),
    el('div', { class: 'epic-conn-copy' }, [
      el('span', { class: 'epic-conn-title' }, [
        'Epic Games Store ',
        el('span', { class: `epic-conn-badge ${label.cls}`, text: label.text }),
      ]),
      el(
        'span',
        { class: 'epic-conn-sub' },
        status.status === 'not_connected'
          ? 'вторичная библиотека того же владельца; Steam-журнал не меняется'
          : [
              account.displayName || account.accountId || 'Epic-аккаунт',
              summary.ownedCount != null ? `${fmtInt(summary.ownedCount)} игр` : null,
              summary.hours != null ? fmtHours(summary.hours) : null,
              status.meta && status.meta.fetchedAt ? `данные от ${fmtDate(status.meta.fetchedAt)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')
      ),
    ]),
  ]);

  const actions = el('div', { class: 'epic-conn-actions' });

  if (state.auth) {
    // Device-code pending: code + URL + cancel. The code is not a secret.
    actions.append(
      el('span', { class: 'epic-conn-code', text: state.auth.userCode || '—' }),
      el('a', {
        class: 'epic-conn-link',
        href: state.auth.verificationUriComplete || state.auth.verificationUri || '#',
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'открыть epicgames.com/id/activate',
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        text: 'Отмена',
        onclick: () => cancelAuth(),
      })
    );
  } else if (!owner) {
    actions.append(
      el('span', { class: 'epic-conn-sub', text: 'Сначала импортируйте Steam-профиль' })
    );
  } else if (status.status === 'not_connected' || status.status === 'auth_expired') {
    actions.append(
      el('button', {
        type: 'button',
        class: 'btn btn-primary',
        text: status.status === 'auth_expired' ? 'Переподключить Epic' : 'Войти через Epic',
        onclick: () => startAuth(),
      })
    );
  } else {
    if (status.status === 'not_imported' || status.status === 'stale') {
      actions.append(
        el('button', {
          type: 'button',
          class: 'btn btn-primary',
          text: status.status === 'not_imported' ? 'Импортировать библиотеку' : 'Обновить',
          onclick: () => startImport(),
        })
      );
    } else {
      actions.append(
        el('button', {
          type: 'button',
          class: 'btn btn-ghost',
          text: 'Обновить',
          onclick: () => startImport(),
        })
      );
    }
    actions.append(
      el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        text: 'Отключить',
        onclick: () => disconnect(),
      })
    );
  }

  card.append(main, actions);

  if (state.error) {
    card.append(el('div', { class: 'epic-conn-error', text: state.error }));
  }
  if (state.importJobId) {
    card.append(
      el('div', {
        class: 'epic-conn-progress',
        text: `Импорт Epic: ${state.importStage || 'в очереди'}…`,
      })
    );
  }
  card.append(
    el('div', {
      class: 'epic-conn-note',
      text:
        'Epic-токен хранится на сервере в файле 0600 и даёт доступ к аккаунту Epic ' +
        '(эквивалент пароля). Отключить доступ можно здесь или на epicgames.com → ' +
        'Account → Apps and Accounts. Часы Epic показываются отдельно от Steam.',
    })
  );
  host.append(card);
}

async function refreshStatus() {
  if (!state.host) return;
  state.owner = currentOwner();
  if (!state.owner) {
    state.status = { status: 'not_connected', summary: null, account: null };
    render();
    return;
  }
  state.loading = true;
  try {
    const status = await api(
      `/api/games/epic/status?owner=${encodeURIComponent(state.owner)}`
    );
    state.status = status;
    state.error = '';
  } catch (err) {
    state.error = err.message || 'не удалось получить статус Epic';
  } finally {
    state.loading = false;
    render();
  }
}

async function startAuth() {
  if (!state.owner) return;
  state.error = '';
  render();
  try {
    const session = await api('/api/games/epic/auth', {
      method: 'POST',
      body: JSON.stringify({ owner: state.owner }),
    });
    state.auth = session;
    render();
    clearAuthTimer();
    const interval = Math.max(2000, Number(session.intervalMs) || 3000);
    state.authTimer = setInterval(() => pollAuth(session.authId), interval);
    // Poll once right away so a fast confirmation is not delayed.
    pollAuth(session.authId);
  } catch (err) {
    state.error = err.message || 'не удалось начать вход через Epic';
    render();
  }
}

async function pollAuth(authId) {
  if (!state.auth || state.auth.authId !== authId) return;
  try {
    const session = await api(`/api/games/epic/auth/${encodeURIComponent(authId)}`);
    state.auth = { ...state.auth, ...session };
    if (session.status === 'authorized') {
      clearAuthTimer();
      state.auth = null;
      state.importJobId = session.importJobId || null;
      if (state.importJobId) pollImport(state.importJobId);
      await refreshStatus();
      return;
    }
    if (session.status === 'expired' || session.status === 'failed') {
      clearAuthTimer();
      state.error = session.error || 'Epic не подтвердил вход';
      state.auth = null;
    }
    render();
  } catch (err) {
    // A transient network error must not kill the pending login.
    state.error = err.message || 'не удалось проверить вход через Epic';
    render();
  }
}

async function cancelAuth() {
  const authId = state.auth && state.auth.authId;
  clearAuthTimer();
  state.auth = null;
  if (authId) {
    try {
      await api(`/api/games/epic/auth/${encodeURIComponent(authId)}`, { method: 'DELETE' });
    } catch {
      /* best-effort */
    }
  }
  render();
}

async function startImport() {
  if (!state.owner) return;
  state.error = '';
  try {
    const job = await api('/api/games/epic/import', {
      method: 'POST',
      body: JSON.stringify({ owner: state.owner }),
    });
    state.importJobId = job.jobId || job.id || null;
    state.importStage = job.stage || 'queued';
    render();
    if (state.importJobId) pollImport(state.importJobId);
  } catch (err) {
    state.error = err.message || 'не удалось запустить импорт Epic';
    render();
  }
}

async function pollImport(jobId) {
  clearImportTimer();
  const tick = async () => {
    try {
      const job = await api(`/api/games/epic/import/${encodeURIComponent(jobId)}`);
      state.importStage = job.stage || '';
      if (job.done) {
        clearImportTimer();
        state.importJobId = null;
        if (job.status === 'deferred') {
          state.error = 'Epic временно недоступен — данные остались от прошлого импорта.';
        } else if (job.status === 'failed') {
          state.error = job.error || 'импорт Epic не удался';
        }
        await refreshStatus();
        return;
      }
      render();
    } catch (err) {
      clearImportTimer();
      state.importJobId = null;
      state.error = err.message || 'не удалось получить статус импорта Epic';
      render();
    }
  };
  await tick();
  if (!state.importJobId) return;
  state.importTimer = setInterval(tick, 1500);
}

async function disconnect() {
  if (!state.owner) return;
  const ok = window.confirm(
    'Отключить Epic? Локальный токен будет удалён; снимок библиотеки останется ' +
      '(его можно будет обновить после повторного входа).'
  );
  if (!ok) return;
  state.error = '';
  try {
    await api('/api/games/epic/disconnect', {
      method: 'POST',
      body: JSON.stringify({ owner: state.owner }),
    });
    state.status = { status: 'not_connected', summary: null, account: null };
    await refreshStatus();
  } catch (err) {
    state.error = err.message || 'не удалось отключить Epic';
    render();
  }
}

/** Mount the Epic slot into an explicit host (integration hook for M6c). */
export function mountEpicSlot(host) {
  if (!host) return;
  state.host = host;
  state.mounted = true;
  refreshStatus();
}

/** Entry point: finds `#games-connections` and renders the Epic slot. */
export function initGamesEpic() {
  const host = document.getElementById('games-connections');
  if (!host) return;
  if (state.initialized) {
    refreshStatus();
    return;
  }
  state.initialized = true;
  mountEpicSlot(host);
  document.addEventListener('click', (event) => {
    if (event.target && event.target.closest && event.target.closest('#games-profile-list')) {
      // The switcher writes the new key synchronously; let it settle first.
      setTimeout(() => refreshStatus(), 30);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.auth) refreshStatus();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && !state.auth && !state.importJobId) {
      refreshStatus();
    }
  }, STATUS_REFRESH_MS);
}

// Self-mount: index.html loads this module directly; `initGamesEpic` is
// idempotent enough for the integration round to call it again.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGamesEpic, { once: true });
  } else {
    initGamesEpic();
  }
}

export { refreshStatus };
