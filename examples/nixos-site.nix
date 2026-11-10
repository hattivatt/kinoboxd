# kinoboxd — site config / usage example (dendritic flake-parts style).
#
# Copy this into `~/.nixos/` next to the installed module. It only *configures*
# the service: the `services.kinoboxd` options themselves live in `nix/module.nix`
# in the upstream repo; both files define the same
# `flake.modules.nixos.kinoboxd` attribute, which flake-parts/import-tree
# merges. Enable the module on a host by adding `kinoboxd` to its imports:
#
#   imports = with inputs.self.modules.nixos; [ ... kinoboxd ];
#
# Secrets are managed with sops-nix, like koinsight/cwa. Add the three keys to
# `secrets/server.yaml` first:
#
#   sops secrets/server.yaml
#   # then add:
#   #   kinoboxd_tmdb_token: <TMDB v4 read access token>
#   #   kinoboxd_password: <password for the web UI/API>
#   #   kinoboxd_hardcover_token: <Hardcover Personal Access Token>
#   #   kinoboxd_gb_api_key: <Google Books API key (AIza…)>
#   #   kinoboxd_steam_api_key: <Steam Web API key (steamcommunity.com/dev/apikey)>
#
{
  flake.modules.nixos.kinoboxd =
    { config, ... }:
    {
      sops.secrets.kinoboxd_tmdb_token = {
        restartUnits = [ "kinoboxd.service" ];
      };

      sops.secrets.kinoboxd_password = {
        restartUnits = [ "kinoboxd.service" ];
      };

      # Hardcover PAT: the book metadata chain degrades quietly without it, so
      # losing this block would silently stop covering new books. Keep it in
      # the repo copy so a deploy never drops it.
      sops.secrets.kinoboxd_hardcover_token = {
        restartUnits = [ "kinoboxd.service" ];
      };

      # Google Books API key. Optional: without it the provider still works
      # anonymously (a much smaller per-IP quota), so a missing secret only
      # lowers the tail throughput. The resolve oneshot reads the same rendered
      # env file, so no per-unit secret is needed.
      sops.secrets.kinoboxd_gb_api_key = {
        restartUnits = [ "kinoboxd.service" ];
      };

      # Steam Web API key. Required for the games library (`GetOwnedGames`):
      # without it the import still returns the profile, achievements and the
      # three most recent games, but the hours/backlog dashboard is
      # `libraryPartial` (§10.4 of ИГРЫ-АРХИТЕКТУРА.md). Keep it in the repo
      # copy so a deploy never drops it. The value never reaches the API or the
      # logs — the UI only shows «настроен / не настроен».
      sops.secrets.kinoboxd_steam_api_key = {
        restartUnits = [ "kinoboxd.service" ];
      };

      # systemd reads EnvironmentFile as root before dropping privileges, so the
      # rendered file does not need to be readable by the kinoboxd user.
      sops.templates."kinoboxd.env" = {
        content = ''
          TMDB_API_TOKEN=${config.sops.placeholder.kinoboxd_tmdb_token}
          HARDCOVER_API_TOKEN=${config.sops.placeholder.kinoboxd_hardcover_token}
          GB_API_KEY=${config.sops.placeholder.kinoboxd_gb_api_key}
          KINOBOXD_PASSWORD=${config.sops.placeholder.kinoboxd_password}
          STEAM_API_KEY=${config.sops.placeholder.kinoboxd_steam_api_key}
        '';
      };

      services.kinoboxd = {
        enable = true;
        port = 3229;
        stateDir = "/var/lib/kinoboxd";
        environmentFile = config.sops.templates."kinoboxd.env".path;
        # package defaults to pkgs.local.kinoboxd (packages/kinoboxd/package.nix
        # through the pkgs-by-name overlay). Without the overlay, use:
        #   package = pkgs.callPackage ../../nix/package.nix { };

        # Book metadata backfill (`sudo systemctl start kinoboxd-backfill-books`).
        # One run touches at most 200 works and asks Литрес for at most 200 of
        # them (the AGENTS.md ceiling), 2 s apart; Hardcover is one batched
        # ISBN lookup per 100 books, Open Library 250 ms per request. Every run
        # is idempotent: works that already have a first-publication year are
        # skipped, and a "nobody knows" verdict is cached for 30 days. Only a
        # real answer becomes a verdict — a run that stops on the budget leaves
        # the rest unchecked, so the next run continues instead of hiding the
        # queue for 30 days.
        #
        # The timer runs the same unit hourly (the first activation happens at
        # deploy); with an empty queue it exits in seconds and makes zero
        # requests. Expect ~K hours for K runs, and the UI says so.
        booksBackfillLimit = 200;
        booksBackfillLitresBudget = 200;
        booksBackfillTimer.enable = true;
        booksBackfillTimer.interval = "hourly";

        # Scheduled metadata resolve for the unlinked tail of LiveLib profiles
        # (`sudo systemctl start kinoboxd-resolve-books`). A profile imported
        # once used to keep its unlinked works forever; this unit walks one
        # slice per run (Cyrillic → Литрес-first, ISBN → batched Hardcover,
        # the rest GB → OL, LiveLib card disabled). A "nothing found" verdict
        # is remembered for 90 days, so an hourly tick is cheap and does not
        # re-ask the same books; a budget/breaker/network skip stays a
        # candidate. The same `cache-book/resolve.lock` serialises it with an
        # import resolve pass, and `Conflicts=` keeps it away from the year
        # backfill (both spend the Литрес budget).
        booksResolveLimit = 200;
        booksResolveLitresBudget = 200;
        # Google Books: the second matcher for the Cyrillic tail (after
        # Литрес) and the first for an ISBN the Hardcover batch did not know.
        # One budget unit per book, 400 ms between requests, 30 min breaker on
        # 403/429; the free tier is ~1000 requests/day, so 300 books/run leaves
        # room for the hourly timer.
        booksResolveGbBudget = 300;
        booksResolveRecheckDays = 90;
        booksResolveTimer.enable = true;
        booksResolveTimer.interval = "hourly";
      };
    };
}
