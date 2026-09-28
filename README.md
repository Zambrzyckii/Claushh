# Claushh

A private web portal for working on projects from any device: code editor, console for Claude Code,
terminal and git in the browser. Runs on a home computer (EndeavourOS), access through Cloudflare Tunnel,
login with a password and a TOTP code. One user.

Status: **frontend ready (login, editor, console, workspaces and git, terminal), backend not yet.** Nothing is fit to be exposed
to the internet. Progress: [`docs/PLAN.md`](docs/PLAN.md), section "Stages".

## Documentation

| File | About |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | goal, interface, stack, security, deployment, stages |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | current code map, endpoints, conventions, tests |
| [`CLAUDE.md`](CLAUDE.md) | working rules for the repository (also for Claude Code) |

## Running in development

Requirements: .NET 10 SDK, Node.js 22.12+ (npm 11), Docker.

```bash
# database (not used by the API yet)
cp deploy/.env.example deploy/.env    # fill in the password
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d

# backend: http://localhost:5080/api/health
dotnet run --project src/Claushh.Api

# frontend: http://localhost:4200
cd web
npm install
npm start
```

## Frontend tests

```bash
cd web
npm test                          # integration (Vitest)
npx playwright install chromium   # once, browser for e2e
npm run e2e                       # build + e2e on the mock backend (e2e/mock-api)
```
