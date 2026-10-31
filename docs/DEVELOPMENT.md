# Development

How to run Claushh on a development machine, how the API serves the built frontend, how the tests run, and how the file icons are updated. Deploying it on a server is described in [DEPLOYMENT.md](DEPLOYMENT.md), the goal and the decisions in [PLAN.md](PLAN.md), and the code map in [ARCHITECTURE.md](ARCHITECTURE.md).

## Running in development

Requirements: Linux for the backend, .NET 10 SDK, Node.js 22.12+ (npm 11), Docker, git (the API runs it for clone,
fetch, pull and push), tmux 3.7 or later (the terminal; dotnet test needs it too), the `claude` CLI 2.1.285 or later
(the console; dotnet test does not need it).

```bash
# database (the compose project claushh-dev; the server uses claushh-prod)
cp deploy/.env.example deploy/.env    # fill in the password and a free POSTGRES_PORT
docker compose -p claushh-dev -f deploy/docker-compose.yml --env-file deploy/.env up -d

# backend: http://localhost:5080/api/health
dotnet user-secrets set --project src ConnectionStrings:Claushh \
  "Host=localhost;Port=<POSTGRES_PORT>;Database=claushh;Username=claushh;Password=<POSTGRES_PASSWORD from deploy/.env>"
dotnet user-secrets set --project src Projects:Root <directory>    # the projects directory of the portal
dotnet run --project src -- create-user    # once: the account and its TOTP key
dotnet run --project src

# frontend: http://localhost:4200
cd web
npm install
npm start
```

The backend reads repositories with libgit2, which comes with the build. Repositories in the projects directory must
belong to the user the API runs as: libgit2 refuses others, like git's safe.directory.

The Terminal tab runs your login shell (your `SHELL`) as you, on a tmux server of the API's own (socket in
`$XDG_RUNTIME_DIR/claushh`, apart from your own tmux), with only a few variables of the API's environment (HOME, USER,
PATH, the locale): none of the API's connection string, `ASPNETCORE_*`, `DOTNET_*` or `CLAUDECODE*` reach it (your login
profile may still set its own, e.g. `DOTNET_ROOT`). Terminals end when the API stops, also on Ctrl+C. Open the portal
at `http://localhost:4200`: hubs accept only the origins in `Hubs:AllowedOrigins` (`appsettings.Development.json`), so
`http://127.0.0.1:4200` gets no terminal or console.

The Console panel runs the `claude` CLI (`Console:ClaudePath`, by default `claude` on PATH) with a config directory of
its own, `~/.local/state/claushh/claude` (`Console:ConfigDirectory`; `$XDG_STATE_HOME/claushh/claude` when
`XDG_STATE_HOME` is set): your `~/.claude` settings, CLAUDE.md and plugins are not used there. Log in there once:

```bash
CLAUDE_CONFIG_DIR=~/.local/state/claushh/claude claude    # then /login, and /exit when done
```

or put an Anthropic API key in a file with mode 0600 outside the projects directory and set `Console:ApiKeyFile` to
its path; the API checks both (the path as written and with symlinks resolved, and no group or other permissions)
and otherwise leaves the console unavailable, with the reason in its log (an `ANTHROPIC_API_KEY` in the API's
environment never reaches the CLI). A "yes, always" rule is saved per project in the database; to remove one:

```bash
docker compose -p claushh-dev -f deploy/docker-compose.yml --env-file deploy/.env exec postgres \
  psql -U claushh -d claushh -c "DELETE FROM \"ConsoleRules\" WHERE \"ProjectPath\" = '<project>' AND \"Rule\" = '<rule>'"
```

The config directory also holds the login (`.credentials.json`), the CLI's transcripts (kept 90 days), plan files and
backups of its own state. Everything but `.credentials.json` may be deleted while the API is stopped; older
conversations then cannot be resumed, and "New conversation" starts a new one. Without `.credentials.json`, log in
again as above.

Cloning, fetching and pulling a public repository needs no credential helper in development; pushing always needs
credentials (also for a public repository); the server's GitHub token is set up in [DEPLOYMENT.md](DEPLOYMENT.md), "First
install", step 8.

Login notifications (ntfy) are off in development unless `Notifications:NtfyUrl` is set
(`dotnet user-secrets set --project src Notifications:NtfyUrl https://ntfy.sh/<your topic>`, and optionally
`Notifications:NtfyToken`); on the server the API does not start without it.

Passkeys work at `http://localhost:4200` and `http://localhost:5080`, not at `127.0.0.1`: their RP ID is
`Passkeys:ServerDomain`, `localhost` in `appsettings.Development.json` (one passkey serves both ports), and an IP
address cannot have passkeys. The API does not start without that key.

Lost phone or leaked password: `create-user --reset-totp` gives the account a new TOTP key,
`create-user --reset-password` a new password; both end all sessions and remove every passkey (commands in
`docs/ARCHITECTURE.md`).

## Running the built frontend

The API serves the production build itself when `Frontend:Root` points at it, as on the server (one process, one
origin):

```bash
npm --prefix web run build    # the build in web/dist/web/browser
dotnet user-secrets set --project src Frontend:Root <absolute path>/web/dist/web/browser
dotnet run --project src
```

Then open `http://localhost:5080`, which is already one of the hubs' allowed origins (`appsettings.Development.json`).
The API takes the Content-Security-Policy header from `index.html` once at start, so restart it after a build that
changes the policy. Without `Frontend:Root` the API serves no frontend, and development uses `npm start` as above.

## Frontend tests

```bash
cd web
npm test                          # integration (Vitest)
npx playwright install chromium   # once, browser for e2e
npm run e2e                       # build + e2e on the mock backend (e2e/mock-api), desktop and phone (Pixel 7)
```

Run the tests through npm: `web/.npmrc` starts Node with `--no-experimental-webstorage`, because from Node 25 on
Node's own `localStorage` hides jsdom's (the test environment's). For npm scripts in `web/` this setting replaces a
`NODE_OPTIONS` set in your shell.

## Backend tests

```bash
dotnet test    # integration tests; needs Docker (starts PostgreSQL 17 in a container)
```

Also needs the git CLI ≥ 2.45 (some test repositories use `--ref-format=reftable`).
The console tests run a fake `claude` built with the solution (`tests/Claushh.FakeClaude`); the real CLI is not needed.

## Updating the file icons

The icons in `web/public/file-icons/` and their name map `web/src/app/core/icons/file-icon-map.ts` are copies, so
builds and tests never need the package. After changing the selection (`ALLOWED` in `web/scripts/file-icons.mjs`) or
updating `material-icon-theme` (a devDependency), run `cd web && node scripts/file-icons.mjs` and commit both.
