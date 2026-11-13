{ pkgs, ... }:

{
  # ---------------------------------------------------------------------------
  # Toolchain: the backend is plain Node.js (CommonJS) + Express.
  # nodejs_24 is 24.21.0 in the pinned nixpkgs, matching the version the app
  # was tested with locally.
  # ---------------------------------------------------------------------------
  packages = [
    pkgs.nodejs_24
    pkgs.git
    pkgs.zip
    pkgs.unzip
    pkgs.jq
    pkgs.curl
    pkgs.nixfmt-rfc-style
    pkgs.fd
    pkgs.ripgrep
  ];

  env.LOCAL_NODE_VERSION_HINT = "node 24 (приложение проверено на 24.21.0)";

  enterShell = ''
    echo ""
    echo "KinoBoxdStat dev shell — node $(node --version), npm $(npm --version)"
    echo "  hint: $LOCAL_NODE_VERSION_HINT"
    echo ""
    echo "  kb-start       запустить сервер (npm start; PORT по умолчанию 3000)"
    echo "  kb-test        полный набор тестов (npm test)"
    echo "  kb-check       node --check для всех .js в server/"
    echo "  kb-contracts   перегенерировать contracts/*.md из кода"
    echo "  kb-census      размеры модулей/функций, дубли хелперов, мёртвый код"
    echo "  kb-smoke       HTTP-прогон трёх payload'ов (golden-фикстуры, без токенов)"
    echo "  kb-cache-wipe  очистить TMDB-кэш cache/ (с подтверждением)"
    echo ""
    echo "  TMDB-токен НЕ хранится в devenv-файлах: положи его в"
    echo "  config/tmdb-token или экспортируй TMDB_API_TOKEN в своём окружении"
    echo "  (эти файлы не коммитятся)."
    echo ""
  '';

  scripts = {
    kb-start = {
      description = "Запустить kinoboxd: npm start (порт из PORT, иначе 3000)";
      exec = ''
        cd "$DEVENV_ROOT"
        exec npm start
      '';
    };

    kb-test = {
      description = "Полный прогон тестов (npm test)";
      exec = ''
        cd "$DEVENV_ROOT"
        exec npm test
      '';
    };

    kb-check = {
      description = "Проверить синтаксис всех серверных .js (node --check)";
      exec = ''
        cd "$DEVENV_ROOT"
        find server -name '*.js' -print0 | xargs -0 -r -n1 node --check
        echo "syntax OK"
      '';
    };

    kb-contracts = {
      description = "Перегенерировать contracts/{api,env,limits,cache}.md из кода";
      exec = ''
        cd "$DEVENV_ROOT"
        exec node scripts/gen-contracts.js
      '';
    };

    kb-census = {
      description = "Отчёт census: размеры модулей и функций, копии хелперов";
      exec = ''
        cd "$DEVENV_ROOT"
        exec node scripts/census.js
      '';
    };

    kb-smoke = {
      description = "HTTP-прогон трёх payload'ов (требует TMDB-токен)";
      exec = ''
        cd "$DEVENV_ROOT"
        exec bash scripts/smoke.sh
      '';
    };

    kb-cache-wipe = {
      description = "Удалить TMDB-кэш (cache/index.json и cache/details)";
      exec = ''
        cache="$DEVENV_ROOT/cache"
        read -r -p "Удалить $cache/index.json и $cache/details? [y/N] " answer
        case "$answer" in
          [yY]*) ;;
          *)
            echo "отменено"
            exit 1
            ;;
        esac
        rm -f "$cache/index.json"
        rm -rf "$cache/details"
        echo "кэш очищен"
      '';
    };
  };
}
