# Architecture and code map

This file describes the **current state of the code**: what lives where and how the parts talk to each other.
Goals and decisions are in [`PLAN.md`](PLAN.md). After every change to the structure, a new module, endpoint
or dependency, update the relevant section.

Status: frontend of stages 1 and 2 done (login, explorer, editor). The backend has only `/api/health`.
The frontend is tested against a mock API that follows the contracts below.

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
| `web/src/app/core/browser/dialogs.ts` | the browser's `confirm()` wrapped in a service (to swap out in tests) |
| `web/src/app/core/api/files-api.ts` | files API client: directory listing, read, save with conflict detection |
| `web/src/app/core/api/project-path.ts` | relative path validation (no `..`, leading `/`, `\`) |
| `web/src/app/features/explorer/` | file tree, directories loaded lazily on expand, "Odśwież" (Refresh) |
| `web/src/app/features/editor/editor-store.ts` | state of open files: tabs, unsaved changes, save, conflicts (no dependency on Monaco) |
| `web/src/app/features/editor/code-editor.ts` | Monaco instance, one model per open file, synchronization with EditorStore |
| `web/src/app/features/editor/editor-pane.*` | tabs, path, error and conflict messages, the slot for the editor |
| `web/src/app/features/editor/monaco-loader.ts` | lazy loading of Monaco, its styles (`monaco.css`), workers and theme |
| `web/src/app/features/editor/workers/` | entry points of the Monaco web workers (editor, TS, JSON, CSS, HTML) |
| `web/tsconfig.worker.json` | tsconfig for the workers (referenced in `angular.json` as `webWorkerTsConfig`) |
| `web/src/app/features/login/` | login screen: username, password, TOTP code |
| `web/src/app/features/workspace/` | main layout: explorer + editor, "Wyloguj" (log out), status bar, Ctrl+S. Console and bottom panel as placeholders |
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

## Files and editor

### Rules

- Paths in the API are **relative to the projects directory** (`/srv/projects`), with `/` slashes, e.g.
  `studia/lab-3-sieci/src/main.c`. An empty string is the projects directory itself. The frontend rejects paths with `..`,
  a leading `/` and `\` before sending, but **the real check is done by the backend**.
- For now the explorer shows the whole projects directory. Choosing a workspace and repository will come in stage 4
  (then `Explorer.root` will get the repository path).
- **Saving never silently overwrites changes on disk.** Every file has a version (e.g. a content hash). A save sends
  the version the edit was based on. If the file changed on disk in the meantime (e.g. the console edited it),
  the server rejects the save (409) and the user chooses: "Wczytaj z dysku" (Load from disk) or "Nadpisz moją wersją" (Overwrite with my version).
- The editor state (`EditorStore`) is provided in the Workspace component, and logout reloads the page,
  so open files disappear from memory together with the session.
- **There is deliberately no `beforeunload` warning** for unsaved changes: it would block the reload on
  logout in another tab or on session expiry, and then the code would stay visible on screen. Instead
  we ask before closing a tab and before logout. Unsaved changes are lost on session expiry.

### Monaco

- The `monaco-editor` package in its ESM version, built in by the Angular bundler, loaded lazily on the first
  opening of the view (the login screen does not download it).
- Styles: `node_modules/monaco-editor/min/vs/editor/editor.main.css` as a separate `monaco.css` stylesheet
  (`angular.json` → `styles`, `inject: false`), loaded by `monaco-loader.ts`. The bundler does not load CSS
  imported from lazy modules, hence this exception. The `.ttf` loader in `angular.json` is needed because the Monaco
  modules import the icon font.
- Monaco displays spaces as `\u00a0`. Keep this in mind in tests that read text from the editor.
- Shortcuts: Ctrl+S / Cmd+S saves the active file (also when focus is outside the editor). The middle mouse button
  closes a tab.

### Files API contract (to be implemented in the backend)

All endpoints require a session (otherwise `401`). `PUT` requires the XSRF header.

| Method | Path | Response |
|---|---|---|
| GET | `/api/files/list?path=<katalog>` | `200 [{"name","path","kind":"file"\|"directory"}]`. Without the `.git` directory. `404` when the directory does not exist |
| GET | `/api/files/content?path=<plik>` | `200 {"path","content","version"}`. `404` no file, `413` too large, `415` binary file |
| PUT | `/api/files/content?path=<plik>` | body `{"content","baseVersion"}`. `200 {"version"}` or `409 {"currentVersion"}` when the version on disk differs from `baseVersion` |

Common to all: `400` when the path is invalid or, after resolution (including symlinks), goes outside
the projects directory. The `index.html` and `monaco.css` files are served with `Cache-Control: no-cache`
(the name `monaco.css` has no hash, so after a Monaco update the browser must download the new version).

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

Planned folders: `core/realtime` (SignalR), `features/console`, `features/terminal`, `features/workspaces`.

Dependencies besides Angular: `monaco-editor` (editor).

## Tests

| Part | Command | Tool |
|---|---|---|
| Frontend | `cd web && npm test` | Vitest: auth (service, guards, interceptor, `returnUrl`, login screen), files API, paths, explorer, `EditorStore`. `CodeEditor` (Monaco) has no unit tests, because Monaco does not work in jsdom; checked manually in the browser |
| Backend | no tests (they will come in stage 1, project `tests/Claushh.Api.Tests`) | xUnit |
