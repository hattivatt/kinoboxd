/* Login gate + logout button.
 *
 * main.js owns view switching; this module owns the password form and the
 * topbar "Выйти" button. When a protected request returns 401 auth_required,
 * api.js dispatches `kinoboxd:auth-required` and main.js shows this view.
 */

import { login, logout } from './api.js';
import { $, clear } from './ui.js';

let onLogin = null;
let onLogout = null;
let bound = false;
let busy = false;

export function initAuth({ onSuccess, onLoggedOut } = {}) {
  onLogin = typeof onSuccess === 'function' ? onSuccess : null;
  onLogout = typeof onLoggedOut === 'function' ? onLoggedOut : null;

  if (bound) return;
  bound = true;

  const form = $('login-form');
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
  }

  const password = $('login-password');
  if (password) {
    password.addEventListener('input', () => {
      if (busy) return;
      setError('');
    });
  }

  for (const id of ['logout-btn', 'books-logout-btn']) {
    const button = $(id);
    if (button) button.addEventListener('click', handleLogout);
  }
}

export function setAuthUi({ authRequired = false } = {}) {
  // Both topbars (films and books) carry a logout button.
  for (const id of ['logout-btn', 'books-logout-btn']) {
    const button = $(id);
    if (button) button.hidden = !authRequired;
  }
}

/** Reset the form before showing the login view. */
export function prepareLogin({ resetInput = false } = {}) {
  setError('');
  setBusy(false);
  const password = $('login-password');
  if (password) {
    if (resetInput) password.value = '';
    window.setTimeout(() => {
      if (document.body.dataset.view === 'login') password.focus();
    }, 30);
  }
}

function setBusy(value) {
  busy = value;
  const button = $('login-submit');
  const label = $('login-submit-label');
  const spinner = $('login-spinner');
  if (button) {
    button.disabled = value;
    button.classList.toggle('is-busy', value);
  }
  if (label) label.textContent = value ? 'Входим…' : 'Войти';
  if (spinner) spinner.hidden = !value;
}

function setError(message) {
  const host = $('login-error');
  if (!host) return;
  if (!message) {
    host.textContent = '';
    host.hidden = true;
    return;
  }
  clear(host);
  host.textContent = message;
  host.hidden = false;
}

async function submit() {
  if (busy) return;
  const password = $('login-password');
  const value = password ? password.value : '';
  if (!value) {
    setError('Введите пароль');
    if (password) password.focus();
    return;
  }

  setError('');
  setBusy(true);
  try {
    await login(value);
    if (password) password.value = '';
    setBusy(false);
    setError('');
    if (onLogin) await onLogin();
  } catch (error) {
    setBusy(false);
    if (error && error.status === 401) {
      setError('Неверный пароль');
    } else if (error && error.code === 'network') {
      setError('Нет связи с сервером. Проверь, что он запущен, и попробуй ещё раз.');
    } else {
      const message = error && typeof error.message === 'string' ? error.message.trim() : '';
      setError(message && message.length < 200 ? message : 'Не удалось войти. Попробуй ещё раз.');
    }
    if (password) {
      password.select();
      password.focus();
    }
  }
}

async function handleLogout() {
  const buttons = ['logout-btn', 'books-logout-btn']
    .map((id) => $(id))
    .filter(Boolean);
  for (const button of buttons) button.disabled = true;
  try {
    await logout();
  } catch {
    // A logout failure still means the cookie is unusable for us; show login.
  } finally {
    for (const button of buttons) button.disabled = false;
  }
  if (onLogout) onLogout();
}
