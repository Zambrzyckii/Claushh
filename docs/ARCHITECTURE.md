# Architecture and code map

This file describes the **current state of the code**: what lives where and how the parts talk to each other.
Goals and decisions are in [`PLAN.md`](PLAN.md). After every change to the structure, a new module, endpoint
or dependency, update the relevant section.

Status: **stage 0 (skeleton)**.

## Flow

```
Browser (Angular, web/)
   │  HTTPS + WebSocket (SignalR)
Cloudflare Tunnel                       [stage 1]
   │
ASP.NET Core API (src/Claushh.Api)
   ├─ PostgreSQL (deploy/docker-compose.yml, localhost only)    [stage 1]
   ├─ files / git  → /srv/projects                              [stage 2, 4]
   ├─ terminal     → PTY + tmux                                 [stage 4]
   └─ console      → `claude` process (stream-json)             [stage 3]
```

In development mode, Angular (`npm start`, port 4200) proxies `/api` and `/hubs`
to the API at `http://localhost:5080` (`web/proxy.conf.json`).

## Repository map

| Path | Contents |
|---|---|
| `Claushh.slnx` | .NET solution (XML format) |
| `Directory.Build.props` | shared settings for the .NET projects: `net10.0`, nullable, warnings as errors |
| `src/Claushh.Api/` | ASP.NET Core backend |
| `src/Claushh.Api/Program.cs` | app configuration and endpoint mapping |
| `src/Claushh.Api/Properties/launchSettings.json` | development profile, port 5080 |
| `web/` | Angular 21 frontend (standalone components, signals, the new `@if` syntax) |
| `web/src/styles.scss` | global color and font tokens (CSS variables) |
| `web/src/app/app.routes.ts` | routes: `/login`, `/` (workspace) |
| `web/src/app/features/login/` | login screen (password + TOTP), not connected yet |
| `web/src/app/features/workspace/` | main layout after login, areas as placeholders |
| `web/proxy.conf.json` | dev server proxy to the API |
| `deploy/docker-compose.yml` | PostgreSQL 17 on `127.0.0.1:5432` |
| `deploy/.env.example` | template of variables for Compose (copy to `deploy/.env`) |
| `docs/` | project documentation |

## Backend

Endpoints:

| Method | Path | Description | Authorization |
|---|---|---|---|
| GET | `/api/health` | checks whether the API is running | none |

Planned folder layout in `src/Claushh.Api/` (created together with the code they concern):
`Auth/` (Identity, TOTP, sessions), `Data/` (DbContext, migrations), `Files/` (files API and path protection),
`Console/` (the `claude` process, MCP for permissions), `Terminal/` (PTY, tmux), `Git/`, `Hubs/` (SignalR).

## Frontend

Conventions:
- Standalone components, local state in `signal()`.
- Each app feature in a separate folder `web/src/app/features/<nazwa>/`, lazy-loaded from the routes.
- Colors and fonts only through the variables from `styles.scss`, no hard-coded colors in components
  (exceptions to be removed when the palette is refined).

Planned folders: `core/` (API services, SignalR, auth guard), `features/explorer`, `features/editor`,
`features/console`, `features/terminal`, `features/workspaces`.

## Tests

| Part | Command | Tool |
|---|---|---|
| Frontend | `cd web && npm test` | Vitest |
| Backend | no tests (they will come in stage 1, project `tests/Claushh.Api.Tests`) | xUnit |
