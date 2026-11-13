import { el, clear } from '../ui.js';

export const PROFILE = {
  item: 'profile-item',
  pick: 'profile-pick',
  del: 'profile-del',
  check: 'profile-check',
  badge: 'profile-kind',
  copy: 'profile-copy',
  name: 'profile-name',
  meta: 'profile-meta',
  empty: 'profile-empty',
  add: 'profile-add',
  dot: 'games-profile-dot',
  count: 'games-profile-count',
};

export const SOURCE_CARD = {
  card: 'book-source-card',
  head: 'book-source-head',
  logo: 'book-source-logo',
  copy: 'book-source-copy',
  title: 'book-source-title',
  hint: 'book-source-hint',
  role: 'book-source-role',
  status: 'book-source-status',
  actions: 'books-source-actions',
};

export const JOB = {
  row: 'books-job-row',
  head: 'books-job-head',
  copy: 'books-job-copy',
  title: 'books-job-title',
  account: 'books-job-account',
  stage: 'books-job-stage',
  bar: 'books-job-bar',
  meta: 'books-job-meta',
  fill: 'progress-fill',
  alias: 'shell-job-row',
};

export const SOURCE_ROLE_LABEL = {
  journal: 'журнал',
  enricher: 'обогащение',
  archive: 'архив',
  reference: 'справочник',
};

export const SCREEN_HEADER_CLASS = 'topbar-screen';

export function defineShellDomain(spec = {}) {
  const sources = (Array.isArray(spec.sources) ? spec.sources : [])
    .filter((source) => source && typeof source === 'object' && source.id)
    .map((source) => ({
      id: String(source.id),
      name: source.name || String(source.id),
      mark: source.mark || '',
      logoClass: source.logoClass || '',
      role: source.role || 'journal',
      hint: source.hint || '',
      card: source.card !== false,
      status: source.status || null,
      actions: Array.isArray(source.actions) ? source.actions : [],
    }));
  const journal = spec.journal && typeof spec.journal === 'object'
    ? { mode: 'rows', ...spec.journal }
    : { mode: 'rows' };
  return {
    domain: String(spec.domain || ''),
    title: String(spec.title || ''),
    sources,
    journal,
  };
}

function childrenOf(node) {
  if (!node || !node.children) return [];
  return Array.from(node.children);
}

function findChild(node, test) {
  return childrenOf(node).find((child) => child && test(child)) || null;
}

function hasClass(node, name) {
  return Boolean(node && node.classList && node.classList.contains(name));
}

function findByClass(node, name) {
  return findChild(node, (child) => hasClass(child, name));
}

function findDeep(node, test) {
  if (!node) return null;
  if (test(node)) return node;
  for (const child of childrenOf(node)) {
    const found = findDeep(child, test);
    if (found) return found;
  }
  return null;
}

function findById(node, id) {
  if (!id) return null;
  return findDeep(node, (child) => child.id === id || child.getAttribute && child.getAttribute('id') === id);
}

function setText(node, value) {
  if (node && value != null) node.textContent = String(value);
}

function ensureChild(parent, test, factory) {
  const found = findChild(parent, test);
  if (found) return found;
  const created = factory();
  parent.append(created);
  return created;
}

export function renderProfileBar(spec = {}) {
  const list = spec.list;
  if (!list) return [];
  const items = Array.isArray(spec.items) ? spec.items : [];
  const variant = spec.variant === 'flat' ? 'flat' : 'row';
  const itemClass = spec.itemClass || PROFILE.item;

  clear(list);
  const rows = [];
  if (!items.length) {
    if (spec.emptyText) list.append(el('div', { class: spec.emptyClass || PROFILE.empty, text: spec.emptyText }));
  } else {
    for (const item of items) {
      rows.push(variant === 'flat'
        ? buildFlatChip(item, { ...spec, itemClass })
        : buildProfileRow(item, { ...spec, itemClass }));
    }
    for (const row of rows) list.append(row);
  }
  if (spec.add) spec.add.disabled = Boolean(spec.maxReached);
  return rows;
}

