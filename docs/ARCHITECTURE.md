# Architecture and code map

This file describes the **current state of the code**: what lives where and how the parts talk to each other.
Goals and decisions are in [`PLAN.md`](PLAN.md). After every change to the structure, a new module, endpoint
or dependency, update the relevant section.

Status: frontend done (login, session countdown and the "Bezpieczeństwo" (Security) window, explorer, editor with diff view,
console, workspaces and git, terminal). The backend has login and sessions (section "Backend"); the other contracts are still only in the mock.
The frontend is tested against a mock backend (`web/e2e/mock-api/`) that follows the contracts below.

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
| `src/Claushh.Api/Data/` | `ClaushhDbContext` (Identity tables, `Sessions` and `LoginAttempts`) and EF Core migrations, applied at startup |
| `src/Claushh.Api/Auth/` | login: `Session`, `AuthSessionOptions`, `AuthCookies` (cookie names), `SessionService` (the only code with session rules), `SessionAuthenticationHandler` (cookie → user, never extends), `SessionAntiforgeryData` (XSRF token bound to the session), `TotpVerifier` (TOTP codes, each accepted once), `LoginGuard` (limit per IP, account lockout, login history), `LoginAttempt`, `DeviceName` (User-Agent for storage and display), `AuthEndpoints` (`me`, `login`, `keepalive`, `logout`, XSRF filter), `SessionEndpoints` (session list, ending sessions, login history), `CreateUserCommand` (`create-user`), `AuthCleanup` (hourly deletion after 90 days) |
| `dotnet-tools.json` | local .NET tools: `dotnet-ef` (`dotnet tool restore`) |
| `tests/Claushh.Api.Tests/` | backend integration tests: xUnit, the API in memory (`WebApplicationFactory`), PostgreSQL 17 from Testcontainers (`ApiFactory`) |
| `global.json` | `dotnet test` runs on Microsoft.Testing.Platform (required by xUnit v3 on the .NET 10 SDK) |
| `web/` | Angular 21 frontend (standalone components, signals, the new `@if` syntax) |
| `web/src/index.html` | start page with the Content-Security-Policy in `<meta>` (section "Security headers") |
| `web/src/main.ts` | app startup: Trusted Types policy, and inside a frame of a foreign page the app does not start |
| `web/src/styles.scss` | global color and font tokens (CSS variables) |
| `web/src/app/app.config.ts` | providers: router, HttpClient with the interceptor and XSRF, bfcache protection |
| `web/src/app/app.routes.ts` | routes: `/login` (`guestGuard`), `/` (`authGuard`, workspace) |
| `web/src/app/core/auth/auth.service.ts` | session state, login, logout, session expiry, tab sync |
| `web/src/app/core/auth/auth.guards.ts` | `authGuard` (only with a session), `guestGuard` (only without a session) |
| `web/src/app/core/auth/auth.interceptor.ts` | 401 from the API → end of the session and reload to `/login` (except requests with `IGNORE_UNAUTHORIZED`) |
| `web/src/app/core/auth/ignore-unauthorized.ts` | `IGNORE_UNAUTHORIZED` (HttpContextToken): a request whose 401 the interceptor skips (e.g. `DELETE /api/auth/sessions/{id}` in `confirmLogout`) |
| `web/src/app/core/auth/return-url.ts` | `returnUrl` validation (open redirect protection) |
| `web/src/app/core/auth/session-timer.ts` | countdown to the end of the session, extension on activity (at most once a minute) |
| `web/src/app/core/api/sessions-api.ts` | API client for active sessions and login history |
| `web/src/app/core/browser/hard-navigation.ts` | full page reload (clears all in-memory state) |
| `web/src/app/core/browser/bfcache-guard.ts` | reload of a page restored from the back/forward cache |
| `web/src/app/core/browser/dialogs.ts` | the browser's `confirm()` and `alert()` wrapped in a service (to swap out in tests). Only in response to a user action and for short texts: they block the page (including the session countdown), and Chrome truncates long text in them. Questions with long content are panels on the page |
| `web/src/app/core/browser/trusted-types.ts` | default Trusted Types policy: only worker script URLs from the same domain |
| `web/src/app/core/browser/focus.ts` | `isTypingElsewhere`: whether the user is typing somewhere else (the view then does not take focus) |
| `web/src/app/core/api/files-api.ts` | files API client: directory listing, read, save with conflict detection |
| `web/src/app/core/api/api-error.ts` | shared API error for workspaces and git (`ApiError`, HTTP code mapping) |
| `web/src/app/core/api/workspaces-api.ts` | API client for workspaces and repositories: list, create, clone |
| `web/src/app/core/api/git-api.ts` | git API client: status, pull, push |
| `web/src/app/core/project/project-context.ts` | the open repository (from the `?repo=` URL), "files changed" and "files saved" events |
| `web/src/app/core/project/repo-status.ts` | git status of the open repo: branch, changes, badges for the explorer |
| `web/src/app/core/text/polish.ts` | number declension (1 zmiana, 2 zmiany, 5 zmian) and relative time ("12 minut temu" (12 minutes ago)) |
| `web/src/app/core/text/visible-text.ts` | `revealHidden`: shows invisible and control characters, tabs, runs of whitespace and blank lines (commands to approve). `previewText`: a preview for the question window, with explicit information about omitted fragments |
| `web/src/app/core/realtime/hub-client.ts` | shared base for SignalR connections: WebSocket, auto-reconnect, session check on disconnect |
| `web/src/app/core/realtime/console-protocol.ts` | console hub contract: events, methods, option types |
| `web/src/app/core/realtime/console-connection.ts` | connection to `/hubs/console` (built on `HubClient`) |
| `web/src/app/core/realtime/terminal-protocol.ts` | terminal hub contract: methods, events, types |
| `web/src/app/core/realtime/terminal-connection.ts` | connection to `/hubs/terminal` (built on `HubClient`) |
| `web/src/app/core/api/project-path.ts` | relative path validation (no `..`, leading `/`, `\`) |
| `web/src/app/features/explorer/` | file tree, directories loaded lazily on expand, git badges, "Odśwież" (Refresh) |
| `web/src/app/features/editor/editor-store.ts` | state of open files: tabs, unsaved changes, save, conflicts, diff view (no dependency on Monaco) |
| `web/src/app/features/editor/code-editor.ts` | Monaco: a regular editor or a diff view (diff against HEAD), one model per open file |
| `web/src/app/features/editor/editor-pane.*` | tabs, path, error and conflict messages, the slot for the editor |
| `web/src/app/features/editor/monaco-loader.ts` | lazy loading of Monaco, its styles (`monaco.css`), workers and theme |
| `web/src/app/features/editor/workers/` | entry points of the Monaco web workers (editor, TS, JSON, CSS, HTML) |
| `web/tsconfig.worker.json` | tsconfig for the workers (referenced in `angular.json` as `webWorkerTsConfig`) |
| `web/src/app/features/login/` | login screen: username, password, TOTP code, retrying an unconfirmed logout |
| `web/src/app/features/security/` | the "Bezpieczeństwo" (Security) window: active sessions, login history, "Wyloguj pozostałe" (log out others) / "Wyloguj wszędzie" (log out everywhere) |
| `web/src/app/features/console/console-store.ts` | conversation state built from hub events, sending, permissions, interrupt, new conversation |
| `web/src/app/features/console/console-panel.*` | the Konsola (Console) panel: the conversation as plain text, prompt field, model / effort / mode |
| `web/src/app/features/workspaces/workspaces-store.ts` | state of the Workspace panel: workspaces, repositories, pull / push, create, clone |
| `web/src/app/features/workspaces/workspaces-panel.*` | the "Workspace" tab in the bottom panel (workspace list, repository table) |
| `web/src/app/features/workspaces/validation.ts` | validation of the workspace name and the clone URL |
| `web/src/app/features/terminal/terminal-store.ts` | terminal list, active terminal, opening in the repo directory, closing, queues of typed characters (one per terminal) |
| `web/src/app/features/terminal/terminal-panel.*` | the "Terminal" tab: the terminal bar and their views |
| `web/src/app/features/terminal/terminal-view.ts` | a single xterm.js: attaching with a snapshot and `seq` numbers, typing, safe pasting, size fitting |
| `web/src/app/features/terminal/terminal-input.ts` | queue of typed characters (acknowledged batches with `client` + `seq`) and cleaning of pasted text |
| `web/src/app/features/terminal/xterm-loader.ts` | lazy loading of xterm.js and the terminal look (theme, font) |
| `web/src/app/features/workspace/` | main layout: path and branch, the session countdown and the "Bezpieczeństwo" button in the top bar, explorer, editor, console, bottom panel (Workspace, Terminal), status bar, Ctrl+S |
| `web/playwright.config.ts` | e2e configuration (build from `dist/`, mock on port 4400, Chromium) |
| `web/e2e/mock-api/server.mjs` | mock backend: auth, files, workspaces and simulated git, console and terminal hubs (SignalR JSON over WebSocket, simulated shell), security headers, `/__test/*`. Listens only on `127.0.0.1` |
| `web/e2e/tests/` | e2e tests: `auth`, `editor`, `diff`, `console`, `workspaces`, `terminal`, `security`, `mock-api` + `helpers.ts` and `fixtures.ts` (CSP check in every test, `newDevice` for a second browser) |
| `web/proxy.conf.json` | dev server proxy to the API |
| `deploy/docker-compose.yml` | PostgreSQL 17 on `127.0.0.1:5432` |
| `deploy/.env.example` | template of variables for Compose (copy to `deploy/.env`) |
| `docs/` | project documentation |

## Authentication

### Rules

- **The frontend stores no tokens.** The session is an `HttpOnly` cookie, invisible to JavaScript.
  In memory (`AuthService`) there is only the logged-in user's name and the public session ID.
  Nothing goes to `localStorage` or `sessionStorage`, except the unconfirmed logout marker in `localStorage`
  (a public session ID, not a secret).
- **The server decides whether a session is valid.** The guard asks `GET /api/auth/me` (once per page load),
  any error, including no connection, means no session.
- **CSRF:** Angular automatically sends the `XSRF-TOKEN` cookie back in the `X-XSRF-TOKEN` header
  on state-changing requests.
- **Leaving a session always ends with a full reload** (`location.replace`), so the whole app state
  disappears from memory, and no history entry with the logged-in view remains.
- **Only user activity extends the session** (key press, click, scroll, also in the editor
  and the terminal): `SessionTimer` calls `POST /api/auth/keepalive` at most once a minute. Regular API
  requests (e.g. background refresh, console work) do not extend the session, so a computer left unattended logs out.
- The server gives expiry times **relatively, in seconds** (`expiresIn`, `absoluteExpiresIn`), so a wrongly
  set device clock does not break the countdown. The countdown shows the earlier of the two deadlines.
- During logout, "session expired" signals (closed WebSockets, 401) are ignored, and the
  logout signal from another tab is handled only by a logged-in tab. Otherwise races changed the message
  "Wylogowano" (Logged out) to "Sesja wygasła" (Session expired) or reloaded a fresh login screen.
- **Expiry works even without the server (fail-closed).** When the countdown reaches zero, `SessionTimer` asks
  the server (`verifySession`, a 10 s limit for the response). If the server does not respond (no network, tunnel failure,
  Cloudflare Access redirect), and 30 s have passed since the deadline (`EXPIRY_GRACE_MS`), the session ends locally
  as on a 401. The view with the code does not stay on screen forever.
- **Logout** sends `POST /api/auth/logout` without an ID (it ends the session from the cookie, i.e. the one
  the browser uses) and waits at most 10 s (`LOGOUT_TIMEOUT_MS`). No confirmation (error, no response)
  ends locally as `logout=unconfirmed`: during logout "session expired" signals are ignored,
  so a hanging request would leave the view with the code on screen.
- **After an unconfirmed logout there is no way back into the app without logging in.** Before the reload, AuthService
  stores in `localStorage` the `claushh-pending-logout` marker with the public session ID (from `/me` or
  `keepalive` or from the `session` message from the tab that logged in; `''` when unknown). As long as it exists,
  `authGuard` does not let you in (it checks the marker before and after the server response, because another tab could have written it
  in the meantime), it only sends you to `/login?logout=unconfirmed`, and `guestGuard` does the same from other login screens,
  so neither "Back" nor a new tab will return to the app, even though the session on the server may still be alive. Without the marker, the URL
  `/login?logout=unconfirmed` (an external link, an old history entry) is checked like any login screen.
- With the marker, the login screen itself retries ending **exactly this session** (`AuthService.confirmLogout`)
  right away, after 3 s, after 10 s, and then every 30 s, until the server confirms: `GET /me` (401: the session is gone), when the cookie
  still belongs to it: `POST /logout {sessionId}` (the server responds 409 if the cookie already belongs to another session),
  and when it belongs to a new session (login in another tab): `DELETE /api/auth/sessions/{id}` and the new session stays. Then
  the screen does not say "Wylogowano", it goes to the app (`replaceUrl`): the browser has a live session, and a message
  about logout would be false.
  The marker is read on every attempt (another tab could have written a newer one) and removed only when it still
  points to the confirmed session. "Wylogowano…" appears only once the marker is gone. Without the marker (another
  tab already finished the logout) nothing is ended automatically: `GET /me` only checks whether the session is gone.
  If there is a session after all (a new login in another tab), the screen goes to the app, like any login screen
  with a session. With a marker without an ID (`''`), the session is ended only by the "Ponów wylogowanie" (Retry logout) button. Retrying
  in this tab stops before a login, and login and logout retry in different tabs exclude each other
  with a Web Locks lock (`claushh-auth`): `POST /logout` from one tab will not end a session being created in another, nor
  invalidate its XSRF token during login.
- When the browser blocks `localStorage` (the marker cannot be saved), logout ends at
  `/login?logout=unconfirmed&marker=none`. `guestGuard` lets you onto this screen without a marker only when storage
  really does not work (an external link cannot force this), and the button ends the session. Without storage, "Back" and a new tab
  are not blocked (there is nowhere to remember the unconfirmed logout). A successful login replaces the login screen in history (`replaceUrl`), broadcasts
  the new session ID to other tabs, ends the old session by ID (`DELETE /api/auth/sessions/{id}`
  already from the new session) and removes the marker.
- Other login screens (including `?logout=ok`) go through `guestGuard` normally. The XSRF token is bound
  to the identity it was issued for (a session or no session), and logout removes it, so `AuthService.login` always
  first calls `GET /api/auth/me` (it issues a fresh token even on 401). Otherwise the old token after an unconfirmed
  logout would give 400 ("Nieprawidłowe dane logowania" (Invalid login details)) on every attempt.
- Messages between tabs (`BroadcastChannel` `claushh-auth`): `{ type: 'logout', result: 'ok' | 'unconfirmed'
  | 'expired' }` (the other tabs end with the same message), `{ type: 'expiry', at }` (new deadline)
  and `{ type: 'session', sessionId }` (another tab logged in, the cookie now belongs to that session).
  The message shape is checked before use.

### Flows

| Event | What happens |
|---|---|
| Visiting `/` without a session | `authGuard` → `/login?returnUrl=…` |
| Visiting `/` or `/login` with an unconfirmed logout marker | guard → `/login?logout=unconfirmed` (without asking the server) |
| Visiting `/login` with a session (without a marker) | `guestGuard` → `/`, also for `/login?logout=unconfirmed` (an external link, an old history entry). With a marker: the row above |
| Login | `POST /api/auth/login`, then `GET /api/auth/me` (confirms the cookie, new XSRF token). Navigation to `returnUrl` after validation (`safeReturnUrl`) |
| Failed login | a generic message, the password and code fields are cleared. 429 shows the time from `Retry-After` |
| Logout | `POST /api/auth/logout` (10 s limit) → storage cleanup → message to other tabs (`BroadcastChannel`) → reload to `/login?logout=ok`. When the server does not confirm: a marker with the session ID in `localStorage` and `/login?logout=unconfirmed` with a warning, and the screen retries the logout (0 s, 3 s, 10 s, then every 30 s) until the server confirms ("Wylogowano. Serwer potwierdził zakończenie sesji." (Logged out. The server confirmed the session ended.)) |
| 401 from another API endpoint | interceptor → the same as logout, target `/login?reason=expired&returnUrl=…`. Several simultaneous 401s give one reload |
| Logout in another tab | this tab also clears its state and reloads to the login screen with the same message (`logout=ok`, `logout=unconfirmed` or `reason=expired`) |
| "Back" after logout | the page from bfcache is reloaded, the guard sends you to `/login` |
| Countdown in the top bar | "Sesja wygasa za m:ss" (Session expires in m:ss). The last 2 minutes in yellow with a "Przedłuż" (Extend) button |
| Countdown reached zero | `GET /api/auth/me` every 10 s: 401 → as an expired session, 200 (e.g. extended in another tab) → new countdown. No response for longer than 30 s after the deadline → local expiry |
| Extension in one tab | other tabs get the new deadline via `BroadcastChannel` |
| "Wyloguj wszędzie" | one question (with the number of unsaved files) before anything else, then `POST /api/auth/sessions/revoke-others` and logout of this session without further questions |

### API contract

Implemented in the backend (section "Backend"), except closing the WebSockets of an ended session, which comes with the hubs, and `ip` from `CF-Connecting-IP`, which needs `ForwardedHeaders` (stage 1, part C) — until then `ip` is the connection address.

| Method | Path | Response |
|---|---|---|
| GET | `/api/auth/me` | `200 {"userName","sessionId","expiresIn","absoluteExpiresIn"}` (`sessionId`: the public session ID as in `/api/auth/sessions`, never the secret from the cookie, **constant for the whole life of the session**, also after `keepalive`: the frontend uses it to recognize whether the cookie still belongs to the session whose logout the server did not confirm; seconds until the idle expiry and until the hard limit) or `401`. **Does not extend the session.** **Always sets a fresh `XSRF-TOKEN` cookie** (also on 401, because it is needed for login) |
| POST | `/api/auth/login` | body `{"userName","password","totpCode"}`. `204` + session cookie, `401` on wrong credentials (without saying what was wrong), `429` with `Retry-After`, `400` on a bad XSRF token |
| POST | `/api/auth/logout` | body `{"sessionId"}` (optional). Invalidates the session **on the server** (not just the cookie) and closes its WebSockets, `204` with `Set-Cookie` expiring the session and XSRF cookies. `401` when the session no longer exists. `409` (and ends nothing) when `sessionId` is given and the cookie belongs to another session (a new login in the meantime). **No `Clear-Site-Data`**: Chrome then holds the response for up to several seconds (measured in e2e tests), and the frontend clears storage anyway |
| POST | `/api/auth/keepalive` | extends the session by the idle time (e.g. 30 min), no further than the hard limit (e.g. 12 h). `200 {"sessionId","expiresIn","absoluteExpiresIn"}`. **The only request that extends the session** |

#### Sessions and login history

| Method | Path | Response |
|---|---|---|
| GET | `/api/auth/sessions` | `200 [{"id","current","device","ip","createdAt","lastActivityAt"}]`. `id` is a public ID, **never the secret from the cookie**. `device` e.g. "Chrome · Linux" from the User-Agent header, `ip` from `CF-Connecting-IP` |
| DELETE | `/api/auth/sessions/{id}` | ends another session (including its WebSockets). `204`, `404` unknown, `400` for your own session (that is what logout is for) |
| POST | `/api/auth/sessions/revoke-others` | ends all sessions except the current one. `204` |
| GET | `/api/auth/logins` | `200 [{"at","ip","device","success"}]`, the last 20, newest first, including failed attempts |

Backend requirements that follow from the frontend:
- session cookie: `HttpOnly; Secure; SameSite=Strict; Path=/`,
- `XSRF-TOKEN` cookie: **without** `HttpOnly` (Angular must read it), `Secure; SameSite=Strict; Path=/`,
- validation of the `X-XSRF-TOKEN` header on every POST/PUT/PATCH/DELETE, including login. The token is bound
  to the identity it was issued for (the backend adds the session ID through `IAntiforgeryAdditionalDataProvider`; ASP.NET alone binds it only to the user): a token issued for a session will not pass
  without it and vice versa (the mock does the same),
- every endpoint except `/api/health` and the three above returns `401` without a session,
- the session expires after an idle time counted from the last `keepalive` (or login) and after the hard limit,
- all `/api/*` responses with `Cache-Control: no-store`,
- `index.html` with the `Cache-Control: no-store` header,
- the headers from section "Security headers".

## Security headers

A second line of defense, in case an XSS bug ever turns up in Monaco, xterm or a template, and protection against embedding
the portal in a frame of a foreign page (clickjacking).

- **Content-Security-Policy** is in `<meta>` in `web/src/index.html` (it also works with `ng serve` and when the backend
  forgets the header; manual test: `ng serve` + the mock on port 5080, the Monaco workers start):
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;
  connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'none'; object-src 'none';
  require-trusted-types-for 'script'`.
  Scripts only from our own domain, no inline and no `eval`. Inline styles are needed by Angular, Monaco and xterm.
  `form-action 'none'`: no form submits natively (the password will not end up in the URL if JS failed).
- **Trusted Types** (`require-trusted-types-for 'script'`): the browser rejects plain strings inserted as HTML
  (`innerHTML`), a script or a script URL, so an XSS bug in the DOM will not run code. Angular and Monaco have their own
  policies. The default policy (`core/browser/trusted-types.ts`, installed in `main.ts`) lets through only URLs
  of `.js` scripts from the root directory of the same domain, without parameters (Monaco workers, `new Worker(new URL(...))`,
  the bundler requires exactly this form). The only exception, only in development mode (`isDevMode()`, i.e.
  `ng serve`): the `?worker_file&type=module` parameter that Vite appends to worker URLs. Works in browsers
  based on Chromium. In others the directive is ignored.
- The production build has `inlineCritical` disabled (`angular.json`): it inserted `<link onload="…">`, i.e. an inline script
  blocked by CSP, and the styles would not load.
- `main.ts` does not start the app inside a frame (`window.top !== window.self`). This is only a safeguard in case the
  `frame-ancestors` header is missing.

Backend requirements (the mock in `web/e2e/mock-api/` does the same, and the e2e tests check in every test that the page
reports no CSP violations):
- `index.html`: a `Content-Security-Policy` header with the same policy as `<meta>` plus `frame-ancestors 'none'`
  (it does not work in `<meta>`), `X-Frame-Options: DENY`,
- all responses: `X-Content-Type-Options: nosniff` (and a correct `Content-Type`), `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`. No `clipboard-read=()`:
  "Paste" from Monaco's context menu and command palette reads the clipboard via `navigator.clipboard` (with the user's permission),
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (in the backend or in the Cloudflare settings).
- A change of the policy in `<meta>` requires the same change in the backend header (the mock reads it from `index.html`).

## Files and editor

### Rules

- Paths in the API are **relative to the projects directory** (`/srv/projects`), with `/` slashes, e.g.
  `studia/lab-3-sieci/src/main.c`. An empty string is the projects directory itself. The frontend rejects paths with `..`,
  a leading `/` and `\` before sending, but **the real check is done by the backend**.
- The explorer shows the open repository (`ProjectContext.path`), and without one the whole projects directory.
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
- Shortcuts: Ctrl+S / Cmd+S saves the active file (also when focus is outside the editor, but not in the terminal).
  The middle mouse button closes a tab.
- After a file loads, the editor takes focus only when the user is not typing at that moment in another field, the console
  or the terminal (`isTypingElsewhere`). Otherwise the rest of the text typed e.g. in the console would end up in the file.
- **Diff view:** the "Pokaż zmiany" (Show changes) button next to the file path (for files in a repository) switches to the Monaco diff:
  on the left the version from HEAD (`GET /api/git/show`, read-only), on the right the same model as in the editor, so
  editing and saving work normally. A file that is not in HEAD is shown as new. On a narrow screen the diff
  switches to a single-column view. After changes from the console the HEAD version is loaded again (there may have been a commit).

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

## Console

### Rules

- The console is a conversation with Claude Code running on the server in the directory of the open repository
  (`ProjectContext.path`, without a repo: the whole projects directory). Every repository has its own conversation.
  The backend runs `claude -p --output-format stream-json --input-format stream-json` and translates the output
  into events from the contract below.
- **Look:** plain monospace text, without icons, colors, animations or the product name (a requirement from the mockup,
  enforced by an e2e test). Steps aligned with spaces as in a terminal.
- **All content (prompts, responses, command output, paths) is displayed only as text.** We do not
  render Markdown or HTML, so content from the model or from files cannot inject code into the page.
- The conversation lives on the server. A page reload, another tab or another device replays it via
  `GetConversation` and sees further events live. Collapsing the panel does not interrupt the work.
- A prompt appears in the conversation only as a `prompt` event from the server (a single source of truth for all tabs).
- When the console changes files (`files-changed`), the explorer, the git status and the repository list refresh,
  clean open files are reloaded, and files with unsaved changes get the message
  "Plik zmienił się na dysku (konsola lub pull)" (The file changed on disk (console or pull)).
- A dropped connection checks the session immediately (`AuthService.verifySession`). An expired session ends as on a 401.
- From sending a prompt (or a "new conversation") until the server responds, another send is blocked
  (`ConsoleStore.sending`): a second Enter during `StartConversation` will not create a second conversation or send the
  prompt twice.
- Shortcuts in the prompt field: Enter sends, Shift+Enter new line, Esc interrupts the work. The field has
  spellcheck and autocorrect disabled (`spellcheck="false"` etc.), so that the prompt content (code, secrets) does not go
  to the spellcheck services of the browser or of extensions.
- **Permission requests must show exactly what the user is agreeing to:**
  - the command and the rule are shown via `revealHidden`: control characters (including a lone `\r`), text direction characters
    (e.g. U+202E), zero-width characters, unusual spaces (e.g. NBSP) and blank characters (e.g. U+2800, Hangul fillers,
    variation selectors) as `⟨U+XXXX⟩`, and a run of the same character as `⟨U+XXXX ×N⟩`, a tab as `⟨TAB⟩`,
    runs of 4+ spaces and tabs as `⟨N odstępów⟩`, runs of 2+ blank lines as `⟨N pustych linii⟩`,
    with wrapping (`pre-wrap`, `overflow-wrap: anywhere`), so neither the middle nor the tail of the command can hide outside the panel.
    Under a command with multiple lines or longer than 200 characters there is "Komenda ma N linii/znaków. Przeczytaj całą
    powyżej." (The command has N lines/characters. Read all of it above.), and a question taller than the log is shown from the top (not from the buttons at the bottom).
    Step targets (`step.target`) are shown the same way,
  - the permission buttons ("tak" (yes), "tak, zawsze" (yes, always)) are disabled for 600 ms after the question appears
    (`PERMISSION_ARM_MS`, counted anew in each conversation). The question arrives asynchronously and scrolls the log, so a click meant for
    something else could hit "tak". "nie" (no) works immediately,
  - "tak, zawsze" is present only when the server provided a rule (`alwaysRule`), it shows the rule and requires confirmation.

### `/hubs/console` hub contract (to be implemented in the backend)

Connection: SignalR, WebSocket only, no negotiation (`skipNegotiation`), JSON protocol. Requires a session
(cookie) and **a check of the `Origin` header** when opening the WebSocket. Without a session: the connection is rejected.

Session on an open connection (SignalR itself does not check the cookie again, so the backend does it):
- **every hub method call checks the session** (hub filter). Expired or revoked: an error and the connection is closed,
- **a session's connections are closed the moment it ends**: logout, revocation (also from the "Bezpieczeństwo" window),
  idle expiry and the hard limit. The server detects expiry by itself (e.g. a timer per connection or
  a check every few seconds), it does not wait for an HTTP request,
- hub calls **do not extend the session** (only `POST /api/auth/keepalive` extends it).

Methods called by the client:

| Method | Arguments | Result |
|---|---|---|
| `GetConversation` | `projectPath` | `{ conversationId \| null, events: ConsoleEvent[] }`: the latest conversation in the project as a list of events |
| `StartConversation` | `projectPath` | `conversationId`. The server also broadcasts a `conversation` event |
| `SendPrompt` | `{ conversationId, text, model, effort, mode }` | none. An error when the conversation is busy |
| `AnswerPermission` | `{ conversationId, requestId, decision }` | none. `allow-always` only for a question with `alwaysRule` (otherwise an error) and saves exactly that rule |
| `Interrupt` | `{ conversationId }` | none. Interrupts the work, treats a pending permission request as a denial |

Option values: `model` = `opus` / `sonnet` / `haiku`, `effort` = `low` / `medium` / `high` / `max`,
`mode` = `default` / `acceptEdits` / `plan` (CLI permission modes), `decision` = `allow` / `allow-always` / `deny`.

Events sent by the server with the `ConsoleEvent` method to all of the user's connections
(all with `conversationId`, full types in `console-protocol.ts`):

| `type` | Fields | Meaning |
|---|---|---|
| `conversation` | `projectPath`, `startedAt` | a new conversation in the project |
| `prompt` | `text` | the user's prompt |
| `step` | `stepId`, `kind` (`read`/`edit`/`write`/`command`/`search`/`other`), `target`, `added?`, `removed?` | a work step. `target` is the text to display: a path relative to the conversation's repository or a command |
| `step-output` | `stepId`, `text`, `isError` | step output, e.g. a command result |
| `text` | `messageId`, `delta` | a fragment of the response (subsequent fragments with the same `messageId` are appended) |
| `permission` | `requestId`, `description`, `alwaysRule?` | a permission request. `requestId` is unique for the whole server lifetime (e.g. a GUID), not a number counted anew in each `claude` process. `description` is **exactly what the permission is for**: for a command the whole command (not a description written by the model), for an edit the file path, e.g. `git push origin main`. `alwaysRule`: the rule that an `allow-always` answer will save (e.g. `Bash(git push:*)`, saved in the project's `.claude/settings.local.json`). Without it the frontend does not offer "tak, zawsze" |
| `permission-resolved` | `requestId`, `decision` | the answer to the question (also from another tab) |
| `status` | `state` (`idle`/`working`/`waiting`/`error`), `message?` | work state. `message` is shown as a note |
| `files-changed` | `paths` (relative to the projects directory) | files changed by the console |

## Workspaces and git

### Rules

- A **workspace** is a top-level directory in the projects directory (e.g. `studia`), with a display name
  (e.g. "Studia"). A **repository** is a directory with a git repository directly in the workspace
  (e.g. `studia/lab-3-sieci`). The source of truth is the file system, not the database.
- The open repository is in the page URL (`/?repo=studia%2Flab-3-sieci`). A page reload stays
  in the same repo, and after session expiry `returnUrl` returns to it after login.
- Opening a repository sets: the explorer directory, the console directory and conversation, the git status (top bar,
  status bar, badges in the explorer). **Open editor tabs stay** (their paths are full).
- Explorer badges as in VS Code: `M` modified, `A` added, `D` deleted, `R` renamed,
  `U` untracked, `!` conflict, `•` a directory containing changes.
- The git status and the repository list refresh: after opening a repo, after a save in the editor, after changes from the console,
  after pull / push / clone, after "Odśwież" and after returning to the browser tab.
- Pull changes files on disk: the response contains `changedPaths`, so the editor reloads clean files,
  and for unsaved changes shows a message, as with changes from the console.
- Commits are made via the console or the terminal. The panel has only Otwórz / Pull / Push (Open / Pull / Push) (as in the mockup).
- Cloning only from `https://` URLs in strict form: `https://host[:port]/path`, where host is
  `[a-z0-9.-]`, and path segments are `[A-Za-z0-9._~-]` (the `CLONE_URL` expression in `validation.ts`), and in
  canonical form (`new URL(adres).href` equal to the URL, so no `..`, no port 443, no uppercase letters in the host).
  No username and password (the token would end up in `.git/config`) and no `@`, `\`, `%`, `?`, `#`, spaces: different parsers
  read them differently, e.g. in `https://github.com\@evil.com/r` the browser and .NET see the host `github.com`,
  while git and curl see `evil.com`. The frontend checks this before sending and sends exactly the checked string,
  the backend must check the same.
- Git messages from the server (`message`) are displayed only as text.

### API contract (to be implemented in the backend)

All endpoints require a session (otherwise `401`). `POST` requires the XSRF header.
Errors have a `{"message"}` body with a description (e.g. git output), which the frontend shows under its own message.

| Method | Path | Response |
|---|---|---|
| GET | `/api/workspaces` | `200 [{"name","path","repoCount"}]` in display order |
| POST | `/api/workspaces` | body `{"name"}`. `201 {"name","path","repoCount":0}`. Name: letters, digits, spaces, `-`, `_`, up to 40 characters. Directory: lowercase, Polish characters replaced with Latin ones (`ł`→`l`), spaces with `-`. `400` bad name, `409` directory exists |
| GET | `/api/repos?workspace=<katalog>` | `200 [RepoSummary]`. `404` when the workspace does not exist |
| POST | `/api/repos/clone` | body `{"workspace","url"}`. `201 RepoSummary`. Directory name from the last URL segment without `.git`, it must match `^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$` (so not `.`, `..`, `.git` or `-…`). `400` bad URL or name, `404` no workspace, `409` directory exists, `502` git error (e.g. no repository) |
| GET | `/api/git/show?repo=<repo>&path=<plik>` | `200 {"content"}`: the file content in HEAD (for the diff view). `404` when the file is not in HEAD. `400` when `path` is not inside `repo` |
| GET | `/api/git/status?repo=<repo>` | `200 {"branch","ahead","behind","files":[{"path","status"}]}`. `status`: `modified`/`added`/`deleted`/`renamed`/`untracked`/`conflicted`. Untracked files individually (`--untracked-files=all`). `404` when it is not a repository |
| POST | `/api/git/pull?repo=<repo>` | `git pull --ff-only`. `200 {"message","changedPaths"}`. `409` when it cannot fast-forward or local changes would be overwritten. `400` no remote branch, `502` remote repository error |
| POST | `/api/git/push?repo=<repo>` | `200 {"message"}` (without an upstream: `git push -u origin HEAD`). `409` rejected (pull first). `400` no remote repository, `502` other remote error |

`RepoSummary`: `{"name","path","branch" | null,"changes","upstream" | null,"ahead","behind","lastCommit": {"message","date"} | null}`.
Paths (`path`, `files[].path`, `changedPaths`) are always relative to the projects directory.

Security requirements for the backend:
- `workspace` and `repo` are checked like file paths (inside the projects directory, also after resolving symlinks).
  `repo` must be a repository directly in the workspace.
- Git runs without a shell, with arguments as a list. The clone URL goes after `--`, URLs
  starting with `-` are rejected. Only the https protocol (`-c protocol.allow=never -c protocol.https.allow=always`).
- The clone URL is checked with the same strict rule as in the frontend (see "Rules"), and git gets exactly
  that string. The directory name from the URL is checked as in the contract, and the target path after resolution must lie
  directly in the workspace directory.
- The GitHub token lives outside the repository and outside the remote URL (credential helper), with access only to selected repos.
  The helper is bound only to the GitHub host (`credential.https://github.com.helper`), so the token never goes
  to another server. `GIT_TERMINAL_PROMPT=0`.
- A timeout for git network operations.

## Terminal

### Rules

- Every terminal is a **tmux session on the server**, running as the `workspace` user in the directory of the open
  repository (without a repo: in the projects directory). It lives on after closing the tab, reloading the page
  and switching tabs. It ends only with "×" (with confirmation, because it kills running processes) or `exit`.
- The Terminal tab connects to the hub only when first opened. With no terminal at all it opens the first one right away.
- **Attaching without gaps or duplicates:** `Attach` returns a snapshot (screen + history with ANSI sequences) and the `seq` number
  of the last fragment included in it. Output fragments that arrive during attaching are buffered,
  and those with `seq` not greater than in the snapshot are skipped. After reconnecting to the hub every view attaches again.
- **Typed characters are neither lost nor duplicated** (`TerminalInputQueue` in `terminal-input.ts`, one queue per
  terminal in `TerminalStore`, so it survives closing the panel): they go in batches via `invoke`, one at a time,
  and the server acknowledges receipt. What was typed during sending or while the connection was down waits in the queue
  and goes after reattaching. An unacknowledged batch is sent again with the same `seq`, and the server skips batches
  it already has (`client` + `seq`). `Attach` returns the number of the last accepted batch (`inputSeq`), so a batch that
  arrived before the connection dropped is acknowledged immediately. Without this, a dropped connection could lose the middle
  of a command, and an Enter typed after returning ran its beginning (e.g. `rm -rf ./` instead of `rm -rf ./build/cache`).
  - Characters waiting less than 5 s go right after attaching. Those waiting longer (and only those that certainly did not
    arrive: excluding the batch that is currently in flight) are held in the queue itself (`holdIfStale`, no send loop
    can bypass it) and wait for a decision in the panel above the terminal ("Wyślij" (Send) / "Porzuć" (Discard), preview via
    `previewText`). This is not a `confirm` window: it would freeze the page, including the session countdown, and it appears without
    user involvement. Characters typed in the meantime are appended to the question.
  - The queue has a 64 KB limit. Once it is exceeded, further characters (including Enter) are rejected until the queue empties
    (the block applies only when something is waiting). A paste longer than the limit minus a margin for the paste
    mode markers (16 characters) is rejected with a message.
  - While disconnected, the view shows "Brak połączenia. Wpisane znaki zostaną wysłane po ponownym połączeniu." (No connection. Typed characters will be sent after reconnecting.)
    When the automatic connection attempts run out, the panel shows "połącz ponownie" (reconnect) (the console does the same), and the views
    reattach (`TerminalStore.reattach`) right after connecting. Without a connection the view is not attached
    (characters wait, output waits in the buffer), so nothing goes out before `Attach` and the holding back of stale characters.
- **Pasting** has its own handling (before xterm's handling): it removes control characters except tab and line endings
  (ESC could end the paste mode `\x1b[201~` and run the rest of the text, `^C`, `DEL` etc. would act as keys)
  and C1 characters. Text with line endings (each one can run a command right away) waits for a decision in the panel above
  the terminal ("Wklej" (Paste) / "Anuluj" (Cancel), focus on "Anuluj", so neither Enter nor Esc will paste anything) with a full preview
  (`previewText`: hidden characters made visible, long text shortened only with an explicit "⟨pominięto N linii/znaków⟩" (⟨omitted N lines/characters⟩), always
  with the beginning and the end). Not a `confirm` window: Chrome truncates long text in it without warning.
- **OSC 8 links are disabled** (a custom handler for OSC 8 sequences takes them over): the visible link text could impersonate
  a different URL. The text itself is displayed. Plain URLs in the text are not clickable either (no web-links addon).
- After attaching, the terminal takes focus only when the user is not typing somewhere else at that moment
  (`isTypingElsewhere`), e.g. in the console field: otherwise the rest of the prompt with Enter would end up in the shell.
- The terminal size fits the panel (FitAddon + ResizeObserver) and goes to the server (`Resize`).
- **Ctrl+S in the terminal belongs to the terminal** (e.g. saving in nano), not to the editor. Browser shortcuts
  (e.g. Ctrl+W, Ctrl+T) still work in the browser and cannot be intercepted.
- Security on the browser side: no clipboard addon (OSC 52), so a program in the terminal cannot write
  anything to the clipboard, and no OSC 8 links. The terminal content disappears from memory on logout (full page reload).
- Font: first `JetBrainsMono Nerd Font` (icons from the dotfiles prompt, if the font is installed
  on the device), then `JetBrains Mono` and monospace.

### `/hubs/terminal` hub contract (to be implemented in the backend)

Connection as in the console: SignalR, WebSocket only, no negotiation, JSON, requires a session and an `Origin` check,
the session is checked on every call, and connections are closed when the session ends (including expiry). This is the most powerful part of the portal (a full shell), so the rules from "Security"
in `PLAN.md` (a separate user, systemd sandbox) are especially important here.

| Method | Arguments | Result |
|---|---|---|
| `ListTerminals` | none | `TerminalInfo[]` (`{ id, title, cwd, exited }`) |
| `OpenTerminal` | `{ projectPath, cols, rows }` | `TerminalInfo`. `projectPath` is checked like file paths. `title` is unique, e.g. `lab-3-sieci (2)` |
| `Attach` | `{ id, cols, rows, client }` | `{ snapshot, seq, inputSeq }`. Also sets the size. `inputSeq`: the number of the last `Input` batch accepted from `client` (0 when none). The connection that performed `Attach` becomes the only one from which the server accepts `Input` of that `client` for that terminal. The server handles `Input` and `Attach` of one terminal in order |
| `Input` | `{ id, client, seq, data }` | none (called via `invoke`, the result acknowledges receipt). Raw data from xterm, e.g. `\r`, `\x03`. `client`: a random view ID, `seq`: the batch number of this `client` (grows by 1, gaps allowed). A batch with `seq` not greater than the last one accepted from this `client` is skipped without an error. A batch from a connection that is not the last one on which this `client` performed `Attach` is rejected with an error (a late batch from an old connection will not run after "Porzuć", and a new connection must attach first). Unknown or exited terminal: the data is skipped without an error. A batch holds up to 4096 characters |
| `Resize` | `{ id, cols, rows }` | none (`send`) |
| `CloseTerminal` | `{ id }` | none. Kills the tmux session |

Server events to all of the user's connections to this hub:

| Method | Argument | Meaning |
|---|---|---|
| `TerminalOutput` | `{ id, seq, data }` | an output fragment, `seq` grows by 1 for each fragment of a given terminal |
| `TerminalExited` | `{ id, exitCode }` | the shell exited. The terminal stays on the list with `exited: true` until it is closed |

## Backend

Endpoints:

| Method | Path | Description | Authorization |
|---|---|---|---|
| GET | `/api/health` | checks whether the API is running | none |
| GET | `/api/auth/me` | current session, always a fresh `XSRF-TOKEN` | none (401 without a session) |
| POST | `/api/auth/login` | password + TOTP, creates a session | none, XSRF token |
| POST | `/api/auth/keepalive` | the only request that extends a session (idle deadline, never past the absolute one) | session, XSRF token |
| POST | `/api/auth/logout` | ends the session on the server (optionally only if the cookie still belongs to `{sessionId}`, otherwise 409), expires the cookies | session, XSRF token |
| DELETE | `/api/auth/sessions/{id}` | ends another active session of the user; 404 for unknown, ended or expired, 400 for the own one | session, XSRF token |
| GET | `/api/auth/sessions` | active sessions of the user, newest first, `current` for this one, `device` as e.g. "Chrome · Linux" | session |
| POST | `/api/auth/sessions/revoke-others` | ends every other active session of the user | session, XSRF token |
| GET | `/api/auth/logins` | the last 20 login attempts, newest first | session |

Every other endpoint requires a session (`FallbackPolicy`), and every POST/PUT/PATCH/DELETE under `/api` a valid
`X-XSRF-TOKEN` (filter `RequireXsrfToken` in `Auth/AuthEndpoints.cs`, 400 otherwise).

All `/api/*` responses have `Cache-Control: no-store`. An unknown `/api/*` path gives 401 without a session and 404
with one. Unhandled errors give 500 as `application/problem+json`, without details outside Development.

Configuration:

| Key | Where | Meaning |
|---|---|---|
| `ConnectionStrings:Claushh` | development: `dotnet user-secrets`; server: variable `ConnectionStrings__Claushh` | PostgreSQL from `deploy/docker-compose.yml` |
| `Sessions:IdleTimeout`, `Sessions:AbsoluteTimeout` | `appsettings.json` | `00:30:00` and `12:00:00` |
| `Sessions:SecureCookies` | `appsettings.json` (`true`), `appsettings.Development.json` (`false`) | `false` only for plain http in development: cookie names without `__Host-`, `Secure` only on HTTPS |

Sessions (`Auth/`):
- Table `Sessions`: public `Id` (the `sessionId` of `/me`, constant for the life of the session), `SecretHash`
  (SHA-256 of the random 32-byte secret from the cookie, unique), `CreatedAt`, `LastActivityAt`, `IdleExpiresAt`
  (never past `AbsoluteExpiresAt`), `AbsoluteExpiresAt`, `RevokedAt`, `Device` (User-Agent), `Ip`. Rows stay after logout
  and are deleted 90 days after the session ended (`AuthCleanup`, at start and every hour), like login attempts older
  than 90 days.
- A session is active when it is not revoked and both deadlines are in the future. Only `keepalive` moves `IdleExpiresAt`;
  reading a session (`SessionAuthenticationHandler`, `/me`) never extends it. All time comes from `TimeProvider`.
- Cookies, all `SameSite=Strict; Path=/`: `__Host-claushh-session` (the secret, `HttpOnly`, no `Expires`),
  `__Host-claushh-af` (antiforgery cookie token, `HttpOnly`), `XSRF-TOKEN` (request token that Angular sends back in
  `X-XSRF-TOKEN`). With `Sessions:SecureCookies=false`: `claushh-session`, `claushh-af`, and `Secure` only on HTTPS.

Login protection (`Auth/`):
- TOTP codes are checked by `TotpVerifier` against `TimeProvider`: the 30 s step of now, the one before and the one
  after. A code is accepted once: the last accepted step is stored in `AspNetUserTokens` (`Claushh` / `TotpLastStep`),
  and a code from that step or an earlier one is rejected. `create-user` checks its code the same way, so that code is
  used up and the first login needs the next one.
- Every attempt that reaches the check of the credentials is recorded in `LoginAttempts` (`At`, `Ip`, `Device` as the
  User-Agent cut to 256 characters, `Success`), also for unknown names; the typed user name never. Attempts answered
  with `429` are not recorded. Attempts are deleted after 90 days (`AuthCleanup`).
- 10 failures from one IP within 15 minutes give `429` with `Retry-After` (seconds until the 10th most recent failure
  leaves the window), with an empty body. The IP is the connection address; behind Cloudflare Tunnel it becomes the
  real one only with `ForwardedHeaders` (stage 1, part C).
- 5 wrong or reused codes after a correct password lock the account (`AccessFailedCount` and `LockoutEnd` of
  `AspNetUsers`, written by `LoginGuard`; Identity's own lockout methods use the real clock): for 15 minutes the first
  time, twice as long for every further lock in a row, at most 24 hours (the number of locks in a row is the token
  `Claushh` / `LockoutsInARow` in `AspNetUserTokens`). While it is locked every login gets `429` with `Retry-After`,
  whatever the name and password; when both limits apply, `Retry-After` is the later end. A successful login resets
  both counts; `create-user --reset-totp` and `--reset-password` also clear the lockout.
- Logins run one at a time (`LoginGuard.EnterAsync`), so the checks and writes of parallel attempts never interleave.

Commands (`dotnet run --project src/Claushh.Api -- <command>`, on the server `./Claushh.Api <command>`):

| Command | What it does |
|---|---|
| `create-user` | creates the single account: user name, password (at least 12 characters, no echo), TOTP key and `otpauth://` URI, switched on only after a correct code; refuses when an account exists |
| `create-user --reset-totp` | a new TOTP key for the existing account (after a correct code), all its sessions ended and the lockout cleared |
| `create-user --reset-password` | a new password for the existing account (at least 12 characters, no echo, typed twice), all its sessions ended and the lockout cleared; the TOTP key stays |

Migrations: `dotnet tool restore`, then
`ASPNETCORE_ENVIRONMENT=Development dotnet ef migrations add <Name> --project src/Claushh.Api --output-dir Data/Migrations`.
`migrations add` does not connect to the database; without a user-secret, pass any connection string in
`ConnectionStrings__Claushh`.

Planned folder layout in `src/Claushh.Api/` (created together with the code they concern):
`Auth/` (Identity, TOTP, sessions), `Data/` (DbContext, migrations), `Files/` (files API and path protection),
`Console/` (the `claude` process, MCP for permissions), `Terminal/` (PTY, tmux), `Git/`, `Hubs/` (SignalR).

## Frontend

Conventions:
- Standalone components, local state in `signal()`.
- Things shared by the whole app (auth, browser access, API clients, SignalR, the open project,
  Polish texts) go in `web/src/app/core/`.
- Each app feature in a separate folder `web/src/app/features/<nazwa>/`, lazy-loaded from the routes.
- Colors and fonts only through the variables from `styles.scss`, no hard-coded colors in components
  (exceptions to be removed when the palette is refined).

Dependencies besides Angular: `monaco-editor` (editor), `@microsoft/signalr` (console, terminal),
`@xterm/xterm` and `@xterm/addon-fit` (terminal; the xterm styles are in the global styles in `angular.json`).
Development: `@playwright/test`, `ws` (hub mock), `@types/node`.

## Tests

Rules: `CLAUDE.md`, section "Tests" (new code: only integration and e2e tests).

| Kind | Command | What it covers |
|---|---|---|
| Integration + older unit | `cd web && npm test` | Vitest (jsdom). Integration: `console.integration.spec.ts` (panel + store + editor, SignalR and HTTP stubbed; also permission requests: hidden characters, button delay, "tak, zawsze", and a double Enter), `workspaces.integration.spec.ts` (Workspace panel + router + git status + explorer + editor, HTTP stubbed; also the strict clone URL validation), `security.integration.spec.ts` (AuthService + interceptor + SessionTimer + the "Bezpieczeństwo" window, HTTP, reload and clock stubbed; also expiry without a server response), `logout-confirmation.integration.spec.ts` (routes with guards + AuthService + login screen after an unconfirmed logout, also with a newer session from another tab). Older unit tests: auth, files API, paths, explorer, `EditorStore` |
| E2E | `cd web && npm run e2e` | build + Playwright in Chromium on `e2e/mock-api/server.mjs`: login and sessions (including unconfirmed logout with "Back", a new tab and logging in again, embedding in a frame, Trusted Types), explorer and Monaco, console (steps, options, permissions, "tak, zawsze", interrupt, replay, multiple tabs, file changes), workspaces (opening a repo, git status, pull, push, create, clone, a conversation per repo), terminal (commands, keys, reload without duplicates, multiple terminals, `exit`, Ctrl+S, resizing, pasting with the decision panel, characters on a dropped connection without loss or duplication, also after closing the tab, queue limit, focus, OSC 8 links), session (countdown, "Przedłuż", activity once a minute on a fake clock, expiry, also without a server response and hubs closed by the server), the "Bezpieczeństwo" window with a second device (a separate browser context), diff view, Monaco worker startup, mock robustness and the contract rules that the frontend does not let through (clone URL, XSRF token bound to the identity). **Every test** (`fixtures.ts`) fails when the page reports a CSP or Trusted Types violation, an unhandled exception (including one caught by Angular's ErrorHandler, `console.error('ERROR', …)`) or Monaco does not create a worker |
| Backend | `dotnet test` (needs Docker) | xUnit integration tests over HTTP (`WebApplicationFactory`, PostgreSQL 17 from Testcontainers, a test clock): login and its failures, `me`, `keepalive` and both deadlines, logout and 409, ending another session, XSRF token bound to the session, `no-store`, closed `/api/*`, `create-user`, TOTP codes used once, the limit per IP, the account lockout and its growth, session list, `revoke-others`, login history, cleanup, the password reset |

Notes on e2e:
- The mock has one shared state, the tests run sequentially and start with `POST /__test/reset`. It listens only on
  `127.0.0.1` (the `/__test/*` endpoints have no authentication), and a malformed request ends with `400`, not a crash.
- E2E files import `test` and `expect` from `./fixtures`, not from `@playwright/test`.
- Failures on demand: `POST /__test/drop-sockets` (drops the hub connections without ending the session),
  `POST /__test/fault?dropInputAck=N&downAfterDropMs=D&attachDelayMs=M&hubDownMs=K` (loss of `Input` acknowledgments
  with a D ms outage, a slow `Attach`, hubs unavailable for K ms).
- A second browser ("second device") via the `newDevice` fixture, so that it is also under CSP control.
- The session idle time in the mock can be shortened: `POST /__test/session-timeout?idle=<s>`.
- Git in the mock is simulated: the "committed" state is the file content from the reset, the status is the difference from it.
- Browser: `npx playwright install chromium` or the `CHROMIUM_PATH` variable pointing to the system Chromium.
- Monaco and xterm display spaces as `\u00a0`. `helpers.ts` → `editorText` and `terminalText` normalize the text.
- `CodeEditor` (Monaco) and `TerminalView` (xterm) do not work in jsdom, so they are tested only in e2e.
