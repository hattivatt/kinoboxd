{
  description = "kinoboxd — Letterboxd + KinoPoisk statistics backend (Node.js/Express)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Source tree without local/runtime state: the npm cache is built from
      # package-lock.json by buildNpmPackage, the TMDB cache and the token
      # file must never end up in the store.
      src = nixpkgs.lib.cleanSourceWith {
        name = "kinoboxd-source";
        src = ./.;
        filter =
          path: type:
          let
            base = baseNameOf path;
          in
          !(builtins.elem base [
            "node_modules"
            "cache"
            "cache-book"
            "cache-games"
            "config"
            ".git"
            "result"
          ])
          && !(nixpkgs.lib.hasPrefix "result-" base);
      };
    in
    {
      # The build recipe (launchers, writable-stamp preamble, meta) lives in
      # nix/package.nix and is shared with the checked-out deploy flow. The
      # flake only injects the local source tree, so a flake build never
      # depends on the GitHub pin.
      packages = forAllSystems (
        pkgs:
        let
          kinoboxd = pkgs.callPackage ./nix/package.nix { source = src; };
        in
        {
          inherit kinoboxd;
          default = kinoboxd;
        }
      );

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

      checks = forAllSystems (
        pkgs:
        let
          package = self.packages.${pkgs.stdenv.hostPlatform.system}.kinoboxd;
        in
        {
          kinoboxd = pkgs.runCommand "kinoboxd-check" { } ''
            for bin in kinoboxd kinoboxd-backfill kinoboxd-books-backfill kinoboxd-books-resolve; do
              test -x ${package}/bin/$bin
            done
            test -f ${package}/share/kinoboxd/server/index.js
            test -f ${package}/share/kinoboxd/server/auth.js
            test -f ${package}/share/kinoboxd/public/index.html
            test -d ${package}/share/kinoboxd/node_modules/express
            touch $out
          '';
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
