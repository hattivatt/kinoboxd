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
    rev = "v1.2.0";
    hash = "sha256-YbTdFwIe6BQ0o31wwFKAo+1sXVRQ0HuwSRPvdrY+d4w=";
  },
}:

buildNpmPackage (finalAttrs: {
  pname = "kinoboxd";
  version = "1.2.0";

  src = source;

  npmDeps = fetchNpmDeps {
    inherit (finalAttrs) src;
    hash = "sha256-X6rMqzNU1oXT0h1oc7Ak3dxP6Yb90frXXbiIra52Qag=";
  };

  nodejs = nodejs_24;

  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  postInstall = ''
        mkdir -p $out/share/kinoboxd $out/bin

        cp -r server public package.json $out/share/kinoboxd/
        cp -r node_modules $out/share/kinoboxd/node_modules

        cat > $out/share/kinoboxd/prepare-state.sh <<'PREPARE'
    prepare_state() {
      state="''${KINOBOXD_STATE_DIR:-''${XDG_STATE_HOME:-$HOME/.local/state}/kinoboxd}"
      app="$state/app"
      rev=$(basename "$(dirname "$(dirname "$store")")")
      rev="''${rev%%-*}"
      stamp="$app/server@$rev"

      export KINOBOXD_CACHE_DIR="''${KINOBOXD_CACHE_DIR:-$app/cache}"
      export KINOBOXD_CACHE_BOOK_DIR="''${KINOBOXD_CACHE_BOOK_DIR:-$app/cache-book}"
      export KINOBOXD_CACHE_GAMES_DIR="''${KINOBOXD_CACHE_GAMES_DIR:-$app/cache-games}"
      mkdir -p "$app" "$KINOBOXD_CACHE_DIR" "$KINOBOXD_CACHE_BOOK_DIR" "$KINOBOXD_CACHE_GAMES_DIR"

      if [ ! -f "$stamp/.kinoboxd-stamp" ]; then
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

        chmod -R u+rwX "$stamp/server"
        [ -f "$stamp/package.json" ] || cp "$store/package.json" "$stamp/package.json"
        ln -sfn "$store/public" "$stamp/public"
        ln -sfn "$store/node_modules" "$stamp/node_modules"
        [ -e "$stamp/config" ] || ln -sfn "$app/config" "$stamp/config"
        : > "$stamp/.kinoboxd-stamp"
      fi

      cd "$stamp"
    }
    PREPARE

        cat > $out/bin/kinoboxd <<'WRAPPER'
    #!/bin/sh
    set -eu

    store='@store@'
    . "$store/prepare-state.sh"
    prepare_state

    exec '@node@' server/index.js "$@"
    WRAPPER

        cat > $out/bin/kinoboxd-backfill <<'WRAPPER'
    #!/bin/sh
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

        cat > $out/bin/kinoboxd-books-backfill <<'WRAPPER'
    #!/bin/sh
    set -eu

    store='@store@'
    . "$store/prepare-state.sh"
    prepare_state

    exec '@node@' server/books/years-backfill.js "$@"
    WRAPPER

        cat > $out/bin/kinoboxd-books-resolve <<'WRAPPER'
    #!/bin/sh
    set -eu

    store='@store@'
    . "$store/prepare-state.sh"
    prepare_state

    exec '@node@' server/books/scheduled-resolve.js "$@"
    WRAPPER

        cat > $out/bin/kinoboxd-books-migrate <<'WRAPPER'
    #!/bin/sh
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
