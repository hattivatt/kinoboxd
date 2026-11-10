# kinoboxd

Personal media statistics backend across three domains:

* **films** — KinoPoisk profiles plus TMDB enrichment, with an optional
  Letterboxd archive attachment;
* **books** — LiveLib or Hardcover journals with provider resolve
  (Hardcover, Литрес, Google Books, OpenLibrary, LiveLib-card);
* **games** — Steam libraries with GOG/Epic secondary libraries, store
  metadata, Wikidata credits, franchises and vertical art.

One Express process serves all three domains, each with its own on-disk cache
and an optional password gate (`KINOBOXD_PASSWORD`). No database, no bundler,
no frontend framework: Node 24 + CommonJS on the server, plain ES modules and
hand-rolled SVG on the client.

## Documentation

**`../AGENTS.md` (repository root, outside git) is the single document:** the
current architecture, the hard invariants and the rules agents must follow.
Do not add architecture or planning markdown files to this repo.

Machine-readable canon, generated from code (never edit by hand):

| What | File |
|---|---|
| HTTP endpoints, query contract, error codes | `contracts/api.md` |
| Environment variables, aliases, dev fallbacks | `contracts/env.md` |
| Pauses, budgets, breakers, TTLs per source | `contracts/limits.md` |
| Cache/state layout and schemes | `contracts/cache.md` |

`spec/*.md` are short pointers into `../AGENTS.md` plus a code map.

## Run

```bash
npm install
npm start            # http://localhost:3000 (PORT overrides)
TMDB_API_TOKEN=… npm start     # token in env, never in argv or files for prod
```

Dev fallbacks live in `config/{tmdb,hardcover,gbooks,steam,steamgriddb}-token`
(`0600`, gitignored). Production secrets come from sops via the NixOS module.

## Test

```bash
npm test                        # 61 files, 1 372 tests, ~20 s
KINOBOXD_TEST_PORT_BASE=7000 npm test   # a second concurrent run needs its own base
npm run census                  # module/function sizes, helper copies, dead modules
npm run gen:contracts           # regenerate contracts/*.md from code
bash scripts/smoke.sh           # HTTP pass over the three payloads (needs a TMDB token)
```

Tests never touch the production caches: every run points
`KINOBOXD_CACHE_*` and `KINOBOXD_STATE_DIR` into `/tmp`.

## Deploy

`package.nix` (repository root) pins a GitHub revision and builds with
`buildNpmPackage`; `kinoboxd-module.nix` provides the systemd units and timers.
The pin's `rev`/`hash`/`npmDeps.hash` are updated only in that file — see
`../AGENTS.md` §12–13 for the procedure.
