'use strict';

/**
 * Minimal headless DOM for frontend smoke tests.
 *
 * `public/js/*` modules are written against a real browser; the dashboard
 * widgets only need `document.getElementById`, `createElement(NS)`, classList,
 * listeners and a tiny localStorage. This shim provides exactly that (the same
 * pattern the games UI rounds used in `/tmp` smoke scripts) so a test can
 * import a real tab module, drive its import flow and read the rendered nodes.
 *
 * It is not a browser: `querySelector`/`querySelectorAll` return null/[] and
 * layout is fixed at 900 px. Modules are expected to tolerate missing nodes
 * (they do — every widget guards its host).
 */

class ClassList {
  constructor() { this.set = new Set(); }
  add(...names) { for (const name of names) this.set.add(name); }
  remove(...names) { for (const name of names) this.set.delete(name); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
  get value() { return [...this.set].join(' '); }
}

class FakeNode {
  constructor(tag, nodeType = 1) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = nodeType;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.classList = new ClassList();
    this.hidden = false;
    this.value = '';
    this.checked = true;
    this.disabled = false;
    this.title = '';
    this.textContent = '';
    this._html = '';
    this.clientWidth = 900;
    this.offsetParent = {};
    this.files = null;
  }
  get className() { return this.classList.value; }
  set className(value) { this.classList.set = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = String(value); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  append(...kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      const node = kid && kid.nodeType ? kid : new FakeNode('#text', 3);
      if (!(kid && kid.nodeType)) node.textContent = String(kid);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(kid) { this.append(kid); return kid; }
  insertBefore(next, ref) {
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index < 0) { this.append(next); return next; }
    next.parentNode = this;
    this.children.splice(index, 0, next);
    return next;
  }
  removeChild(kid) {
    const index = this.children.indexOf(kid);
    if (index >= 0) this.children.splice(index, 1);
    kid.parentNode = null;
    return kid;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(next) {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) {
      this.parentNode.children[index] = next;
      next.parentNode = this.parentNode;
    }
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] == null ? null : this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((item) => item !== fn));
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) {
      fn({ target: this, preventDefault() {}, ...event });
    }
  }
  click() { this.dispatch('click'); }
  focus() {}
  select() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains && child.contains(node));
  }
  closest() { return null; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
}

/** Install globals and return handles. Call once per test file, before imports. */
function installDom({ search = '', href = 'http://localhost/' } = {}) {
  const byId = new Map();
  const nodeFor = (id) => {
    if (!byId.has(id)) byId.set(id, new FakeNode('div'));
    return byId.get(id);
  };

  const document = {
    activeElement: null,
    body: new FakeNode('body'),
    documentElement: new FakeNode('html'),
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
    createTextNode: (text) => {
      const node = new FakeNode('#text', 3);
      node.textContent = String(text);
      return node;
    },
    getElementById: (id) => nodeFor(id),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const storage = new Map();
  const window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    location: { href, search, pathname: '/', hash: '' },
    history: { pushState() {}, replaceState() {}, state: null },
    innerWidth: 1280,
    innerHeight: 900,
    scrollY: 0,
    scrollTo() {},
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.ResizeObserver = undefined;
  globalThis.CustomEvent = class {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  };

  return { byId, nodeFor, storage, document, window };
}

/** Whitespace-normalised text of a fake subtree. */
function textOf(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent;
  return (node.textContent || '') + node.children.map(textOf).join(' ');
}

/** Flattened text of the node registered under `id`. */
function textById(nodeFor, id) {
  return textOf(nodeFor(id)).replace(/\s+/g, ' ').trim();
}

module.exports = { installDom, textOf, textById, FakeNode };
