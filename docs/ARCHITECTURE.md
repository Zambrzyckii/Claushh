# Architecture and code map

This file describes the **current state of the code**: what lives where and how the parts talk to each other.
Goals and decisions are in [`PLAN.md`](PLAN.md). After every change to the structure, a new module, endpoint
or dependency, update the relevant section.

Status: **stage 1 in progress**: login, guard and logout on the frontend side done, backend not yet.

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
| `web/src/app/app.config.ts` | providers: router, HttpClient with the interceptor and XSRF, bfcache protection |
| `web/src/app/app.routes.ts` | routes: `/login` (`guestGuard`), `/` (`authGuard`, workspace) |
| `web/src/app/core/auth/auth.service.ts` | session state, login, logout, session expiry, tab sync |
| `web/src/app/core/auth/auth.guards.ts` | `authGuard` (only with a session), `guestGuard` (only without a session) |
| `web/src/app/core/auth/auth.interceptor.ts` | 401 from the API → end of the session and reload to `/login` |
| `web/src/app/core/auth/return-url.ts` | `returnUrl` validation (open redirect protection) |
| `web/src/app/core/browser/hard-navigation.ts` | full page reload (clears all in-memory state) |
| `web/src/app/core/browser/bfcache-guard.ts` | reload of a page restored from the back/forward cache |
| `web/src/app/features/login/` | login screen: username, password, TOTP code |
| `web/src/app/features/workspace/` | main layout after login, "Wyloguj" (log out) button, the other areas as placeholders |
| `web/proxy.conf.json` | dev server proxy to the API |
| `deploy/docker-compose.yml` | PostgreSQL 17 on `127.0.0.1:5432` |
| `deploy/.env.example` | template of variables for Compose (copy to `deploy/.env`) |
| `docs/` | project documentation |

## Authentication

### Rules

- **The frontend stores no tokens.** The session is an `HttpOnly` cookie, invisible to JavaScript.
  In memory (`AuthService`) there is only the logged-in user's name. Nothing goes to `localStorage`
  or `sessionStorage`.
- **The server decides whether a session is valid.** The guard asks `GET /api/auth/me` (once per page load),
  any error, including no connection, means no session.
- **CSRF:** Angular automatically sends the `XSRF-TOKEN` cookie back in the `X-XSRF-TOKEN` header
  on state-changing requests.
- **Leaving a session always ends with a full reload** (`location.replace`), so the whole app state
  disappears from memory, and no history entry with the logged-in view remains.

### Flows

| Event | What happens |
|---|---|
| Visiting `/` without a session | `authGuard` → `/login?returnUrl=…` |
| Visiting `/login` with a session | `guestGuard` → `/` |
| Login | `POST /api/auth/login`, then `GET /api/auth/me` (confirms the cookie, new XSRF token). Navigation to `returnUrl` after validation (`safeReturnUrl`) |
| Failed login | a generic message, the password and code fields are cleared. 429 shows the time from `Retry-After` |
| Logout | `POST /api/auth/logout` → storage cleanup → message to other tabs (`BroadcastChannel`) → reload to `/login?logout=ok`. When the server does not respond: `/login?logout=unconfirmed` with a warning |
| 401 from another API endpoint | interceptor → the same as logout, target `/login?reason=expired&returnUrl=…`. Several simultaneous 401s give one reload |
| Logout in another tab | this tab also clears its state and reloads to `/login` |
| "Back" after logout | the page from bfcache is reloaded, the guard sends you to `/login` |

### API contract (to be implemented in the backend)

| Method | Path | Response |
|---|---|---|
| GET | `/api/auth/me` | `200 {"userName": "..."}` or `401`. **Always sets a fresh `XSRF-TOKEN` cookie** (also on 401, because it is needed for login) |
| POST | `/api/auth/login` | body `{"userName","password","totpCode"}`. `204` + session cookie, `401` on wrong credentials (without saying what was wrong), `429` with `Retry-After`, `400` on a bad XSRF token |
| POST | `/api/auth/logout` | invalidates the session **on the server** (not just the cookie), `204` with `Set-Cookie` expiring the session and XSRF cookies and `Clear-Site-Data: "cache", "storage"`. `401` when the session no longer exists |

Backend requirements that follow from the frontend:
- session cookie: `HttpOnly; Secure; SameSite=Strict; Path=/`,
- `XSRF-TOKEN` cookie: **without** `HttpOnly` (Angular must read it), `Secure; SameSite=Strict; Path=/`,
- validation of the `X-XSRF-TOKEN` header on every POST/PUT/PATCH/DELETE, including login,
- every endpoint except `/api/health` and the three above returns `401` without a session,
- `index.html` with the `Cache-Control: no-store` header.

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
- Things shared by the whole app (auth, browser access, later API and SignalR) go in `web/src/app/core/`.
- Each app feature in a separate folder `web/src/app/features/<nazwa>/`, lazy-loaded from the routes.
- Colors and fonts only through the variables from `styles.scss`, no hard-coded colors in components
  (exceptions to be removed when the palette is refined).

Planned folders: `core/api`, `core/realtime` (SignalR), `features/explorer`, `features/editor`,
`features/console`, `features/terminal`, `features/workspaces`.

## Tests

| Part | Command | Tool |
|---|---|---|
| Frontend | `cd web && npm test` | Vitest (auth: service, guards, interceptor, `returnUrl`, login screen) |
| Backend | no tests (they will come in stage 1, project `tests/Claushh.Api.Tests`) | xUnit |
