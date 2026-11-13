import { defineShellDomain } from './core/shell.js';

export const FILMS_SHELL = defineShellDomain({
  domain: 'films',
  title: 'Фильмы',
  sources: [{
    id: 'kinopoisk',
    name: 'Кинопоиск',
    mark: 'KP',
    role: 'journal',
    hint: 'журнал оценок и дневник просмотров',
    card: false,
  }, {
    id: 'letterboxd',
    name: 'Letterboxd',
    mark: 'LB',
    role: 'archive',
    hint: 'архив к текущему профилю · даты и пересмотры',
    status: { id: 'films-attach-status', className: 'games-gog-status', text: 'архив не прикреплён' },
  }],
  journal: { mode: 'bar', hostId: 'enrich-progressbar', backId: 'enrich-restart' },
});

export const BOOKS_SHELL = defineShellDomain({
  domain: 'books',
  title: 'Книги',
  sources: [
    {
      id: 'livelib',
      name: 'LiveLib',
      mark: 'LL',
      logoClass: 'is-livelib',
      role: 'journal',
      hint: 'Прочитанные книги, личные оценки и даты',
    },
    {
      id: 'hardcover',
      name: 'Hardcover',
      mark: 'HC',
      logoClass: 'is-hardcover',
      role: 'enricher',
      hint: 'Журнал чтения, оценки, даты, перечитывания',
    },
  ],
  journal: { mode: 'rows', hostId: 'books-progress-jobs', backId: 'books-progress-back' },
});

export const GAMES_SHELL = defineShellDomain({
  domain: 'games',
  title: 'Игры',
  sources: [
    {
      id: 'steam',
      name: 'Steam',
      mark: 'ST',
      logoClass: 'is-steam',
      role: 'journal',
      hint: 'Библиотека, часы, достижения, недавние игры',
    },
    {
      id: 'gog',
      name: 'GOG',
      mark: 'GOG',
      logoClass: 'is-gog',
      role: 'enricher',
      hint: 'вторая библиотека того же владельца · часы отдельно от Steam',
      status: { id: 'games-gog-status', className: 'games-gog-status', text: 'GOG: не подключён' },
      actions: [
        { id: 'games-gog-login', label: 'Войти через GOG', kind: 'primary' },
        { id: 'games-gog-connect', label: 'Подключить', kind: 'primary' },
        { id: 'games-gog-import', label: 'Импортировать библиотеку', kind: 'ghost', hidden: true },
        { id: 'games-gog-logout', label: 'Отключить', kind: 'link', hidden: true },
      ],
    },
    {
      id: 'epic',
      name: 'Epic Games Store',
      mark: 'EP',
      logoClass: 'is-epic',
      role: 'enricher',
      hint: 'вторая библиотека того же владельца · часы отдельно от Steam',
      card: false,
    },
  ],
  journal: { mode: 'rows', hostId: 'games-progress-jobs', backId: 'games-progress-back' },
});

export const SHELL_DESCRIPTORS = { films: FILMS_SHELL, books: BOOKS_SHELL, games: GAMES_SHELL };
