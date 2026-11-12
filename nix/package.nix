# kinoboxd — self-hosted Letterboxd + KinoPoisk statistics backend.
#
# Standalone buildNpmPackage, usable via plain `pkgs.callPackage`, e.g.:
#
#   pkgs.callPackage ./nix/package.nix { }
#
# or, in the dendritic config, dropped into `packages/kinoboxd/package.nix`
# so the pkgs-by-name overlay exposes it as `pkgs.local.kinoboxd` (which is the
# default of `services.kinoboxd.package`).
#
# This is the only build recipe: the repo flake (./flake.nix) imports it with
# `source` set to the local tree, so launchers and meta are not duplicated.
#
# `rev` points at the last release tag's commit, never at HEAD: a commit
# cannot pin its own archive. Release flow (AGENTS.md §12.1, §13.3): bump
# `version` to the new `vX.Y.Z` (`chore(release): X.Y.Z`), tag that commit,
# push it, then move `rev` here (`chore(nix): pin vX.Y.Z`) and re-iterate
# `hash` + `npmDeps.hash` if the tree or package-lock.json changed (set them
# to lib.fakeHash and read the expected value from the build error).
# The `source` argument stays overridable so a local tree can be packaged
# without touching the pin:
#
#   pkgs.callPackage ./nix/package.nix { source = ./.; }
{
  lib,
  fetchFromGitHub,
  fetchNpmDeps,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
  source ? fetchFromGitHub {
    owner = "hattivatt";
    repo = "kinoboxd";
    rev = "2416813408ff9e25df829cb8a2765849fa29dd99";
    hash = "sha256-UWtj0qTf3AcJKNzMck6R1WwTxvBtS9Tntw0L7MWqLJI=";
  },
}:

