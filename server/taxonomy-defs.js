'use strict';

/*
 * Fixed data of the film taxonomy: normalized keyword rules, origin/period/
 * director tables and the Wikidata Q-ids they merge.
 *
 * Normalization: lowercase, ё -> е, hyphens/dashes/ampersands become spaces,
 * repeated whitespace collapses. Thus "Neo-Noir", "neo noir" and "NEO NOIR"
 * all become "neo noir", while "musical number" stays a different token and
 * is not picked up by the "musical" rule.
 *
 * The corpus used to pick aliases is the local TMDB cache (2623 films), see
 * the round-2 report for the observed frequencies. Aliases with zero hits are
 * intentionally kept: TMDB may add them later.
 *
 * Editing a rule here is a global change: it applies to every film. A single
 * false positive is removed with `taxonomy-blacklist.js`, not by weakening
 * the rule.
 */

function normalizeKeyword(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/&/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * Person names need a stricter normalization than keywords: TMDB credits use
 * "F. W. Murnau", "F.W. Murnau" and "Friedrich Wilhelm Murnau" for the same
 * director, so punctuation, diacritics and hyphens must all disappear before
 * comparison. "Jean-Luc Godard" and "Jean Luc Godard" become the same token;
 * "Nagisa Ōshima" and "Nagisa Oshima" too. Cyrillic names are kept as-is
 * (lowercased) because TMDB's Russian locale occasionally returns them.
 */
function normalizePersonName(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    // Combining marks left by NFKD: é -> e, ō -> o, ё -> е.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Wikidata Q-ids used by the merged rules                             */
/* ------------------------------------------------------------------ */

const WD = {
  BLACK_AND_WHITE: 'Q838368', // black-and-white film (P462)
  COLOR: 'Q22006653', // color film (P462)
  SILENT_FILM: 'Q226730', // silent film (P136)
  FILM_NOIR: 'Q185867', // film noir (P136)
  NEO_NOIR: 'Q2421031', // neo-noir (P136)
  GIALLO: 'Q1332055', // giallo (P136)
  SPAGHETTI_WESTERN: 'Q212781', // Spaghetti Western (P136)
  SLASHER: 'Q853630', // slasher film (P136)
  ZOMBIE: 'Q3072049', // zombie film (P136)
  CYBERPUNK: 'Q174526', // cyberpunk (P136)
  BODY_HORROR: 'Q3641550', // body horror (P136)
  KAIJU: 'Q1065444', // kaiju (P136)
  MOCKUMENTARY: 'Q459435', // mockumentary (P136)
  NEW_HOLLYWOOD: 'Q377616', // New Hollywood (P135)
  PRECODE_HOLLYWOOD: 'Q3408764', // pre-Code Hollywood (P135)
};

/* Film noir is a period as well as a category; Wikidata tags modern noirs
 * with Q185867 too, so the period rule additionally requires an early year. */
const FILM_NOIR_LAST_YEAR = 1965;

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */

const CATEGORY_DEFS = [
  { key: 'musical', name: 'Мюзикл', aliases: ['musical'] },
  { key: 'film-noir', name: 'Фильм-нуар', aliases: ['film noir'] },
  { key: 'neo-noir', name: 'Нео-нуар', aliases: ['neo noir', 'neonoir'] },
  // Italian genre cycles. The TMDB keyword is the primary signal; Wikidata
  // P136 (Q1332055 / Q212781) is merged on top because TMDB keywords are
  // user-contributed and some classics carry only the Wikidata genre. In the
  // current corpus both signals identify exactly the same films.
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
  /*
   * Horror / sci-fi genre cycles (corpus 2623, Oct 2026). Counts below are
   * keyword / Wikidata / union on the whole cache; LB and KP views are
   * subsets. The TMDB keyword spelling is exact-normalized; "… film" aliases
   * that produced zero hits are still listed where they are the canonical
   * Wikidata/IMDb name.
   *
   * Slasher: 28 / 36 / 42. Wikidata adds 14 keyword-less titles; all are
   * slasher-adjacent or slasher classics (Psycho is already keyword-tagged;
   * the early gialli, American Psycho, Final Destination, Sweeney Todd,
   * Tucker & Dale, Cabin in the Woods). No obvious false positives, so the
   * P136 signal is kept.
   */
  {
    key: 'slasher',
    name: 'Слэшер',
    aliases: ['slasher', 'slasher film'],
    wdGenre: WD.SLASHER,
  },
  /*
   * Zombie: 40 / 33 / 46. Wikidata-only additions are Evil Dead II, Doom,
   * Cargo (all genuine zombie/undead films), the 1972 Tales from the Crypt
   * anthology (undead segment) and two borderline tags: Pirates of the
   * Caribbean: On Stranger Tides (Blackbeard's undead "zombie" crew) and
   * Corpse Bride (skeletons, no zombie outbreak). That is 1 clear outlier out
   * of 6 WD-only films, below the agreed >=3/15 cut-off, so the P136 signal
   * is kept; the two borderline titles are documented here instead of
   * inventing a per-film blacklist.
   */
  {
    key: 'zombie',
    name: 'Зомби',
    aliases: ['zombie', 'zombie film'],
    wdGenre: WD.ZOMBIE,
  },
  /*
   * Cyberpunk: 25 / 28 / 37. The earlier research count of 38 included the
   * "biopunk" keyword, whose only corpus hit is Silent Hill — not cyberpunk;
   * it is deliberately not an alias. Wikidata-only additions are the
   * Terminator cycle, I Robot, Advent Children, Paprika, Tron: Legacy, Cloud
   * Atlas, Hardcore Henry and Ready Player One — all standard/adjacent
   * cyberpunk, no P136 cut.
   */
  {
    key: 'cyberpunk',
    name: 'Киберпанк',
    aliases: ['cyberpunk', 'cyberpunk film'],
    wdGenre: WD.CYBERPUNK,
  },
  /*
   * Body horror: 20 / 1 / 20. Wikidata has a single P136 tag in the corpus
   * (and that film is also keyword-tagged), so the signal is harmless but
   * adds nothing today. Kept for future cache growth.
   */
  {
    key: 'body-horror',
    name: 'Боди-хоррор',
    aliases: ['body horror', 'bodily horror'],
    wdGenre: WD.BODY_HORROR,
  },
  /*
   * Gothic horror: 15 / 0 / 15, keyword-only. Wikidata has "gothic horror
   * film" (Q114413232), but in this corpus it tags 9 films of which only one
   * is keyword-matched: it would add Rosemary's Baby, Night of the Living
   * Dead, Dracula, Sleepy Hollow, Crimson Peak etc. and grow the bucket from
   * 15 to 23. That is wider than the requested "exact gothic horror" scope,
   * so the WD branch is deliberately not wired here. The broad "gothic"
   * keyword (18 hits: Wednesday, Edward Scissorhands, Rebecca…) is likewise
   * not an alias.
   */
  {
    key: 'gothic-horror',
    name: 'Готический хоррор',
    aliases: ['gothic horror', 'gothic horror film'],
  },
  /*
   * Kaiju: 13 / 8 / 14. The WD-only addition is King Kong (1933), the
   * canonical giant-monster precursor — acceptable. "giant monster" is NOT
   * an alias: it would add Ghostbusters, Evolution, The Mist and other
   * creature features (13 -> 19). TMDB keyword "kaiju" itself has one known
   * false positive (Superman, 2025), which cannot be filtered by an exact
   * keyword rule; it is documented rather than special-cased.
   */
  {
    key: 'kaiju',
    name: 'Кайдзю',
    aliases: ['kaiju', 'kaiju film'],
    wdGenre: WD.KAIJU,
  },
  /*
   * Folk horror: 11 / 0 / 11, keyword-only. Q104902646 ("folk horror film")
   * exists but has no P136 uses in the local Wikidata cache, so no WD branch
   * is needed. The keyword covers The Wicker Man, The Witch, Midsommar, Viy,
   * The Blair Witch Project etc.
   */
  {
    key: 'folk-horror',
    name: 'Фолк-хоррор',
    aliases: ['folk horror'],
  },
  /*
   * Mockumentary: 17 / 6 / 18. Keyword "mockumentary" (8) plus the harmless
   * "fake documentary" alias (1 hit, already covered) and — by explicit user
   * decision — "faux documentary" (8) and "pseudo documentary" (6). In this
   * corpus those last two are largely found-footage spellings (Paranormal
   * Activity, Blair Witch, REC, The Visit, Cloverfield, Searching,
   * Gonjiam), so the user accepted the overlap: faux/pseudo documentaries
   * count as mockumentary even though they intersect the found-footage
   * family. Found footage is NOT a separate category and stays outside the
   * taxonomy. Note that Wikidata's Q3272147 is "found footage film", not
   * mockumentary; the correct item is Q459435, whose 6 tags add only
   * District 9 (accepted: the film's first act is explicitly
   * documentary-styled). Known keyword false positive: Gia (1998), tagged
   * "mockumentary" by TMDB users although it is a biopic; it stays because
   * exact-keyword rules have no per-film exclusions.
   */
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
  // Animation is genre-based (TMDB genre 16) and excludes anime films; it has
  // no keyword aliases on purpose. The raw TMDB genre 16 is hidden from the
  // dashboard (see stats.js), so this derived bucket is the only "Мультфильмы"
  // entry. The key stays "animation" so existing sortScope/kicker handling is
  // unaffected; only the display name is localized.
  { key: 'animation', name: 'Мультфильмы', aliases: [], genreBased: true },
  {
    key: 'black-and-white',
    name: 'Чёрно-белые',
    aliases: ['black and white', 'black white', 'b w', 'bw'],
  },
  { key: 'silent', name: 'Немые', aliases: ['silent film', 'silent movie', 'silent'] },
];

/*
 * Origins are mutually exclusive. The first matching definition wins, in the
 * order below (remake > sequel > true story > book > comic > video game >
 * play). Anything left is an original screenplay.
 */
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
  // Pre-Code Hollywood (1929-1934) is absent from TMDB keywords; Wikidata's
  // movement property P135 (Q3408764) covers it. The rule is deliberately
  // Wikidata-only: no keyword aliases are invented.
  {
    key: 'pre-code-hollywood',
    name: 'Pre-Code Голливуд',
    aliases: [],
    wdMovement: WD.PRECODE_HOLLYWOOD,
  },
  // В русскоязычной традиции монтажная школа называется «советский авангард»
  // (Wikidata Q3321104); ключ оставлен прежним ради стабильности данных.
  { key: 'soviet-montage', name: 'Советский авангард', aliases: ['soviet montage'] },
  // Dogme 95 исключён по решению пользователя: это закрытый манифест (~35
  // сертифицированных фильмов), в коллекции таких нет, а эвристика по фон
  // Триеру даёт ложный «Догвилль». Советский авангард оставлен: сейчас 0
  // фильмов, но к нему вернёмся вместе с викиданными по советским периодам.
];

/*
 * Director-based movement heuristics for periods whose TMDB keywords and
 * Wikidata movement tags are too sparse. A film joins the period when ALL of
 * the following hold:
 *
 *   - kind is "movie" (TV series never qualify), and it is not animation;
 *   - the release year is inside the curated window (inclusive);
 *   - at least one production country is in the curated ISO-3166 set;
 *   - one of the credited directors (TMDB crew job === "Director"), after
 *     normalizePersonName(), matches the curated list.
 *
 * The lists are intentionally curated, not exhaustive: only the canonical
 * core of each movement. Names are stored in display form and normalized at
 * module load; spelling variants that differ beyond punctuation/diacritics
 * are listed explicitly (e.g. Murnau's full name, transliterated Ōshima).
 *
 * Deliberate exclusions:
 *   - Steven Spielberg is NOT part of New Hollywood here. He belongs to the
 *     blockbuster era that followed the classical New Hollywood circle, and
 *     adding him would pull in films far outside the curated window.
 *   - Andrei Tarkovsky is NOT part of Soviet montage: his work starts after
 *     the 1924-1936 window and belongs to a different movement.
 */
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
      // Same person under three common credit spellings.
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
      // TMDB occasionally credits him without the middle name.
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
      // Polanski is included: his American period (Rosemary's Baby, Chinatown)
      // is part of the same movement.
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
    // UA is included for Dovzhenko's Ukrainian SSR productions; the 1924-1936
    // window keeps this from matching post-Soviet Ukrainian films.
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

/* Pre-normalized alias sets: one Set per definition for O(1) lookups. */
function aliasSets(defs) {
  return defs.map((def) => ({
    def,
    aliases: new Set((def.aliases || []).map(normalizeKeyword).filter(Boolean)),
  }));
}

const CATEGORY_RULES = aliasSets(CATEGORY_DEFS);
const ORIGIN_RULES = aliasSets(ORIGIN_DEFS);
const PERIOD_RULES = aliasSets(PERIOD_DEFS);

/* Pre-normalized director rules: sets keep the hot path linear in the number
 * of credited directors (usually one) instead of the length of the corpus. */
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
