import { text } from './core/dom.js';

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
  authUrl: '',
  code: '',
  busy: false,
  importJobId: null,
  importTimer: null,
  stylesInjected: false,
};

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
.epic-conn-input{min-width:220px;flex:1;padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.16);
  background:rgba(255,255,255,.06);color:#e8edf2;font-size:13px}
.epic-conn-input:focus{outline:none;border-color:rgba(124,196,255,.6)}
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

function clearImportTimer() {
  if (state.importTimer) {
    clearInterval(state.importTimer);
    state.importTimer = null;
  }
}

function render() {
  const host = state.host;
  if (!host) return;
  if (typeof host.replaceChildren !== 'function') return;
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

  if (!owner) {
    actions.append(
      el('span', { class: 'epic-conn-sub', text: 'Сначала импортируйте Steam-профиль' })
    );
  } else if (status.status === 'not_connected' || status.status === 'auth_expired') {
    actions.append(
      el('button', {
        type: 'button',
        class: 'btn btn-primary',
        text: state.authUrl ? 'Открыть вход Epic ещё раз' : 'Войти через Epic',
        disabled: state.busy ? 'disabled' : null,
        onclick: () => openLogin(),
      }),
      el('input', {
        class: 'epic-conn-input',
        id: 'epic-conn-code',
        type: 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'code или ссылка после входа',
        value: state.code || '',
        oninput: (event) => {
          state.code = event && event.target ? String(event.target.value || '') : '';
        },
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        text: state.busy ? 'Подключаем…' : 'Подключить',
        disabled: state.busy || !state.code ? 'disabled' : null,
        onclick: () => connectCode(),
      })
    );
    if (state.authUrl) {
      actions.append(
        el('a', {
          class: 'epic-conn-link',
          href: state.authUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'или открыть страницу входа Epic вручную',
        })
      );
    }
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
        'Epic не отдаёт чужую библиотеку публично, а вход по device-code закрыт для ' +
        'публичных клиентов (Epic отвечает 400 unsupported_grant_type). Поэтому вход ' +
        'по коду: «Войти через Epic» открывает официальную страницу входа, после входа ' +
        'браузер покажет одноразовый code — вставьте его (или всю ссылку) в поле выше. ' +
        'Epic-токен хранится на сервере в файле 0600 и даёт доступ к аккаунту Epic ' +
        '(эквивалент пароля). Отключить доступ можно здесь или на epicgames.com → ' +
        'Account → Apps and Accounts. Часы Epic показываются отдельно от Steam.',
    })
  );
  host.append(card);
}

function notifyEpicChanged() {
  if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
  document.dispatchEvent(new CustomEvent('games:epic-changed'));
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
    if (
      (status.status === 'not_connected' || status.status === 'auth_expired') &&
      !state.authUrl
    ) {
      void loadAuthUrl();
    }
  } catch (err) {
    state.error = err.message || 'не удалось получить статус Epic';
  } finally {
    state.loading = false;
    render();
  }
}

async function loadAuthUrl() {
  if (!state.owner) return;
  try {
    const info = await api('/api/games/epic/auth-url');
    state.authUrl = info.url || '';
  } catch (err) {
    state.error = err.message || 'не удалось получить ссылку входа Epic';
  }
  render();
}

function openLogin() {
  if (!state.authUrl) {
    loadAuthUrl();
    return;
  }
  if (typeof window.open === 'function') {
    window.open(state.authUrl, '_blank', 'noopener,noreferrer');
  }
}

async function connectCode() {
  if (!state.owner || !state.code) return;
  state.error = '';
  state.busy = true;
  render();
  try {
    const result = await api('/api/games/epic/connect', {
      method: 'POST',
      body: JSON.stringify({ code: state.code, owner: state.owner }),
    });
    state.code = '';
    state.importJobId = result.importJobId || null;
    state.importStage = 'в очереди';
    if (result.importError) state.error = result.importError;
    await refreshStatus();
    notifyEpicChanged();
    if (state.importJobId) pollImport(state.importJobId);
  } catch (err) {
    state.error = err.message || 'не удалось подключить Epic';
  } finally {
    state.busy = false;
    render();
  }
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
        if (job.status !== 'failed') notifyEpicChanged();
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
    notifyEpicChanged();
  } catch (err) {
    state.error = err.message || 'не удалось отключить Epic';
    render();
  }
}

export function mountEpicSlot(host) {
  if (!host) return;
  state.host = host;
  state.mounted = true;
  refreshStatus();
}

export function initGamesEpic() {
  const host = document.getElementById('games-connections');
  if (!host) return;
  if (state.initialized) {
    refreshStatus();
    return;
  }
  state.initialized = true;
  mountEpicSlot(host);
  document.addEventListener('games:connections-open', () => {
    if (!state.busy) refreshStatus();
  });
  document.addEventListener('click', (event) => {
    if (event.target && event.target.closest && event.target.closest('#games-profile-list')) {
      setTimeout(() => refreshStatus(), 30);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.busy) refreshStatus();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && !state.busy && !state.importJobId) {
      refreshStatus();
    }
  }, STATUS_REFRESH_MS);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGamesEpic, { once: true });
  } else {
    initGamesEpic();
  }
}

export { refreshStatus };