buildNpmPackage (finalAttrs: {
  pname = "kinoboxd";
  version = "1.0.0";

  src = source;

  npmDeps = fetchNpmDeps {
    inherit (finalAttrs) src;
    hash = "sha256-X6rMqzNU1oXT0h1oc7Ak3dxP6Yb90frXXbiIra52Qag=";
  };

  # Node 24 is what the project's own flake builds with.
  nodejs = nodejs_24;

  # There is no build script; `npm start` just runs node server/index.js.
  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  postInstall = ''
        mkdir -p $out/share/kinoboxd $out/bin

        cp -r server public package.json $out/share/kinoboxd/
        cp -r node_modules $out/share/kinoboxd/node_modules

        # The Nix store is immutable and its files are 0444/0555. Every launch
        # therefore works from a writable *stamp* — a copy of server/ named
        # after the store hash, $KINOBOXD_STATE_DIR/app/server@<hash> — and
        # keeps both caches at canonical, code-independent paths:
        #
        #   $state/app/cache        TMDB / KinoPoisk cache  (KINOBOXD_CACHE_DIR)
        #   $state/app/cache-book   book cache              (KINOBOXD_CACHE_BOOK_DIR)
        #   $state/app/cache-games  games cache             (KINOBOXD_CACHE_GAMES_DIR)
        #
        # A stamp belongs to exactly one code version: it is never reused
        # across versions and never patched in place. The old launcher copied
        # server/ *into* $state/app/server and inherited the store's read-only
        # modes, so the next version failed with
        #   cp: cannot remove '.../app/server/books/book-cache.js': Permission denied
        # The stamp path plus the explicit `chmod u+rwX` below cannot regress
        # into that state. Old stamps (and the obsolete $state/app/server) are
        # inert and can be deleted at any time.
        #
        # The NixOS module always sets KINOBOXD_STATE_DIR, PORT and the
        # credentials explicitly; the defaults here are for ad-hoc runs.
        cat > $out/share/kinoboxd/prepare-state.sh <<'PREPARE'
    # shellcheck shell=sh
    # prepare_state — shared launcher preamble for kinoboxd and
    # kinoboxd-backfill. Requires $store (read-only package tree) to be set.
    #
    # Creates/refreshes the writable stamp for the current store version,
    # exports the canonical cache locations (explicit env values win) and
    # leaves the shell in the stamp directory.
    prepare_state() {
      state="''${KINOBOXD_STATE_DIR:-''${XDG_STATE_HOME:-$HOME/.local/state}/kinoboxd}"
      app="$state/app"
      # $store is <out>/share/kinoboxd; the store hash is the first field of
      # <out>'s name (<hash>-kinoboxd-<version>). One stamp per code version.
      rev=$(basename "$(dirname "$(dirname "$store")")")
      rev="''${rev%%-*}"
      stamp="$app/server@$rev"

      # The caches are canonical: they do not follow the code copy, so a new
      # version reuses the same data without a migration step. All three are
      # still overridable, which is what tests and alternative layouts rely on.
      #
      # cache-games used to fall through to the module default
      # (<stamp>/cache-games): a per-version path, so every rebuild looked like
      # an empty games library and re-ran the whole Steam import/enrich.
      export KINOBOXD_CACHE_DIR="''${KINOBOXD_CACHE_DIR:-$app/cache}"
      export KINOBOXD_CACHE_BOOK_DIR="''${KINOBOXD_CACHE_BOOK_DIR:-$app/cache-book}"
      export KINOBOXD_CACHE_GAMES_DIR="''${KINOBOXD_CACHE_GAMES_DIR:-$app/cache-games}"
      mkdir -p "$app" "$KINOBOXD_CACHE_DIR" "$KINOBOXD_CACHE_BOOK_DIR" "$KINOBOXD_CACHE_GAMES_DIR"

      if [ ! -f "$stamp/.kinoboxd-stamp" ]; then
        # An interrupted copy may hold 0444/0555 entries taken from the store;
        # make them writable so the replace below can actually unlink them.
        chmod -R u+rwX "$stamp" 2>/dev/null || true
        rm -rf "$stamp/server" 2>/dev/null || true

        if ! mkdir -p "$stamp/server" 2>/dev/null; then
          echo "[kinoboxd] cannot create $stamp/server" >&2
          echo "[kinoboxd] hint: rm -rf '$stamp' (the old '$app/server' is unused and can be removed too)" >&2
          exit 1
        fi
        if ! cp -R "$store/server/." "$stamp/server/" 2>/dev/null; then
          echo "[kinoboxd] cannot copy server/ into $stamp/server" >&2
          echo "[kinoboxd] hint: chmod -R u+rwX '$stamp' or rm -rf '$stamp' (the old '$app/server' is unused and can be removed too)" >&2
          exit 1
        fi

        # Keep the stamp writable. This is the fix for the old launcher, which
        # copied the store's read-only modes into $state and then failed to
        # overwrite or remove them on the next run.
        chmod -R u+rwX "$stamp/server"
        [ -f "$stamp/package.json" ] || cp "$store/package.json" "$stamp/package.json"
        ln -sfn "$store/public" "$stamp/public"
        ln -sfn "$store/node_modules" "$stamp/node_modules"
        # config/{tmdb,hardcover,gbooks}-token dev fallback: keep the pre-stamp
        # location ($state/app/config) shared by all versions.
        [ -e "$stamp/config" ] || ln -sfn "$app/config" "$stamp/config"
        : > "$stamp/.kinoboxd-stamp"
      fi

      cd "$stamp"
    }
    PREPARE

        cat > $out/bin/kinoboxd <<'WRAPPER'
    #!/bin/sh
    # kinoboxd — Letterboxd / KinoPoisk statistics backend.
    #   PORT                HTTP port (default 3000)
    #   TMDB_API_TOKEN      TMDB read access token v4 (alias: TMDB_READ_ACCESS_TOKEN)
    #   HARDCOVER_API_TOKEN Hardcover Personal Access Token (alias: HARDCOVER_READ_TOKEN)
    #   GB_API_KEY          Google Books API key (optional; anonymous works too)
    #   KINOBOXD_PASSWORD   optional API password; auth is disabled when unset
    #   KINOBOXD_STATE_DIR  writable runtime dir (default: $XDG_STATE_HOME/kinoboxd)
    #   KINOBOXD_CACHE_DIR  override the film cache (default: $state/app/cache)
    #   KINOBOXD_CACHE_BOOK_DIR  override the book cache (default: $state/app/cache-book)
    #   KINOBOXD_CACHE_GAMES_DIR override the games cache (default: $state/app/cache-games)
    set -eu

    store='@store@'
    . "$store/prepare-state.sh"
    prepare_state

    exec '@node@' server/index.js "$@"
    WRAPPER

        # Second launcher: same writable-state setup as above, but runs the
        # idempotent cache backfill CLI instead of the server. All positional
        # arguments are treated as targets and run sequentially in the given
        # order (`imdb` | `collections` | `keywords` | `wikidata` | `mcu` | `rematch`;
        # an unknown name falls back to keywords inside backfill.js).
        #
        #   KINOBOXD_STATE_DIR  must point at the running service's state dir
        #                       (the NixOS module uses /var/lib/kinoboxd)
        #   TMDB_API_TOKEN      TMDB read access token v4 (alias: TMDB_READ_ACCESS_TOKEN)
        #   BACKFILL_TARGETS    targets used when no arguments are given
        #                       (default: "imdb wikidata")
        #   BACKFILL_CONCURRENCY  parallel TMDB requests (default 8)
        #
        # Ad-hoc use:  KINOBOXD_STATE_DIR=/var/lib/kinoboxd TMDB_API_TOKEN=... \
        #              kinoboxd-backfill              # imdb, then wikidata
        #              kinoboxd-backfill wikidata     # just one target
        #              BACKFILL_TARGETS="keywords" kinoboxd-backfill
        # NixOS:       sudo systemctl start kinoboxd-backfill
        #
        # The backfill writes to the same canonical cache as the server
        # ($state/app/cache), so it works against a running instance and across
        # package upgrades.
        cat > $out/bin/kinoboxd-backfill <<'WRAPPER'
    #!/bin/sh
    # kinoboxd-backfill — fill fields missing from the cached details.
    #
    #   $@                  targets, run in order: imdb (IMDb ids / deep
    #                       links), collections (TMDB franchises),
    #                       keywords or wikidata (WDQS tags;
    #                       resumable), rematch (re-evaluate
    #                       cache/index.json). No arguments means: use
    #                       $BACKFILL_TARGETS, else "imdb wikidata".
    #   BACKFILL_TARGETS    space-separated targets for the no-argument case,
    #                       e.g. BACKFILL_TARGETS="wikidata" or
    #                       BACKFILL_TARGETS="keywords imdb"
    #   TMDB_API_TOKEN      TMDB read access token v4 (alias: TMDB_READ_ACCESS_TOKEN)
    #   KINOBOXD_STATE_DIR  writable runtime dir (default: $XDG_STATE_HOME/kinoboxd)
    #   KINOBOXD_CACHE_DIR  override the film cache (default: $state/app/cache)
    #   BACKFILL_CONCURRENCY  parallel TMDB requests (default 8)
    #
    # Every target is idempotent: entries that already have the data are
    # skipped, so a repeated run only rescans the cache. The loop stops at the
    # first failing target and propagates its exit status.
    set -eu

    store='@store@'
    . "$store/prepare-state.sh"
    prepare_state

    echo "[backfill] state: $PWD (cache: $KINOBOXD_CACHE_DIR)"
    if [ $# -gt 0 ]; then
      targets="$*"
    else
      targets="''${BACKFILL_TARGETS:-imdb wikidata}"
    fi
    for t in $targets; do
      echo "[backfill] target: $t"
      '@node@' server/backfill.js "$t" || exit 1
    done
    WRAPPER

        # Third launcher: the book first-publication-year backfill
        # (server/books/years-backfill.js). The year chart reads only
        # `details.firstPublishedYear`; a cache built before that field existed
        # needs one pass of this job. Budgeted and polite: Литрес pays 2 s and
        # two requests per book (`BOOKS_LITRES_BUDGET`, default 200 books).
        #
        #   --limit N     documents per run (default 20, 0 = no cap)
        #   --ids a,b     only these works (lr:…, ol:…, hc:…)
        #   --dry-run     report without writing
        #   --force       re-ask documents that already carry a year
        #
        # Ad-hoc:  sudo KINOBOXD_STATE_DIR=/var/lib/kinoboxd \
        #            kinoboxd-books-backfill --limit 50
        cat > $out/bin/kinoboxd-books-backfill <<'WRAPPER'
    #!/bin/sh
    # kinoboxd-books-backfill — fill the first-publication year of book works.
    set -eu

    store='@store@'
    . "$store/prepare-state.sh"
    prepare_state

    exec '@node@' server/books/years-backfill.js "$@"
    WRAPPER

        # Fourth launcher: the scheduled metadata resolve for the unlinked
        # tail of LiveLib profiles (server/books/scheduled-resolve.js). It is
        # the body of the `kinoboxd-resolve-books` oneshot/timer; the same
        # `cache-book/resolve.lock` serialises it with an import resolve pass.
        # Литрес is budgeted (`BOOKS_LITRES_BUDGET`, default 200 books/run,
        # 2 requests + 2 s per book); a candidate a provider already answered
        # "nothing" for is skipped for `--recheck-days` (default 90).
        #
        #   --profile livelib-Margaret  one profile (default: all LiveLib)
        #   --limit N                   candidates per run (default 200)
        #   --recheck-days N            negative-cache window (default 90)
        #   --dry-run                   report the pool without network
        #   --force                     ignore the negative cache
        cat > $out/bin/kinoboxd-books-resolve <<'WRAPPER'
    #!/bin/sh
    # kinoboxd-books-resolve — resolve the unlinked tail of LiveLib profiles.
    set -eu

    store='@store@'
    . "$store/prepare-state.sh"
    prepare_state

    exec '@node@' server/books/scheduled-resolve.js "$@"
    WRAPPER

        # Fifth launcher: a dispatcher for the two one-off book migrations
        # (server/books/manga-backfill.js and server/books/authors-backfill.js)
        # that the NixOS module runs as `kinoboxd-backfill-manga` /
        # `kinoboxd-backfill-authors`. The first argument selects the
        # migration, every further argument is forwarded verbatim.
        #
        #   kinoboxd-books-migrate manga [args…]     → manga-backfill.js
        #     --limit N    works per run (default 20, 0 = no cap)
        #     --pause N    ms between provider lookups (default 600)
        #     --ids a,b    only these works (hc:…, lr:…, ol:…)
        #     --dry-run    report the detections without writing
        #     --recheck    re-ask works that are already settled
        #   kinoboxd-books-migrate authors [args…]   → authors-backfill.js
        #     --profile=<key>  one profile (default: every LiveLib profile)
        #     --wikidata       run the WDQS bridge (default: offline report)
        #     --recheck        forget the "already asked" set and re-ask
        #     --limit=N        cap one pass
        #     --dry-run        report the groups without writing
        #
        #   KINOBOXD_STATE_DIR       writable runtime dir (default: $XDG_STATE_HOME/kinoboxd)
        #   KINOBOXD_CACHE_BOOK_DIR  override the book cache (default: $state/app/cache-book)
        #
        # Ad-hoc:  sudo KINOBOXD_STATE_DIR=/var/lib/kinoboxd \
        #            kinoboxd-books-migrate manga --dry-run --limit 10
        #          sudo KINOBOXD_STATE_DIR=/var/lib/kinoboxd \
        #            kinoboxd-books-migrate authors --wikidata
        cat > $out/bin/kinoboxd-books-migrate <<'WRAPPER'
    #!/bin/sh
    # kinoboxd-books-migrate — dispatcher for the manga and author migrations.
    set -eu

    store='@store@'
    . "$store/prepare-state.sh"
    prepare_state

    if [ $# -lt 1 ]; then
      echo "usage: kinoboxd-books-migrate {manga|authors} [args…]" >&2
      exit 2
    fi

    case "$1" in
      manga)
        shift
        exec '@node@' server/books/manga-backfill.js "$@"
        ;;
      authors)
        shift
        exec '@node@' server/books/authors-backfill.js "$@"
        ;;
      *)
        echo "usage: kinoboxd-books-migrate {manga|authors} [args…]" >&2
        exit 2
        ;;
    esac
    WRAPPER

        chmod +x $out/bin/kinoboxd $out/bin/kinoboxd-backfill $out/bin/kinoboxd-books-backfill $out/bin/kinoboxd-books-resolve $out/bin/kinoboxd-books-migrate

        substituteInPlace $out/bin/kinoboxd \
          --replace-fail '@store@' "$out/share/kinoboxd" \
          --replace-fail '@node@' "${nodejs_24}/bin/node"

        substituteInPlace $out/bin/kinoboxd-backfill \
          --replace-fail '@store@' "$out/share/kinoboxd" \
          --replace-fail '@node@' "${nodejs_24}/bin/node"

        substituteInPlace $out/bin/kinoboxd-books-backfill \
          --replace-fail '@store@' "$out/share/kinoboxd" \
          --replace-fail '@node@' "${nodejs_24}/bin/node"

        substituteInPlace $out/bin/kinoboxd-books-resolve \
          --replace-fail '@store@' "$out/share/kinoboxd" \
          --replace-fail '@node@' "${nodejs_24}/bin/node"

        substituteInPlace $out/bin/kinoboxd-books-migrate \
          --replace-fail '@store@' "$out/share/kinoboxd" \
          --replace-fail '@node@' "${nodejs_24}/bin/node"
  '';

  doInstallCheck = false;

  meta = {
    description = "Self-hosted Letterboxd + KinoPoisk statistics backend with TMDB enrichment";
    longDescription = ''
      kinoboxd parses a Letterboxd export and KinoPoisk data, enriches films
      through TMDB and serves an Express API plus a static React-free frontend.
    '';
    homepage = "https://github.com/hattivatt/kinoboxd";
    changelog = "https://github.com/hattivatt/kinoboxd/commits/main";
    mainProgram = "kinoboxd";
    platforms = lib.platforms.linux;
  };
})
