'use strict';

function normalizeKeyword(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/&/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePersonName(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const WD = {
  BLACK_AND_WHITE: 'Q838368',
  COLOR: 'Q22006653',
  SILENT_FILM: 'Q226730',
  FILM_NOIR: 'Q185867',
  NEO_NOIR: 'Q2421031',
  GIALLO: 'Q1332055',
  SPAGHETTI_WESTERN: 'Q212781',
  SLASHER: 'Q853630',
  ZOMBIE: 'Q3072049',
  CYBERPUNK: 'Q174526',
  BODY_HORROR: 'Q3641550',
  KAIJU: 'Q1065444',
  MOCKUMENTARY: 'Q459435',
  NEW_HOLLYWOOD: 'Q377616',
  PRECODE_HOLLYWOOD: 'Q3408764',
};

const FILM_NOIR_LAST_YEAR = 1965;

const CATEGORY_DEFS = [
  { key: 'musical', name: 'Мюзикл', aliases: ['musical'] },
  { key: 'film-noir', name: 'Фильм-нуар', aliases: ['film noir'] },
  { key: 'neo-noir', name: 'Нео-нуар', aliases: ['neo noir', 'neonoir'] },
  {
    key: 'giallo',
    name: 'Джалло',
    aliases: ['giallo'],
    wdGenre: WD.GIALLO,
  },
  {
    key: 'spaghetti-western',
    name: 'Спагетти-вестерн',
    aliases: ['spaghetti western', 'italo western'],
    wdGenre: WD.SPAGHETTI_WESTERN,
  },
  {
    key: 'slasher',
    name: 'Слэшер',
    aliases: ['slasher', 'slasher film'],
    wdGenre: WD.SLASHER,
  },
  {
    key: 'zombie',
    name: 'Зомби',
    aliases: ['zombie', 'zombie film'],
    wdGenre: WD.ZOMBIE,
  },
  {
    key: 'cyberpunk',
    name: 'Киберпанк',
    aliases: ['cyberpunk', 'cyberpunk film'],
    wdGenre: WD.CYBERPUNK,
  },
  {
    key: 'body-horror',
    name: 'Боди-хоррор',
    aliases: ['body horror', 'bodily horror'],
    wdGenre: WD.BODY_HORROR,
  },
  {
    key: 'gothic-horror',
    name: 'Готический хоррор',
    aliases: ['gothic horror', 'gothic horror film'],
  },
  {
    key: 'kaiju',
    name: 'Кайдзю',
    aliases: ['kaiju', 'kaiju film'],
    wdGenre: WD.KAIJU,
  },
  {
    key: 'folk-horror',
    name: 'Фолк-хоррор',
    aliases: ['folk horror'],
  },
  {
    key: 'mockumentary',
    name: 'Мокьюментари',
    aliases: ['mockumentary', 'fake documentary', 'faux documentary', 'pseudo documentary'],
    wdGenre: WD.MOCKUMENTARY,
  },
  {
    key: 'arthouse',
    name: 'Артхаус',
    aliases: ['art house', 'art house film', 'arthouse', 'art film'],
  },
  { key: 'anime', name: 'Аниме', aliases: ['anime'] },
  { key: 'animation', name: 'Мультфильмы', aliases: [], genreBased: true },
  {
    key: 'black-and-white',
    name: 'Чёрно-белые',
    aliases: ['black and white', 'black white', 'b w', 'bw'],
  },
  { key: 'silent', name: 'Немые', aliases: ['silent film', 'silent movie', 'silent'] },
];

const ORIGIN_DEFS = [
  {
    key: 'remake',
    name: 'Ремейк',
    aliases: ['remake', 'live action remake', 'horror remake'],
  },
  { key: 'sequel', name: 'Сиквел', aliases: ['sequel'] },
  {
    key: 'true-story',
    name: 'Реальные события',
    aliases: ['based on true story', 'inspired by true events', 'true story'],
  },
  {
    key: 'book',
    name: 'По книге',
    aliases: [
      'based on novel',
      'based on book',
      'based on novella',
      'based on novel or book',
      'based on young adult novel',
      "based on children's book",
      'based on short story',
      'based on memoir or autobiography',
      'based on light novel',
      'based on web novel',
    ],
  },
  {
    key: 'comic',
    name: 'По комиксу',
    aliases: [
      'based on comic',
      'based on comic book',
      'graphic novel',
      'based on graphic novel',
      'based on manga',
      'based on manhwa',
      'based on webcomic or webtoon',
      'based on comic strip',
    ],
  },
  {
    key: 'video-game',
    name: 'По видеоигре',
    aliases: ['based on video game', 'videogame', 'based on game', 'based on visual novel'],
  },
  {
    key: 'play',
    name: 'По пьесе',
    aliases: ['based on play or musical', 'based on play', 'stage play'],
  },
];

const ORIGINAL_DEF = { key: 'original', name: 'Оригинальный сценарий' };

const PERIOD_DEFS = [
  { key: 'film-noir', name: 'Фильм-нуар', aliases: ['film noir'] },
  {
    key: 'german-expressionism',
    name: 'Немецкий экспрессионизм',
    aliases: ['german expressionism'],
  },
  {
    key: 'french-new-wave',
    name: 'Французская новая волна',
    aliases: ['french new wave', 'nouvelle vague'],
  },
  {
    key: 'italian-neorealism',
    name: 'Итальянский неореализм',
    aliases: ['italian neorealism', 'italian neo realism', 'neorealism', 'neo realism'],
  },
  {
    key: 'japanese-new-wave',
    name: 'Японская новая волна',
    aliases: ['japanese new wave', 'nuberu bagu'],
  },
  {
    key: 'new-hollywood',
    name: 'Новый Голливуд',
    aliases: ['new hollywood', 'american new wave'],
  },
  {
    key: 'pre-code-hollywood',
    name: 'Pre-Code Голливуд',
    aliases: [],
    wdMovement: WD.PRECODE_HOLLYWOOD,
  },
  { key: 'soviet-montage', name: 'Советский авангард', aliases: ['soviet montage'] },
];

const DIRECTOR_DEFS = [
  {
    key: 'french-new-wave',
    window: { from: 1958, to: 1973 },
    countries: ['FR'],
    directors: [
      'François Truffaut',
      'Jean-Luc Godard',
      'Claude Chabrol',
      'Éric Rohmer',
      'Jacques Rivette',
      'Alain Resnais',
      'Agnès Varda',
      'Jacques Demy',
      'Louis Malle',
      'Chris Marker',
      'Jacques Rozier',
      'Jean Eustache',
      'Maurice Pialat',
    ],
  },
  {
    key: 'german-expressionism',
    window: { from: 1919, to: 1931 },
    countries: ['DE', 'AT'],
    directors: [
      'Robert Wiene',
      'F. W. Murnau',
      'F.W. Murnau',
      'Friedrich Wilhelm Murnau',
      'Fritz Lang',
      'G. W. Pabst',
      'G.W. Pabst',
      'Georg Wilhelm Pabst',
      'Paul Wegener',
      'Paul Leni',
    ],
  },
  {
    key: 'italian-neorealism',
    window: { from: 1945, to: 1955 },
    countries: ['IT'],
    directors: [
      'Roberto Rossellini',
      'Vittorio De Sica',
      'Luchino Visconti',
      'Giuseppe De Santis',
      'Pietro Germi',
      'Renato Castellani',
      'Alberto Lattuada',
      'Luigi Zampa',
      'Mario Monicelli',
    ],
  },
  {
    key: 'new-hollywood',
    window: { from: 1967, to: 1980 },
    countries: ['US'],
    directors: [
      'Francis Ford Coppola',
      'Francis Coppola',
      'Martin Scorsese',
      'George Lucas',
      'Robert Altman',
      'Hal Ashby',
      'William Friedkin',
      'Peter Bogdanovich',
      'Michael Cimino',
      'Brian De Palma',
      'Brian DePalma',
      'Arthur Penn',
      'Mike Nichols',
      'Roman Polanski',
      'Terrence Malick',
      'Bob Rafelson',
      'Dennis Hopper',
      'Warren Beatty',
      'John Cassavetes',
    ],
  },
  {
    key: 'japanese-new-wave',
    window: { from: 1956, to: 1975 },
    countries: ['JP'],
    directors: [
      'Nagisa Ōshima',
      'Nagisa Oshima',
      'Shōhei Imamura',
      'Shohei Imamura',
      'Masahiro Shinoda',
      'Hiroshi Teshigahara',
      'Yoshishige Yoshida',
      'Seijun Suzuki',
      'Yasuzō Masumura',
      'Yasuzo Masumura',
      'Kōji Wakamatsu',
      'Koji Wakamatsu',
    ],
  },
  {
    key: 'soviet-montage',
    window: { from: 1924, to: 1936 },
    countries: ['SU', 'RU', 'UA'],
    directors: [
      'Sergei Eisenstein',
      'Sergei M. Eisenstein',
      'Sergey Eisenstein',
      'Сергей Эйзенштейн',
      'Vsevolod Pudovkin',
      'Всеволод Пудовкин',
      'Dziga Vertov',
      'Дзига Вертов',
      'Lev Kuleshov',
      'Лев Кулешов',
      'Alexander Dovzhenko',
      'Oleksandr Dovzhenko',
      'Александр Довженко',
      'Олександр Довженко',
      'Grigori Kozintsev',
      'Grigory Kozintsev',
      'Григорий Козинцев',
      'Leonid Trauberg',
      'Леонид Трауберг',
      'Esfir Shub',
      'Esther Shub',
      'Эсфирь Шуб',
    ],
  },
];

function aliasSets(defs) {
  return defs.map((def) => ({
    def,
    aliases: new Set((def.aliases || []).map(normalizeKeyword).filter(Boolean)),
  }));
}

const CATEGORY_RULES = aliasSets(CATEGORY_DEFS);
const ORIGIN_RULES = aliasSets(ORIGIN_DEFS);
const PERIOD_RULES = aliasSets(PERIOD_DEFS);

const DIRECTOR_RULES = DIRECTOR_DEFS.map((def) => ({
  key: def.key,
  window: def.window,
  countries: new Set((def.countries || []).map((code) => String(code).toUpperCase())),
  directors: new Set((def.directors || []).map(normalizePersonName).filter(Boolean)),
}));

module.exports = {
  CATEGORY_DEFS,
  ORIGIN_DEFS,
  ORIGINAL_DEF,
  PERIOD_DEFS,
  DIRECTOR_DEFS,
  CATEGORY_RULES,
  ORIGIN_RULES,
  PERIOD_RULES,
  DIRECTOR_RULES,
  WD,
  FILM_NOIR_LAST_YEAR,
  normalizeKeyword,
  normalizePersonName,
};
