export function text(value) {
  return value == null ? '' : String(value).trim();
}

export function firstString(...values) {
  for (const value of values) {
    const s = text(value);
    if (s) return s;
  }
  return '';
}

export function arr(value) {
  return Array.isArray(value) ? value : [];
}

export function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function safeStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
  }
}

export function safeStorageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
  }
}

export function setLoadingVisible(id, visible) {
  const node = document.getElementById(id);
  if (node) node.hidden = !visible;
}