function buildProfileRow(item, spec) {
  const active = Boolean(item.active);
  const row = el('div', {
    class: `${spec.itemClass}${active ? ' is-active' : ''}`,
    role: 'option',
    'aria-selected': active ? 'true' : 'false',
    dataset: { profileId: item.id },
  });
  const pick = el('button', {
    type: 'button',
    class: spec.pickClass || PROFILE.pick,
    title: item.title || item.label || '',
  });
  if (item.badgeHtml) {
    pick.append(el('span', { class: item.badgeClass || PROFILE.badge, html: item.badgeHtml }));
  }
  const copy = el('span', { class: PROFILE.copy });
  copy.append(el('span', { class: PROFILE.name, text: item.label || 'Профиль' }));
  if (item.meta) copy.append(el('span', { class: PROFILE.meta, text: item.meta, title: item.metaTitle || '' }));
  pick.append(copy);
  if (active) pick.append(el('span', { class: PROFILE.check, html: item.checkHtml || '' }));
  pick.addEventListener('click', () => {
    if (typeof spec.onSelect === 'function') spec.onSelect(item.id);
  });
  row.append(pick);

  if (item.deletable !== false && typeof spec.onDelete === 'function') {
    const del = el('button', {
      type: 'button',
      class: spec.delClass || PROFILE.del,
      title: item.deleteTitle || 'Удалить профиль',
      'aria-label': item.deleteLabel || `Удалить профиль ${item.label || ''}`.trim(),
      html: item.deleteHtml || '',
    });
    del.addEventListener('click', (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      spec.onDelete(item.id);
    });
    row.append(del);
  }
  return row;
}

function buildFlatChip(item, spec) {
  const active = Boolean(item.active);
  const chip = el('button', {
    type: 'button',
    class: `${spec.itemClass}${active ? ' is-active' : ''}`,
    'aria-pressed': active ? 'true' : 'false',
    title: item.title || item.label || '',
  });
  chip.append(el('span', { class: item.dotClass || PROFILE.dot, 'aria-hidden': 'true' }));
  chip.append(el('span', { class: item.nameClass || 'games-profile-name', text: item.label || '' }));
  if (item.count != null) {
    chip.append(el('span', { class: item.countClass || PROFILE.count, text: item.count }));
  }
  chip.addEventListener('click', () => {
    if (typeof spec.onSelect === 'function') spec.onSelect(item.id);
  });
  return chip;
}

export function renderSourceCards(spec = {}) {
  const grid = spec.grid;
  if (!grid) return [];
  const sources = Array.isArray(spec.sources) ? spec.sources : [];
  const cards = [];
  for (const source of sources) {
    if (!source || !source.id || source.card === false) continue;
    let card = findChild(grid, (node) => node.dataset && node.dataset.source === source.id);
    if (!card) {
      card = buildSourceCard(source, spec.onAction);
      grid.append(card);
    }
    decorateSourceCard(card, source);
    cards.push(card);
  }
  return cards;
}

function sourceRoleChip(role) {
  const label = SOURCE_ROLE_LABEL[role];
  if (!label) return null;
  return el('span', { class: `${SOURCE_CARD.role} is-${role}`, text: label });
}

function buildSourceCard(source, onAction) {
  const card = el('article', {
    class: `${SOURCE_CARD.card} is-${source.id}`,
    dataset: { source: source.id },
  });
  if (source.cardId) card.setAttribute('id', source.cardId);

  const head = el('div', { class: SOURCE_CARD.head });
  head.append(el('span', {
    class: `${SOURCE_CARD.logo}${source.logoClass ? ` ${source.logoClass}` : ''}`,
    'aria-hidden': 'true',
    text: source.mark || '',
  }));
  const copy = el('span', { class: SOURCE_CARD.copy });
  copy.append(el('span', { class: SOURCE_CARD.title, text: source.name }));
  if (source.hint) copy.append(el('span', { class: SOURCE_CARD.hint, text: source.hint }));
  head.append(copy);
  const role = sourceRoleChip(source.role);
  if (role) head.append(role);
  card.append(head);

  if (source.status) {
    const status = el('p', {
      class: `${SOURCE_CARD.status}${source.status.className ? ` ${source.status.className}` : ''}`,
      text: source.status.text || '',
    });
    if (source.status.id) status.setAttribute('id', source.status.id);
    if (source.status.title) status.title = source.status.title;
    card.append(status);
  }

  const declaredActions = Array.isArray(source.actions) ? source.actions : [];
  if (declaredActions.length) {
    const actions = el('div', { class: SOURCE_CARD.actions });
    for (const action of declaredActions) {
      if (!action || !action.id) continue;
      const button = el('button', {
        type: 'button',
        class: actionButtonClass(action.kind),
        text: action.label || '',
      });
      button.setAttribute('id', action.id);
      button.hidden = Boolean(action.hidden);
      button.addEventListener('click', () => {
        if (typeof onAction === 'function') onAction(source.id, action.id);
      });
      actions.append(button);
    }
    card.append(actions);
  }
  return card;
}

function actionButtonClass(kind) {
  if (kind === 'link') return 'btn btn-link';
  if (kind === 'ghost') return 'btn btn-ghost';
  return 'btn btn-primary books-source-submit';
}

