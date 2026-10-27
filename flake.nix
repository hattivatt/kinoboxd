{
  description = "kinoboxd — Letterboxd + KinoPoisk statistics backend (Node.js/Express)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Source tree without local/runtime state: the npm cache is built from
      # package-lock.json by buildNpmPackage, the TMDB cache and the token
      # file must never end up in the store.
      src = nixpkgs.lib.cleanSourceWith {
        name = "kinoboxd-source";
        src = ./.;
        filter = path: type:
          let base = baseNameOf path;
          in !(builtins.elem base [
            "node_modules"
            "cache"
            "cache-book"
            "config"
            ".git"
            "result"
          ]) && !(nixpkgs.lib.hasPrefix "result-" base);
      };
    in
    {
      packages = forAllSystems (pkgs:
        let
          nodejs = pkgs.nodejs_24;
          kinoboxd = pkgs.buildNpmPackage {
            pname = "kinoboxd";
            version = "1.0.0";

            inherit src;

            npmDepsHash = "sha256-ARouZ8hT/EbihEMKiwzwo/PpFF9iOuGEMsveFlzphbQ=";

            nativeBuildInputs = [ pkgs.makeWrapper ];

            # No build step in package.json ("start" only), so npm run build
            # is a no-op anyway; state it explicitly.
            dontNpmBuild = true;

            postInstall = ''
              mkdir -p $out/share/kinoboxd $out/bin

              cp -r server public package.json $out/share/kinoboxd/
              cp -r node_modules $out/share/kinoboxd/node_modules

              # The Nix store is immutable and its files are 0444/0555, so the
              # launcher runs a writable copy of server/ from
              # $KINOBOXD_STATE_DIR/app/server@<store-hash> (a "stamp"). Stamps
              # are per code version and never patched in place: the previous
              # scheme copied into $state/app/server, inherited the read-only
              # modes and then failed on the next version with
              #   cp: cannot remove '.../books/book-cache.js': Permission denied
              # The caches live at canonical paths and do not follow the copy:
              #   $state/app/cache       (KINOBOXD_CACHE_DIR)
              #   $state/app/cache-book  (KINOBOXD_CACHE_BOOK_DIR)
              # Old stamps are inert and can be deleted at any time.
              cat > $out/share/kinoboxd/prepare-state.sh <<'PREPARE'
# shellcheck shell=sh
# prepare_state — shared launcher preamble. Requires $store (read-only
# package tree) to be set. Creates/refreshes the writable stamp for the
# current store version, exports the canonical cache locations (explicit env
# values win) and leaves the shell in the stamp directory.
prepare_state() {
  state="''${KINOBOXD_STATE_DIR:-''${XDG_STATE_HOME:-$HOME/.local/state}/kinoboxd}"
  app="$state/app"
  # $store is <out>/share/kinoboxd; the store hash is the first field of
  # <out>'s name (<hash>-kinoboxd-<version>). One stamp per code version.
  rev=$(basename "$(dirname "$(dirname "$store")")")
  rev="''${rev%%-*}"
  stamp="$app/server@$rev"

  # The caches are canonical: they do not follow the code copy, so a new
  # version reuses the same data without a migration step. Both are still
  # overridable, which is what tests and alternative layouts rely on.
  export KINOBOXD_CACHE_DIR="''${KINOBOXD_CACHE_DIR:-$app/cache}"
  export KINOBOXD_CACHE_BOOK_DIR="''${KINOBOXD_CACHE_BOOK_DIR:-$app/cache-book}"
  mkdir -p "$app" "$KINOBOXD_CACHE_DIR" "$KINOBOXD_CACHE_BOOK_DIR"

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
    # config/{tmdb,hardcover}-token dev fallback: keep the pre-stamp location
    # ($state/app/config) shared by all versions.
    [ -e "$stamp/config" ] || ln -sfn "$app/config" "$stamp/config"
    : > "$stamp/.kinoboxd-stamp"
  fi

  cd "$stamp"
}
PREPARE

              cat > $out/bin/kinoboxd <<'WRAPPER'
#!/bin/sh
# kinoboxd — Letterboxd / KinoPoisk statistics backend.
#   PORT              HTTP port (default 3000)
#   TMDB_API_TOKEN    TMDB read access token v4 (alias: TMDB_READ_ACCESS_TOKEN)
#   HARDCOVER_API_TOKEN Hardcover PAT (alias: HARDCOVER_READ_TOKEN)
#   KINOBOXD_PASSWORD optional API password; auth is disabled when unset
#   KINOBOXD_STATE_DIR  writable runtime dir (default: $XDG_STATE_HOME/kinoboxd)
#   KINOBOXD_CACHE_DIR  override the film cache (default: $state/app/cache)
#   KINOBOXD_CACHE_BOOK_DIR  override the book cache (default: $state/app/cache-book)
set -eu

store='@store@'
. "$store/prepare-state.sh"
prepare_state

exec '@node@' server/index.js "$@"
WRAPPER

              chmod +x $out/bin/kinoboxd

              substituteInPlace $out/bin/kinoboxd \
                --replace-fail '@store@' "$out/share/kinoboxd" \
                --replace-fail '@node@' "${nodejs}/bin/node"
            '';

            meta = with pkgs.lib; {
              description = "Letterboxd statistics backend with TMDB enrichment";
              homepage = "https://github.com/hattivatt/kinoboxd";
              mainProgram = "kinoboxd";
              platforms = platforms.unix;
            };
          };
        in
        {
          inherit kinoboxd;
          default = kinoboxd;
        });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.kinoboxd}/bin/kinoboxd";
          meta.description = "Run the kinoboxd backend";
        };
        kinoboxd = self.apps.${pkgs.stdenv.hostPlatform.system}.default;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            git
            jq
          ];
          shellHook = ''
            echo "kinoboxd dev shell — node $(node --version), npm $(npm --version)"
            echo "  npm install && PORT=3000 TMDB_API_TOKEN=... npm start"
          '';
        };
      });

      checks = forAllSystems (pkgs: {
        kinoboxd = pkgs.runCommand "kinoboxd-check" { } ''
          test -x ${self.packages.${pkgs.stdenv.hostPlatform.system}.kinoboxd}/bin/kinoboxd
          test -f ${self.packages.${pkgs.stdenv.hostPlatform.system}.kinoboxd}/share/kinoboxd/public/index.html
          test -f ${self.packages.${pkgs.stdenv.hostPlatform.system}.kinoboxd}/share/kinoboxd/server/index.js
          test -f ${self.packages.${pkgs.stdenv.hostPlatform.system}.kinoboxd}/share/kinoboxd/server/auth.js
          test -d ${self.packages.${pkgs.stdenv.hostPlatform.system}.kinoboxd}/share/kinoboxd/node_modules/express
          touch $out
        '';
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
