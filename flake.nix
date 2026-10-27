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

              # The Nix store is read-only, while the server keeps its TMDB
              # cache next to server/ (cache/). The launcher therefore runs a
              # copy of server/ from a writable per-user state directory and
              # symlinks the immutable bits back into the store.
              cat > $out/bin/kinoboxd <<'WRAPPER'
#!/bin/sh
# kinoboxd — Letterboxd / KinoPoisk statistics backend.
#   PORT              HTTP port (default 3000)
#   TMDB_API_TOKEN    TMDB read access token v4 (alias: TMDB_READ_ACCESS_TOKEN)
#   KINOBOXD_PASSWORD optional API password; auth is disabled when unset
#   KINOBOXD_STATE_DIR  writable runtime dir (default: $XDG_STATE_HOME/kinoboxd)
set -eu

store='@store@'
state="''${KINOBOXD_STATE_DIR:-''${XDG_STATE_HOME:-$HOME/.local/state}/kinoboxd}"
app="$state/app"

mkdir -p "$app/server" "$app/cache"
cp -rf "$store/server/." "$app/server/"
[ -f "$app/package.json" ] || cp "$store/package.json" "$app/package.json"
ln -sfn "$store/public" "$app/public"
ln -sfn "$store/node_modules" "$app/node_modules"

cd "$app"
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