function decorateSourceCard(card, source) {
  const head = findByClass(card, SOURCE_CARD.head);
  if (head && source.role && !findByClass(head, SOURCE_CARD.role)) {
    const role = sourceRoleChip(source.role);
    if (role) head.append(role);
  }
  if (source.hint) {
    const hint = findDeep(card, (node) => hasClass(node, SOURCE_CARD.hint));
    if (hint && !String(hint.textContent || '').trim()) hint.textContent = source.hint;
  }
  if (!source.status) return;
  const status = (source.status.id ? findById(card, source.status.id) : null)
    || findByClass(card, SOURCE_CARD.status);
  if (!status) {
    const node = el('p', {
      class: `${SOURCE_CARD.status}${source.status.className ? ` ${source.status.className}` : ''}`,
      text: source.status.text || '',
    });
    if (source.status.id) node.setAttribute('id', source.status.id);
    if (head && head.parentNode === card) {
      const index = childrenOf(card).indexOf(head);
      card.insertBefore(node, childrenOf(card)[index + 1] || null);
    } else card.append(node);
    return;
  }
  if (source.status.className && !hasClass(status, source.status.className)) {
    status.classList.add(source.status.className);
  }
  if (!String(status.textContent || '').trim() && source.status.text) status.textContent = source.status.text;
  if (source.status.title) status.title = source.status.title;
}

export function mountConnectionsScreen(spec = {}) {
  const screen = spec.screen;
  if (!screen) return null;
  const hero = ensureHero(screen, spec.hero || {});
  const back = ensureBack(screen, spec.back);
  const cards = renderSourceCards({ grid: spec.grid, sources: spec.sources, onAction: spec.onAction });
  return { screen, hero, back, cards };
}

function ensureHero(screen, heroSpec) {
  const dash = findByClass(screen, 'dash');
  const host = dash || screen;
  let hero = findByClass(host, 'dash-hero');
  if (!hero) {
    hero = el('div', { class: 'dash-hero books-import-hero' });
    if (dash) {
      dash.insertBefore(hero, dash.firstChild || null);
    } else {
      const header = findChild(screen, (node) => String(node.tagName || '').toLowerCase() === 'header');
      if (header) {
        const index = childrenOf(screen).indexOf(header);
        screen.insertBefore(hero, childrenOf(screen)[index + 1] || null);
      } else {
        screen.insertBefore(hero, screen.firstChild || null);
      }
    }
  }
  if (heroSpec.kicker) {
    setText(ensureChild(hero, (node) => hasClass(node, 'kicker'), () => el('div', { class: 'kicker dash-kicker' })), heroSpec.kicker);
  }
  if (heroSpec.title) {
    setText(ensureChild(hero, (node) => String(node.tagName || '').toLowerCase() === 'h1', () => el('h1')), heroSpec.title);
  }
  if (heroSpec.sub) {
    setText(ensureChild(hero, (node) => hasClass(node, 'dash-sub'), () => el('p', { class: 'dash-sub' })), heroSpec.sub);
  }
  return hero;
}

function ensureBack(screen, backSpec) {
  if (!backSpec || !backSpec.id) return null;
  const existing = findById(screen, backSpec.id);
  if (existing) return existing;
  const button = el('button', { type: 'button', class: 'btn btn-link', text: backSpec.label || '' });
  button.setAttribute('id', backSpec.id);
  if (typeof backSpec.onBack === 'function') button.addEventListener('click', backSpec.onBack);
  screen.append(button);
  return button;
}

export function renderJobRows(spec = {}) {
  const host = spec.host;
  if (!host) return [];
  const jobs = Array.isArray(spec.jobs) ? spec.jobs : [];
  clear(host);
  const rows = jobs.map(buildJobRow);
  for (const row of rows) host.append(row);
  return rows;
}

function buildJobRow(job = {}) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(job.percent) || 0)));
  const done = Boolean(job.done || job.failed);
  const source = job.source || 'source';
  const row = el('div', {
    class: `${JOB.row} ${JOB.alias} is-${source}${job.failed ? ' is-failed' : ''}`,
  });

  const head = el('div', { class: `${JOB.head} shell-job-head` });
  head.append(el('span', { class: `${SOURCE_CARD.logo} is-${source}`, text: job.mark || '' }));
  const copy = el('div', { class: JOB.copy });
  copy.append(el('div', { class: JOB.title, text: job.title || '' }));
  copy.append(el('div', { class: JOB.account, text: job.account || '' }));
  head.append(copy);
  head.append(el('span', {
    class: `${JOB.stage}${job.failed ? ' is-error' : done ? ' is-done' : ''}`,
    text: job.stage || '',
  }));
  row.append(head);

  const bar = el('div', {
    class: `progress-bar ${JOB.bar}`,
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': String(percent),
  });
  const fill = el('div', { class: JOB.fill });
  fill.style.width = `${percent}%`;
  if (!done && percent === 0) bar.classList.add('is-indeterminate');
  bar.append(fill);
  row.append(bar);

  if (job.meta) row.append(el('div', { class: JOB.meta, text: job.meta }));
  return row;
}
