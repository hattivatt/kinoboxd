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

**`AGENTS.md` is the single document:** the current architecture, the hard
invariants and the rules agents must follow. Do not add architecture or
planning markdown files to this repo.

Machine-readable canon, generated from code (never edit by hand):

| What | File |
|---|---|
| HTTP endpoints, query contract, error codes | `contracts/api.md` |
| Environment variables, aliases, dev fallbacks | `contracts/env.md` |
| Pauses, budgets, breakers, TTLs per source | `contracts/limits.md` |
| Cache/state layout and schemes | `contracts/cache.md` |

`spec/*.md` are short pointers into `AGENTS.md` plus a code map.

## Layout

```
server/        Express app, domain routers, core/ transport and cache layer
public/        single-page shell, CSS per domain, hand-rolled SVG charts
test/          node:test suites, fixtures, golden payloads
scripts/       contract generator, census, HTTP smoke
contracts/     generated API/env/limits/cache docs
spec/          short pointers into AGENTS.md
nix/           package.nix (build recipe) and module.nix (NixOS service)
devenv.nix     dev shell (node, git, jq, curl, ripgrep, nixfmt)
flake.nix      flake wrapper around nix/package.nix + devShell + checks
```

## Run

```bash
npm install
npm start            # http://localhost:3000 (PORT overrides)
TMDB_API_TOKEN=… npm start     # token in env, never in argv or files for prod
```

Dev shell (optional, Nix): `devenv shell`, then `kb-start`, `kb-test`,
`kb-check`, `kb-contracts`, `kb-census`, `kb-smoke`, `kb-cache-wipe`.

Dev fallbacks live in `config/{tmdb,hardcover,gbooks,steam,steamgriddb}-token`
(`0600`, gitignored). Production secrets come from sops via the NixOS module.

## Test

```bash
npm test                        # 61 files, 1 373 tests, ~20 s
KINOBOXD_TEST_PORT_BASE=7000 npm test   # a second concurrent run needs its own base
npm run census                  # module/function sizes, helper copies, dead modules
npm run gen:contracts           # regenerate contracts/*.md from code
bash scripts/smoke.sh           # HTTP pass over the three payloads (needs a TMDB token)
```

Tests never touch the production caches: every run points
`KINOBOXD_CACHE_*` and `KINOBOXD_STATE_DIR` into `/tmp`.

## Deploy

`nix/package.nix` builds the package with `buildNpmPackage` and pins a GitHub
revision of this repo; `nix/module.nix` provides the systemd units and timers.
The pin's `rev`/`hash`/`npmDeps.hash` are updated only in that file — see
`AGENTS.md` §12–13 for the procedure. The pinned `rev` always points at the
last pushed commit, because a commit cannot pin its own archive; the flake
build (`nix build .#`) uses the local tree and ignores the pin.
