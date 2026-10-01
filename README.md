# Claushh

A private web portal for working on projects from any device: code editor, console for Claude Code,
terminal and git in the browser. Runs on a home computer (EndeavourOS), access through Cloudflare Tunnel,
login with a password and a TOTP code. One user.

Status: **frontend ready (login and sessions, editor with a diff view, console, workspaces and git, terminal);
backend: login, sessions and login protection (stage 1, parts A and B), the files API (stage 2), the repository list
and git status (stage 4).** Nothing is fit to be exposed to the internet. Progress: [`docs/PLAN.md`](docs/PLAN.md),
section "Stages".

## Documentation

| File | About |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | goal, interface, stack, security, deployment, stages |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | current code map, endpoints, conventions, tests |
| [`CLAUDE.md`](CLAUDE.md) | working rules for the repository (also for Claude Code) |

## Running in development

Requirements: Linux for the backend, .NET 10 SDK, Node.js 22.12+ (npm 11), Docker.

```bash
# database
cp deploy/.env.example deploy/.env    # fill in the password
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d

# backend: http://localhost:5080/api/health
dotnet user-secrets set --project src/Claushh.Api ConnectionStrings:Claushh \
  "Host=localhost;Port=5432;Database=claushh;Username=claushh;Password=<POSTGRES_PASSWORD from deploy/.env>"
dotnet user-secrets set --project src/Claushh.Api Projects:Root <directory>    # the projects directory of the portal
dotnet run --project src/Claushh.Api -- create-user    # once: the account and its TOTP key
dotnet run --project src/Claushh.Api

# frontend: http://localhost:4200
cd web
npm install
npm start
```

The backend reads repositories with libgit2, which comes with the build. Repositories in the projects directory must
belong to the user the API runs as: libgit2 refuses others, like git's safe.directory.

Lost phone or leaked password: `create-user --reset-totp` gives the account a new TOTP key,
`create-user --reset-password` a new password; both end all sessions (commands in `docs/ARCHITECTURE.md`).

## Frontend tests

```bash
cd web
npm test                          # integration (Vitest)
npx playwright install chromium   # once, browser for e2e
npm run e2e                       # build + e2e on the mock backend (e2e/mock-api)
```

Run the tests through npm: `web/.npmrc` starts Node with `--no-experimental-webstorage`, because from Node 25 on
Node's own `localStorage` hides jsdom's (the test environment's). For npm scripts in `web/` this setting replaces a
`NODE_OPTIONS` set in your shell.

## Backend tests

```bash
dotnet test    # integration tests; needs Docker (starts PostgreSQL 17 in a container)
```
