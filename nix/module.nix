# kinoboxd — native NixOS service module (dendritic flake-parts style).
#
# The module is inputs-free and only takes `{ config, lib, pkgs, ... }`, so it
# can be imported either through the flake-parts `import-tree` (as
# `flake.modules.nixos.kinoboxd`) or directly as a plain NixOS module:
#
#   imports = [ (import ./nix/module.nix).flake.modules.nixos.kinoboxd ];
#
# Defaults mirror the sibling KoInsight module: loopback-friendly port, no
# firewall opening by default (Caddy/nginx is the public entry point), a
# dedicated system user and state under /var/lib. The app itself listens on
# all interfaces; restrict access with the firewall or a reverse proxy.
{
  flake.modules.nixos.kinoboxd =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.services.kinoboxd;

      # Absolute path -> use as-is (tmpfiles rule); bare name -> /var/lib/<name>
      # (systemd StateDirectory). Mirrors the KoInsight/CWA modules.
      stateDir =
        if lib.hasPrefix "/" (toString cfg.stateDir) then
          toString cfg.stateDir
        else
          "/var/lib/${cfg.stateDir}";

      serviceEnv = {
        NODE_ENV = "production";
        PORT = toString cfg.port;
        KINOBOXD_STATE_DIR = stateDir;
        # The launcher copies server/ into $stateDir/app and keeps the TMDB
        # cache in $stateDir/app/cache; HOME just makes any stray Node write
        # land inside the same writable tree.
        HOME = stateDir;
        # The server reads the same slice size the books-backfill unit uses,
        # so `summary.yearBackfill.runsLeft` («осталось ~K прогонов») is an
        # honest estimate instead of a guess.
        BOOKS_BACKFILL_LIMIT = toString cfg.booksBackfillLimit;
      }
      // cfg.extraEnvironment;

      hardening = {
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        PrivateTmp = true;
        PrivateDevices = true;
        PrivateIPC = true;
        ProtectHostname = true;
        ProtectClock = true;
        ProtectKernelTunables = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        LockPersonality = true;
        RestrictSUIDSGID = true;
        ProtectHome = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
        RestrictNamespaces = true;
        RemoveIPC = true;
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        ProtectKernelModules = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
          "AF_NETLINK"
        ];
        # NOTE: MemoryDenyWriteExecute is deliberately omitted — V8's JIT needs
        # writable-then-executable memory, which that setting forbids.
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
          "~@resources"
        ];
      };

      stateDirectory = lib.optionalAttrs (!(lib.hasPrefix "/" (toString cfg.stateDir))) {
        StateDirectory = cfg.stateDir;
        StateDirectoryMode = "0750";
      };

      # Backfill targets, mirroring the names accepted by
      # `kinoboxd-backfill` / server/backfill.js. This list is the single
      # source for the `backfillTargets` enum and for the generated per-target
      # oneshot units (`kinoboxd-backfill-<target>`).
      allTargets = [
        "imdb"
        "keywords"
        "wikidata"
        "rematch"
        "collections"
        "mcu"
      ];

      aggregateBackfillUnit = "kinoboxd-backfill";
      backfillUnit = target: "kinoboxd-backfill-${target}";

      # Book metadata backfill (first-publication years). A separate unit with
      # its own cache (cache-book) and its own budget; it is not a target of the
      # film launcher, so it lives outside `allTargets`.
      booksBackfillUnit = "kinoboxd-backfill-books";

      # Scheduled metadata resolve for the unlinked tail of LiveLib profiles.
      # A separate oneshot/timer with the same `cache-book/resolve.lock` as an
      # import resolve pass; it is mutually exclusive with every backfill unit
      # (all of them spend the Литрес budget and write the same cache files).
      booksResolveUnit = "kinoboxd-resolve-books";

      # Author-bridge and manga detectors are one-off migrations
      # (`npm run backfill:authors`, `npm run backfill:manga`), not units:
      # they rewrite cache-book once after a schema decision and are not
      # idempotent enough to run on a timer. Run them by hand in the app tree.

      # All backfill units (aggregate + one per target + the books ones). Used
      # to build the mutual-exclusion `Conflicts=` lists.
      allBackfillUnits =
        [ aggregateBackfillUnit booksBackfillUnit booksResolveUnit ] ++ map backfillUnit allTargets;

      # Every backfill unit conflicts with all the other backfill units, so
      # starting one stops a parallel one instead of letting two scans race on
      # the same cache files. systemd does not restart the stopped unit, and
      # the main kinoboxd.service is deliberately not in this set: the cache
      # writes are atomic, so serving while a backfill runs is safe.
      conflictsFor =
        unit: map (other: "${other}.service") (lib.filter (other: other != unit) allBackfillUnits);

      # Identity, environment file and writable state path shared by the
      # server and every oneshot. Callers add Type/ExecStart/restart policy.
      serviceCommon = {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = stateDir;
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        ReadWritePaths = lib.optional (lib.hasPrefix "/" (toString cfg.stateDir)) stateDir;
      }
      // stateDirectory;
    in
    {
      options.services.kinoboxd = {
        enable = lib.mkEnableOption "kinoboxd, a Letterboxd/KinoPoisk statistics backend with TMDB enrichment";

        package = lib.mkPackageOption pkgs [ "local" "kinoboxd" ] { };

        port = lib.mkOption {
          type = lib.types.port;
          default = 3229;
          description = ''
            TCP port the web interface listens on (passed to the app as
            {env}`PORT`). KoInsight uses 3228; 3229 keeps the two adjacent and
            conflict-free. When a reverse proxy serves kinoboxd, this is the
            proxy's upstream port.
          '';
        };

        openFirewall = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Open {option}`port` in the firewall.";
        };

        stateDir = lib.mkOption {
          # `types.str` (as in the KoInsight/CWA modules) keeps absolute paths
          # working and also allows the `/var/lib/<name>` shorthand below.
          type = lib.types.str;
          default = "/var/lib/kinoboxd";
          description = ''
            Directory holding the runtime state: the writable copy of
            {file}`server/`, the TMDB cache ({file}`index.json`,
            {file}`details/`, {file}`kp/`) and the upload scratch space. Either
            an absolute path or a directory name below {file}`/var/lib`.
          '';
        };

        environmentFile = lib.mkOption {
          type = lib.types.nullOr lib.types.path;
          default = null;
          example = "/run/secrets/kinoboxd.env";
          description = ''
            Optional {env}`EnvironmentFile` for secrets such as
            {env}`TMDB_API_TOKEN`, {env}`HARDCOVER_API_TOKEN`,
            {env}`GB_API_KEY`, {env}`STEAM_API_KEY` and
            {env}`KINOBOXD_PASSWORD`. Prefer a
            `sops.templates` file over a plain-text file, e.g.
            `config.sops.templates."kinoboxd.env".path`.

            Note that systemd gives {env}`EnvironmentFile` precedence over
            {option}`extraEnvironment`, so a `PORT=` line in this file would
            override {option}`port`; normally leave `PORT` to the module.
          '';
        };

        extraEnvironment = lib.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = { };
          description = ''
            Extra non-secret environment variables for the service. For
            secrets use {option}`environmentFile`, e.g.
            `TMDB_API_TOKEN = "\${config.sops.placeholder.kinoboxd_tmdb_token}";`
            (but a rendered env file is less likely to leak into the store).
          '';
        };

        backfillTargets = lib.mkOption {
          type = lib.types.listOf (lib.types.enum allTargets);
          default = [
            "imdb"
            "wikidata"
          ];
          example = [ "wikidata" ];
          description = ''
            Backfill targets the aggregate
            {command}`kinoboxd-backfill.service` oneshot runs, in order:

            - `imdb` — add {code}`details.imdb_id` for deep links;
            - `collections` — add TMDB franchise collections;
            - `keywords` — refresh the TMDB keyword lists;
            - `wikidata` — add WDQS tags (genres, colours, movements, based-on);
            - `rematch` — re-run the TMDB matcher over {file}`cache/index.json`
              (automatic ids and misses only; manual `{ id, kind }` matches are
              never modified);
            - `mcu` — mark Marvel Cinematic Universe membership (collection
              name cleanup + a per-film flag).

            Every target is idempotent and skips entries that are already
            complete, so re-running the unit is only a cache scan.

            Next to this aggregate unit the module always defines one oneshot
            per target: `kinoboxd-backfill-imdb.service`,
            `kinoboxd-backfill-keywords.service`,
            `kinoboxd-backfill-wikidata.service`,
            `kinoboxd-backfill-rematch.service` and
            `kinoboxd-backfill-collections.service`. They are not enabled by
            default and are the recommended way to run a single target:

            ```shell
            sudo systemctl start kinoboxd-backfill-rematch
            journalctl -u kinoboxd-backfill-rematch -f
            ```

            Start the aggregate with `sudo systemctl start
            kinoboxd-backfill`. All backfill units conflict with each other:
            starting one stops a run that is already in progress, and the
            stopped run is *not* restarted later — start it again if needed.
            The main {command}`kinoboxd.service` keeps running throughout; the
            cache writes are atomic.

            An empty list starts the aggregate wrapper without arguments,
            which then falls back to its own default (`imdb wikidata`).
          '';
        };

        backfillTimer = {
          enable = lib.mkEnableOption ''
            a systemd timer that runs the aggregate
            {command}`kinoboxd-backfill.service` on a schedule. Off by
            default; the per-target units stay manual either way
          '';

          interval = lib.mkOption {
            type = lib.types.str;
            default = "daily";
            example = "weekly";
            description = ''
              `OnCalendar=` expression for
              {option}`services.kinoboxd.backfillTimer`. Any systemd calendar
              spec works, e.g. `daily`, `weekly` or `*-*-* 04:30:00`.
            '';
          };
        };

        booksBackfillLitresBudget = lib.mkOption {
          type = lib.types.ints.positive;
          default = 200;
          example = 40;
          description = ''
            Литрес budget for one
            {command}`kinoboxd-backfill-books` run (books per run; the provider
            costs two requests and a 2 s pause per book). The unit exports it as
            {env}`BOOKS_LITRES_BUDGET`, and the script's own breaker stops at the
            first 403/429 for 30 minutes. Lower it for a first exploratory run,
            raise it only if you accept the load on litres.ru.
          '';
        };

        booksBackfillLimit = lib.mkOption {
          type = lib.types.ints.unsigned;
          default = 200;
          example = 50;
          description = ''
            How many works one {command}`kinoboxd-backfill-books` run may touch
            (`0` = every cached work without a first-publication year). The
            default 200 matches the Литрес budget: one hourly run walks one
            slice, the journal prints how many are left (`pending`, `runsLeft`)
            and the UI shows the same estimate. Keep the slice in the same
            order of magnitude as {option}`booksBackfillLitresBudget`; a much
            larger slice only spends more time on Open Library without giving
            more Литрес answers. `0` (unlimited) makes a single run walk the
            whole cache — fine for a one-off, wrong for a timer.
          '';
        };

        booksBackfillTimer = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = ''
              Run {command}`kinoboxd-backfill-books.service` on a schedule.
              On by default: the first-publication-year backfill is a *queue*
              (one run fills at most {option}`booksBackfillLimit` works, and
              `BOOKS_LITRES_BUDGET` bounds the Литрес part), so a single manual
              run cannot finish a large library. While the queue is empty the
              unit scans the cache and exits in seconds without a single
              network request, so an hourly tick is cheap.

              The same timer is the reason the UI can say «бэкфилл идёт,
              осталось ~K прогонов» instead of presenting «Год неизвестен» as
              a final verdict.
            '';
          };

          interval = lib.mkOption {
            type = lib.types.str;
            default = "hourly";
            example = "*-*-* 03:30:00";
            description = ''
              `OnCalendar=` expression for
              {option}`services.kinoboxd.booksBackfillTimer`. `hourly` (the
              default) drains a few hundred works per run; use `daily` for a
              quieter schedule or `weekly` for a very large library.
            '';
          };
        };

        booksBackfillPauseMs = lib.mkOption {
          type = lib.types.ints.positive;
          default = 2000;
          description = ''
            Pause in milliseconds between two Литрес requests of the books
            backfill. The politeness floor from `AGENTS.md` is 2000 ms; do not
            lower it unless you own the provider.
          '';
        };

        booksResolveLitresBudget = lib.mkOption {
          type = lib.types.ints.positive;
          default = 200;
          example = 40;
          description = ''
            Литрес budget for one {command}`kinoboxd-resolve-books` run (books
            per run; the provider costs two requests and a 2 s pause per book).
            The unit exports it as {env}`BOOKS_LITRES_BUDGET`. A run stops at the
            first 403/429 for 30 minutes (provider breaker), so a first
            exploratory run can use a smaller value.
          '';
        };

        booksResolveGbBudget = lib.mkOption {
          type = lib.types.ints.positive;
          default = 300;
          example = 100;
          description = ''
            Google Books budget for one
            {command}`kinoboxd-resolve-books` run (books per run, one budget
            unit per book whatever the number of HTTP requests inside it). The
            unit exports it as {env}`BOOKS_GB_BUDGET`. Google Books is the
            second matcher for a Cyrillic tail (after Литрес) and the first for
            an ISBN-bearing row that Hardcover does not know; the free tier is
            ~1000 requests/day per key, and the provider pauses 400 ms between
            requests and stops at the first 403/429 for 30 minutes. A run that
            exhausts this budget leaves the rest of the tail pending, never
            "hopeless".
          '';
        };

        booksResolveLimit = lib.mkOption {
          type = lib.types.ints.unsigned;
          default = 200;
          example = 50;
          description = ''
            How many unlinked candidates one
            {command}`kinoboxd-resolve-books` run may walk (`0` = the whole
            active pool). The default matches {option}`booksResolveLitresBudget`:
            one hourly run drains one Литрес slice, and the journal prints
            `remaining` / `runsLeft`. Keep it in the same order of magnitude as
            the budget; a larger slice mostly spends time on Open Library and
            Google Books.
          '';
        };

        booksResolveRecheckDays = lib.mkOption {
          type = lib.types.ints.unsigned;
          default = 90;
          example = 30;
          description = ''
            Days a "providers answered nothing" verdict stays final for the
            scheduled resolve. Inside the window the candidate is skipped
            without a single request; `--force` (or a manual run) re-asks it.
            A budget/breaker/network skip is never written as a verdict, so it
            stays a candidate on the next run.
          '';
        };

        booksResolvePauseMs = lib.mkOption {
          type = lib.types.ints.positive;
          default = 2000;
          description = ''
            Pause in milliseconds between two Литрес requests of the scheduled
            resolve. The politeness floor from `AGENTS.md` is 2000 ms.
          '';
        };

        booksResolveTimer = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = ''
              Run {command}`kinoboxd-resolve-books.service` on a schedule. On by
              default: the unlinked tail of a LiveLib profile is a queue that a
              single import cannot drain (Литрес budget + slice size), and the
              metadata badge would otherwise sit below 100% forever. An empty
              pool (or a pool entirely inside the re-check window) exits in
              milliseconds with zero requests, so an hourly tick is cheap.
            '';
          };

          interval = lib.mkOption {
            type = lib.types.str;
            default = "hourly";
            example = "*-*-* 04:30:00";
            description = ''
              `OnCalendar=` expression for
              {option}`services.kinoboxd.booksResolveTimer`.
            '';
          };
        };

        user = lib.mkOption {
          type = lib.types.str;
          default = "kinoboxd";
          description = "User account under which kinoboxd runs.";
        };

        group = lib.mkOption {
          type = lib.types.str;
          default = "kinoboxd";
          description = "Group account under which kinoboxd runs.";
        };
      };

      config = lib.mkIf cfg.enable {
        systemd.tmpfiles.settings."10-kinoboxd" =
          lib.optionalAttrs (lib.hasPrefix "/" (toString cfg.stateDir))
            {
              ${stateDir}.d = {
                inherit (cfg) user group;
                mode = "0750";
              };
            };

        systemd.services = {
          kinoboxd = {
            description = "kinoboxd — Letterboxd/KinoPoisk statistics backend";
            documentation = [ "https://github.com/hattivatt/kinoboxd" ];
            after = [ "network.target" ];
            wantedBy = [ "multi-user.target" ];

            environment = serviceEnv;

            serviceConfig =
              hardening
              // serviceCommon
              // {
                Type = "simple";

                ExecStart = "${cfg.package}/bin/kinoboxd";
                Restart = "on-failure";
                RestartSec = "5s";
              };
          };

          # Manual one-shot cache migration: fills fields that older cache
          # normalizers dropped (notably `details.imdb_id`) and adds the
          # Wikidata tags. It is idempotent and skips entries that are already
          # complete, so re-running it is harmless (just a cache scan) — but
          # nothing triggers it automatically unless
          # `services.kinoboxd.backfillTimer.enable` is set.
          #
          #   sudo systemctl start kinoboxd-backfill
          #   journalctl -u kinoboxd-backfill -f
          #
          # `services.kinoboxd.backfillTargets` selects the targets and their
          # order (default: imdb, then wikidata); the wrapper logs a
          # `[backfill] target: <name>` line before each one.
          #
          # It is intentionally not wantedBy any target: start it explicitly.
          # Running it while kinoboxd.service is up is safe — each details file
          # is written via write-to-tmp + atomic rename, so the server sees
          # either the old or the new entry, never a partial one. Stop the main
          # service first only if you want to avoid any interleaving at all
          # (e.g. while doing a large batch migration).
          #
          # Next to this aggregate unit every target gets its own oneshot
          # (kinoboxd-backfill-<target>.service, generated below). All
          # backfill units conflict with each other, so only one scan runs at
          # a time; the stopped unit is not restarted automatically.
          kinoboxd-backfill = {
            description = "kinoboxd — TMDB/Wikidata cache backfill (oneshot)";
            documentation = [ "https://github.com/hattivatt/kinoboxd" ];
            after = [ "network.target" ];
            wantedBy = [ ];
            conflicts = conflictsFor aggregateBackfillUnit;

            environment = serviceEnv;

            serviceConfig =
              hardening
              // serviceCommon
              // {
                Type = "oneshot";

                # Targets come from services.kinoboxd.backfillTargets, in
                # order; the wrapper defaults to "imdb wikidata" when no
                # argument is given.
                ExecStart = lib.concatStringsSep " " (
                  [ "${cfg.package}/bin/kinoboxd-backfill" ] ++ cfg.backfillTargets
                );
              };
          };
        }
        // lib.listToAttrs (
          map (
            target:
            lib.nameValuePair (backfillUnit target) {
              description = "kinoboxd — TMDB/Wikidata cache backfill: ${target}";
              documentation = [ "https://github.com/hattivatt/kinoboxd" ];
              after = [ "network.target" ];
              wantedBy = [ ];
              conflicts = conflictsFor (backfillUnit target);

              environment = serviceEnv;

              serviceConfig =
                hardening
                // serviceCommon
                // {
                  Type = "oneshot";
                  ExecStart = "${cfg.package}/bin/kinoboxd-backfill ${target}";
                };
            }
          ) allTargets
        )
        // {
          # Book metadata backfill: the first-publication year of every work
          # whose cached details document predates `firstPublishedYear`
          # (round ef593a8), plus the negative cache that keeps a re-run from
          # re-asking providers about books nobody knows a year for.
          #
          #   sudo systemctl start kinoboxd-backfill-books
          #   journalctl -u kinoboxd-backfill-books -f
          #
          # Idempotent: a document that has the year is skipped, a document that
          # was asked and answered nothing is skipped for 30 days, so a repeated
          # start is a cache scan plus whatever is still missing. Budgeted and
          # polite (Литрес: two requests and `booksBackfillPauseMs` per book,
          # `booksBackfillLitresBudget` books per run; Open Library 250 ms;
          # Hardcover through the shared gate). The script writes the cache
          # through the same atomic save as the server, so `kinoboxd.service`
          # keeps serving while it runs.
          #
          # The launcher is `kinoboxd-books-backfill` from package.nix; it shares
          # `prepare-state.sh` with the other two launchers, so PATH, the state
          # dir and the canonical caches are the same as the server's.
          kinoboxd-backfill-books = {
            description = "kinoboxd — book first-publication-year backfill (oneshot)";
            documentation = [ "https://github.com/hattivatt/kinoboxd" ];
            after = [ "network-online.target" ];
            wants = [ "network-online.target" ];
            wantedBy = [ ];
            conflicts = conflictsFor booksBackfillUnit;

            environment = serviceEnv // {
              BOOKS_LITRES_BUDGET = toString cfg.booksBackfillLitresBudget;
            };

            # The launcher resolves node itself; the package on PATH is for the
            # wrapper's own shell tools (`basename`, `cp`) and for operators who
            # run `kinoboxd-books-backfill` inside `systemctl shell`.
            path = [ cfg.package ];

            serviceConfig =
              hardening
              // serviceCommon
              // {
                Type = "oneshot";

                ExecStart = lib.concatStringsSep " " [
                  "${cfg.package}/bin/kinoboxd-books-backfill"
                  "--limit"
                  (toString cfg.booksBackfillLimit)
                  "--pause"
                  (toString cfg.booksBackfillPauseMs)
                ];
              };
          };

          # Scheduled metadata resolve for the unlinked tail of LiveLib
          # profiles (round 29.10.2026). A profile imported once kept 455 works
          # without a link/details document forever, because `resolveProfile`
          # only ran as an import stage. This oneshot walks one slice per run:
          # Cyrillic → Литрес-first, ISBN → one batched Hardcover lookup, the
          # rest GB → OL; the LiveLib card is disabled (`allowLivelibCard:
          # false`), so the unit never touches livelib.ru (AGENTS.md §1).
          #
          #   sudo systemctl start kinoboxd-resolve-books
          #   journalctl -u kinoboxd-resolve-books -f
          #
          # Idempotent: positive links are reused, a provider "nothing found"
          # verdict is skipped for `booksResolveRecheckDays` (per-candidate
          # state under cache-book/resolve-candidates/), a budget/breaker/error
          # deferral stays a candidate. The shared `cache-book/resolve.lock`
          # serialises it with an import resolve pass, and the unit conflicts
          # with every backfill unit so two Литрес consumers never overlap.
          kinoboxd-resolve-books = {
            description = "kinoboxd — book metadata resolve for the unlinked tail (oneshot)";
            documentation = [ "https://github.com/hattivatt/kinoboxd" ];
            after = [ "network-online.target" ];
            wants = [ "network-online.target" ];
            wantedBy = [ ];
            conflicts = conflictsFor booksResolveUnit;

            environment = serviceEnv // {
              BOOKS_LITRES_BUDGET = toString cfg.booksResolveLitresBudget;
              BOOKS_GB_BUDGET = toString cfg.booksResolveGbBudget;
            };

            path = [ cfg.package ];

            serviceConfig =
              hardening
              // serviceCommon
              // {
                Type = "oneshot";

                ExecStart = lib.concatStringsSep " " [
                  "${cfg.package}/bin/kinoboxd-books-resolve"
                  "--limit"
                  (toString cfg.booksResolveLimit)
                  "--pause"
                  (toString cfg.booksResolvePauseMs)
                  "--recheck-days"
                  (toString cfg.booksResolveRecheckDays)
                ];
              };
          };
        };

        # Optional schedule for the aggregate unit. Off by default; enabling it
        # just adds the timer, the units above stay manual the rest of the time.
        systemd.timers.kinoboxd-backfill = lib.mkIf cfg.backfillTimer.enable {
          description = "kinoboxd — scheduled TMDB/Wikidata cache backfill";
          wantedBy = [ "timers.target" ];
          timerConfig = {
            Unit = "${aggregateBackfillUnit}.service";
            OnCalendar = cfg.backfillTimer.interval;
            Persistent = true;
          };
        };

        # Books backfill schedule. Enabled by default: the first-publication
        # year is a queue that one manual run cannot drain (budget + limit),
        # and a run with nothing to do exits in seconds with zero requests.
        # `Persistent = true` replays a missed tick after a reboot without
        # stacking several runs.
        systemd.timers.kinoboxd-backfill-books = lib.mkIf cfg.booksBackfillTimer.enable {
          description = "kinoboxd — scheduled first-publication-year backfill";
          wantedBy = [ "timers.target" ];
          timerConfig = {
            Unit = "${booksBackfillUnit}.service";
            OnCalendar = cfg.booksBackfillTimer.interval;
            Persistent = true;
            RandomizedDelaySec = "5m";
          };
        };

        # Scheduled metadata resolve. Enabled by default: the unlinked tail is
        # a queue (Литрес budget + slice size), and an empty/recheck-only pool
        # exits in milliseconds with zero requests. `Persistent = true` replays
        # a missed tick after a reboot without stacking several runs.
        systemd.timers.kinoboxd-resolve-books = lib.mkIf cfg.booksResolveTimer.enable {
          description = "kinoboxd — scheduled book metadata resolve";
          wantedBy = [ "timers.target" ];
          timerConfig = {
            Unit = "${booksResolveUnit}.service";
            OnCalendar = cfg.booksResolveTimer.interval;
            Persistent = true;
            RandomizedDelaySec = "5m";
          };
        };

        networking.firewall = lib.mkIf cfg.openFirewall {
          allowedTCPPorts = [ cfg.port ];
        };

        users.users = lib.mkIf (cfg.user == "kinoboxd") {
          kinoboxd = {
            isSystemUser = true;
            group = cfg.group;
            home = stateDir;
            description = "kinoboxd service account";
          };
        };

        users.groups = lib.mkIf (cfg.group == "kinoboxd") {
          kinoboxd = { };
        };
      };

      meta.maintainers = [ ];
    };
}
