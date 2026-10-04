# Architecture and code map

This file describes the **current state of the code**: what lives where and how the parts talk to each other.
Goals and decisions are in [`PLAN.md`](PLAN.md). After every change to the structure, a new module, endpoint
or dependency, update the relevant section.

Status: frontend done (login, session countdown and the "Bezpieczeństwo" (Security) window, explorer, editor with diff view,
console, workspaces and git, terminal). The backend has login, sessions, login protection and notifications, the
client IP behind Cloudflare, the built frontend with the security headers, the files API (listing, reading and
saving), the workspaces and git API and the terminal hub (section "Backend"); the console hub is still only in the
mock.
The frontend is tested against a mock backend (`web/e2e/mock-api/`) that follows the contracts below.

## Flow

```
Browser (Angular, web/)
   │  HTTPS + WebSocket (SignalR)
Cloudflare Access (one-time PIN by e-mail) + Cloudflare Tunnel    [stage 1]
   │  cloudflared on the server → http://127.0.0.1:5090
ASP.NET Core API (src/Claushh.Api)
   ├─ PostgreSQL (deploy/docker-compose.yml, localhost only; server: project claushh-prod)    [stage 1]
   ├─ files / git  → /srv/projects                              [stage 2, 4]
   ├─ terminal     → tmux in control mode (tmux -C)              [stage 4]
   └─ console      → `claude` process (stream-json)             [stage 3]
```

In development mode, Angular (`npm start`, port 4200) proxies `/api` and `/hubs`
to the API at `http://localhost:5080` (`web/proxy.conf.json`).
With `Frontend:Root` set (README.md, "Running the built frontend"), the API serves the built frontend itself, as on the
server: one process and one origin.

On the server (decisions: `PLAN.md`, "Deployment decisions"):
- `claushh.service` runs the API as the user `workspace` on `http://127.0.0.1:5090`, from `/opt/claushh/api`, serving
  `/opt/claushh/web`; `cloudflared.service` connects the tunnel; `claushh-backup.timer` dumps the database daily into
  `/var/backups/claushh`. `deploy/install.sh` installs the build and the units (`README.md`, "Deployment").
- PostgreSQL is the compose project `claushh-prod` on `127.0.0.1:5435` (`/opt/claushh/deploy/docker-compose.yml`).
- `/opt/claushh` (the API, the frontend build, `deploy/`) belongs to root; `/etc/claushh` (root only) holds
  `claushh.env` (the unit's install-specific settings and secrets) and `compose.env` (the compose variables);
  `/srv/projects` belongs to `workspace`; the tmux socket is in `/run/claushh`.
- The console runs `/home/workspace/.local/bin/claude` (Anthropic's installer, updates off; `Console__ClaudePath` in the
  unit), logged in once in `/home/workspace/.local/state/claushh/claude` (`README.md`, "Deployment" → "The console").

## Repository map

| Path | Contents |
|---|---|
| `Claushh.slnx` | .NET solution (XML format) |
| `Directory.Build.props` | shared settings for the .NET projects: `net10.0`, nullable, warnings as errors |
| `src/Claushh.Api/` | ASP.NET Core backend |
| `src/Claushh.Api/Program.cs` | app configuration and endpoint mapping |
| `src/Claushh.Api/Properties/launchSettings.json` | development profile, port 5080 |
| `src/Claushh.Api/Data/` | `ClaushhDbContext` (Identity tables, `Sessions`, `LoginAttempts`, `Workspaces`, and the console's `Conversations`, `ConversationEvents` and `ConsoleRules`) and EF Core migrations, applied at startup |
| `src/Claushh.Api/Auth/` | login: `Session`, `AuthSessionOptions`, `AuthCookies` (cookie names), `SessionService` (the only code with session rules), `SessionAuthenticationHandler` (cookie → user, never extends), `SessionAntiforgeryData` (XSRF token bound to the session), `TotpVerifier` (TOTP codes, each accepted once), `LoginGuard` (the client address and its limit key, limit per IP, account lockout, login history), `LoginAttempt`, `DeviceName` (User-Agent for storage and display), `AuthEndpoints` (`me`, `login`, `keepalive`, `logout`, XSRF filter), `SessionEndpoints` (session list, ending sessions, login history), `CreateUserCommand` (`create-user`), `AuthCleanup` (hourly deletion after 90 days) |
| `src/Claushh.Api/Files/` | files: `ProjectsOptions` (`Projects:Root`), `ProjectPaths` (the only code that turns an API path into a path on disk: syntax, symlinks resolved with `realpath`, `.git` refused, file types from `statx`), `Libc` (the four libc calls: `realpath`, `statx`, `access`, and `prctl` to make the process non-dumpable), `FileStore` (reading and saving: versions, the 5 MB limit, the text rule `DecodeText`, atomic saves under a per-file lock), `FileEndpoints` (`/api/files/*`) |
| `src/Claushh.Api/Workspaces/` | workspaces: `Workspace` (entity: display name and creation time), `WorkspaceNames` (the name rule and the directory made from a name), `CloneUrl` (the frontend's clone URL rule in .NET terms), `WorkspaceStore` (what a workspace is, the list in display order, creating one), `WorkspaceEndpoints` (`/api/workspaces`, `/api/repos`, `/api/repos/clone`) |
| `src/Claushh.Api/Git/` | git: `Repositories` (what a repository is and its state, read with LibGit2Sharp: the repository list, the status, HEAD content), `GitOptions` (`Git:NetworkTimeout`, `Git:Environment:*`), `GitRunner` (the git CLI: safety options, environment through `ChildEnvironment`, output, time limits, killing the process tree), `RepoLocks` (one lock per repository), `BackgroundFetch` (the fetch after `GET /api/repos`, at most every 5 minutes per repository), `GitEndpoints` (`/api/git/*`: status, show, pull, push) |
| `src/Claushh.Api/Hubs/` | SignalR hubs and what they share: `HubsOptions` (`Hubs:AllowedOrigins`), `HubOrigins` (the Origin check for `/hubs`), `HubSessionFilter` (the session on connect and on every call, never extended), `HubConnections` (open connections by session), `HubSessionSweep` (closes the connections of ended sessions every 5 s and right after a logout or revocation), `TerminalHub` (`/hubs/terminal`), `ConsoleHub` (`/hubs/console`) |
| `src/Claushh.Api/Terminal/` | terminal: `TerminalOptions` (`Terminal:SocketDirectory`, `Terminal:Environment`), `TmuxServer` (the API's own tmux server: version check, socket and configuration, tmux processes with the allowlisted environment), `TmuxControlClient` (one `tmux -C`: its output read as bytes, replies matched to commands), `TerminalSession` (one terminal: output with `seq`, Attach, Input, Resize), `TerminalSnapshot` (the Attach text), `Terminals` (the terminals in creation order, titles, the limit; prepares and ends the tmux server) |
| `src/Claushh.Api/Processes/` | `ChildEnvironment` (a clean, allowlisted environment for a child process: `GitRunner`, the terminal and the console) |
| `src/Claushh.Api/Frontend/` | the built frontend and the response headers: `FrontendOptions` (`Frontend:Root`), `FrontendFiles` (the files of the build, the `index.html` fallback, the CSP read from the page, cache rules), `SecurityHeaders` (the headers of every response, `no-store` on `/api`) |
| `src/Claushh.Api/Notifications/` | phone notifications: `NotificationsOptions` (`Notifications:NtfyUrl`, `Notifications:NtfyToken`), `LoginNotifications` (the queue of login and lock messages and the background service that sends them to ntfy) |
| `src/Claushh.Api/Claude/` | the console ("Backend" → "Console"): `ConsoleOptions` (`Console:*`), `ClaudeCli` (the claude CLI: config directory, version check, allowlisted environment), `Conversation`, `ConversationEvent`, `ConsoleRule` (entities), `ConversationLog` (the console's tables), `ConsoleEvents` (the contract's events as JSON), `PromptOptions` (model, effort, mode), `ClaudeProcess` (one process: JSON lines, stdin under a lock, control replies, killing its tree), `Turn` (one turn's state), `StreamJson` (reading stream-json), `PermissionRequests` (what a question shows, its one rule, the CLI's answer), `FileChanges` (edit counts, changed files, the output cap), `ConversationCleanup` (deletion after 90 days), `Conversations` (conversations, their processes, turns and event log; checks the CLI before its first process; the hosted service that prepares the CLI's config directory, recovers, closes idle processes and stops) |
| `dotnet-tools.json` | local .NET tools: `dotnet-ef` (`dotnet tool restore`) |
| `tests/Claushh.Api.Tests/` | backend integration tests: xUnit, the API in memory (`WebApplicationFactory`), PostgreSQL 17 from Testcontainers (`ApiFactory`) |
| `tests/Claushh.FakeClaude/` | a stand-in for the `claude` CLI in the backend tests: replays scripted stream-json lines and logs what the API sent; scripts are made of the recordings in `tests/Claushh.Api.Tests/ConsoleRecordings/` |
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
| `web/src/app/features/security/` | the "Bezpieczeństwo" (Security) window: active sessions, login history, "Wyloguj pozostałe sesje" (log out other sessions) / "Wyloguj wszędzie" (log out everywhere) |
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
| `web/.npmrc` | every npm script runs Node with `--no-experimental-webstorage`: from Node 25 on, Node's own global `localStorage` (undefined without `--localstorage-file`) hides jsdom's in the Vitest tests |
| `deploy/docker-compose.yml` | PostgreSQL 17 on `127.0.0.1:${POSTGRES_PORT}` (default 5432); the compose project is `claushh-dev` in development and `claushh-prod` on the server |
| `deploy/.env.example` | template of the compose variables: development `deploy/.env`, server `/etc/claushh/compose.env` |
| `deploy/claushh.service` | the API's systemd unit: user `workspace`, `127.0.0.1:5090`, the generic settings, the sandbox |
| `deploy/claushh.env.example` | template of `/etc/claushh/claushh.env`, the unit's install-specific settings and secrets (key names and placeholders) |
| `deploy/cloudflared.service` | the tunnel's systemd unit: `cloudflared` with a dynamic user, the token as a credential |
| `deploy/claushh-backup.service`, `deploy/claushh-backup.timer` | the daily database dump (`backup.sh`), started by the timer |
| `deploy/backup.sh` | dump and restore of the production database (the container's `pg_dump -Fc`, 14 days kept), run as root |
| `deploy/podman-socket.conf` | user drop-in that moves the `podman.socket` of `workspace` into its home, where the API's unit sees it |
| `deploy/install.sh` | `build <dir>` (as you: the self-contained API, the frontend build, `deploy/`) and `install <dir>` (as root: the checks, a dump before an update, `/opt/claushh` replaced with the old copy kept as `*.previous`, the units, the restart and the health check) |
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
| Failed login | a generic message, the password and code fields are cleared. 429 shows the time from `Retry-After`, rounded up: "za 30 s." below a minute, "za 15 min." below an hour, "za 24 godz." above |
| Logout | `POST /api/auth/logout` (10 s limit) → storage cleanup → message to other tabs (`BroadcastChannel`) → reload to `/login?logout=ok`. When the server does not confirm: a marker with the session ID in `localStorage` and `/login?logout=unconfirmed` with a warning, and the screen retries the logout (0 s, 3 s, 10 s, then every 30 s) until the server confirms ("Wylogowano. Serwer potwierdził zakończenie sesji." (Logged out. The server confirmed the session ended.)) |
| 401 from another API endpoint | interceptor → the same as logout, target `/login?reason=expired&returnUrl=…`. Several simultaneous 401s give one reload |
| Logout in another tab | this tab also clears its state and reloads to the login screen with the same message (`logout=ok`, `logout=unconfirmed` or `reason=expired`) |
| "Back" after logout | the page from bfcache is reloaded, the guard sends you to `/login` |
| Countdown in the top bar | "Sesja wygasa za m:ss" (Session expires in m:ss). The last 2 minutes in yellow with a "Przedłuż" (Extend) button |
| Countdown reached zero | `GET /api/auth/me` every 10 s: 401 → as an expired session, 200 (e.g. extended in another tab) → new countdown. No response for longer than 30 s after the deadline → local expiry |
| Extension in one tab | other tabs get the new deadline via `BroadcastChannel` |
| "Wyloguj wszędzie" | one question (with the number of unsaved files) before anything else, then `POST /api/auth/sessions/revoke-others` and logout of this session without further questions |

### API contract

Implemented in the backend (section "Backend").

| Method | Path | Response |
|---|---|---|
| GET | `/api/auth/me` | `200 {"userName","sessionId","expiresIn","absoluteExpiresIn"}` (`sessionId`: the public session ID as in `/api/auth/sessions`, never the secret from the cookie, **constant for the whole life of the session**, also after `keepalive`: the frontend uses it to recognize whether the cookie still belongs to the session whose logout the server did not confirm; seconds until the idle expiry and until the hard limit) or `401`. **Does not extend the session.** **Always sets a fresh `XSRF-TOKEN` cookie** (also on 401, because it is needed for login) |
| POST | `/api/auth/login` | body `{"userName","password","totpCode"}`. `204` + session cookie, `401` on wrong credentials (without saying what was wrong), `429` with `Retry-After` (a login waits at most 10 s for the one before it, then `429` with `Retry-After: 10`), `400` on a bad XSRF token |
| POST | `/api/auth/logout` | body `{"sessionId"}` (optional). Invalidates the session **on the server** (not just the cookie) and closes its WebSockets, `204` with `Set-Cookie` expiring the session and XSRF cookies. `401` when the session no longer exists. `409` (and ends nothing) when `sessionId` is given and the cookie belongs to another session (a new login in the meantime). **No `Clear-Site-Data`**: Chrome then holds the response for up to several seconds (measured in e2e tests), and the frontend clears storage anyway |
| POST | `/api/auth/keepalive` | extends the session by the idle time (e.g. 30 min), no further than the hard limit (e.g. 12 h). `200 {"sessionId","expiresIn","absoluteExpiresIn"}`. **The only request that extends the session** |

#### Sessions and login history

| Method | Path | Response |
|---|---|---|
| GET | `/api/auth/sessions` | `200 [{"id","current","device","ip","createdAt","lastActivityAt"}]`, newest first. `id` is a public ID, **never the secret from the cookie**. `device` e.g. "Chrome · Linux" from the User-Agent header, `ip` from `CF-Connecting-IP` when the API's peer is the local `cloudflared` (loopback), otherwise the connection address; IPv4-mapped addresses as IPv4 |
| DELETE | `/api/auth/sessions/{id}` | ends another session (including its WebSockets). `204`, `404` unknown, `400` for your own session (that is what logout is for) |
| POST | `/api/auth/sessions/revoke-others` | ends all sessions except the current one. `204` |
| GET | `/api/auth/logins` | `200 [{"at","ip","device","success"}]`, the last 20, newest first, including failed attempts |

Backend requirements that follow from the frontend:
- session cookie: `HttpOnly; Secure; SameSite=Strict; Path=/`,
- `XSRF-TOKEN` cookie: **without** `HttpOnly` (Angular must read it), `Secure; SameSite=Strict; Path=/`,
- validation of the `X-XSRF-TOKEN` header on every POST/PUT/PATCH/DELETE, including login. The token is bound
  to the identity it was issued for (the backend adds the session ID through `IAntiforgeryAdditionalDataProvider`; ASP.NET alone binds it only to the user): a token issued for a session will not pass
  without it and vice versa (the mock does the same),
- every endpoint except `/api/health`, the three above and the built frontend (static files and the `index.html`
  fallback, the same files for everyone, no data) returns `401` without a session,
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

Backend requirements, as the API sends them (`Frontend/`). The mock in `web/e2e/mock-api/` sends a subset: the
`X-Frame-Options` and the CSP only with `index.html`, and no `Cache-Control` on the other files. The e2e tests check in
every test that the page reports no CSP violations.
- `index.html` (also as the fallback for the app's paths): a `Content-Security-Policy` header with the policy of its
  `<meta>` plus `frame-ancestors 'none'` (it does not work in `<meta>`). The API reads the policy from the served
  `index.html` once at start (it does not start without the `<meta>`), as the mock reads it on every request, so a
  change of the policy is made only in `<meta>`; the API needs a restart after such a build. Other files get no CSP
  header (the Monaco workers take their policy from their own response),
- all responses: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` (and a correct `Content-Type`),
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`. No `clipboard-read=()`:
  "Paste" from Monaco's context menu and command palette reads the clipboard via `navigator.clipboard` (with the user's permission),
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` comes from Cloudflare's HSTS setting, not from the API.

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

### Files API contract

Implemented in the backend (section "Backend"). All endpoints require a session (otherwise `401`). `PUT` requires the
XSRF header.

| Method | Path | Response |
|---|---|---|
| GET | `/api/files/list?path=<katalog>` | `200 [{"name","path","kind":"file"\|"directory"}]`. Without the `.git` directory. `404` when the directory does not exist |
| GET | `/api/files/content?path=<plik>` | `200 {"path","content","version"}`. `404` no file, `413` too large, `415` binary file |
| PUT | `/api/files/content?path=<plik>` | body `{"content","baseVersion"}`. `200 {"version"}` or `409 {"currentVersion"}` when the version on disk differs from `baseVersion`. `413` content too large, `415` content that is not text (a NUL character) |

Listing: it includes dotfiles such as `.gitignore`. It leaves out `.git` (a directory or a file), names that are not
valid API paths (a name containing `\`, or one that is not valid UTF-8), symlinks that lead outside the projects
directory, nowhere or in a loop, and special files (FIFOs, sockets, devices). A symlink that stays inside is listed
with its target's kind and keeps its own path. `400` for a path that leads outside the projects directory or into
`.git`, or that has a symlink that dangles or loops anywhere in it, also when its end does not exist: the status code
never tells whether something exists there. `404` also when the path is a file. A directory that cannot be read lists
as empty, and a path under a directory that cannot be searched is `404`.

Reading and saving:
- The version is opaque to the client, except `absent`: the version of a file that does not exist. A save with
  `baseVersion` `absent` creates the file when the name is free and its directory exists (`404` when the directory is
  missing). This is what "Nadpisz moją wersją" (Overwrite with my version) sends after the file was deleted: the `409`
  for the old version carries `{"currentVersion":"absent"}`. When the file exists after all, `absent` is a `409` with
  its real version. (The mock's other versions are a shortened SHA-1, the backend's are described in section "Backend".)
- At most 5 MB (5 × 1024 × 1024 bytes): a bigger file is `413` on read, and so is content that is bigger as UTF-8 (plus
  the BOM that is kept) on save.
- Only UTF-8 text: a NUL byte or invalid UTF-8 (so any other encoding, e.g. Windows-1250) is `415` on read. A save of
  content with a NUL character is `415` too and leaves the file unchanged, so the editor never writes a file it cannot
  read back (the frontend shows "Nie zapisano. To plik binarny, nie da się go wyświetlić jako tekst."). A UTF-8 BOM is
  not part of `content`; it is written back when the file on disk had one. Line endings are never changed.
- Two saves of one file with the same `baseVersion` give one `200` and one `409`. A save through a symlink changes the
  target and leaves the link. A change made from outside (the console, the terminal) is caught by the version check
  except in the time it takes to hash the file and rename it (section "Backend", "Files").
- A directory, FIFO, socket or device is `404` on read and `400` on save. A save without `content` or `baseVersion` is
  `400`. The endpoints' own error responses other than `409` have no body.

Common to all: `400` when the path is invalid, has a `.git` segment (before or after resolution) or, after resolution
(including symlinks), goes outside the projects directory. `index.html` is served with `Cache-Control: no-store`, and
the other files of the build, `monaco.css` among them, with `Cache-Control: no-cache` (the name `monaco.css` has no
hash, so after a Monaco update the browser must download the new version).

## Console

### Rules

- The console is a conversation with Claude Code running on the server in the directory of the open repository
  (`ProjectContext.path`, without a repo: the whole projects directory). Every repository has its own conversation.
  The backend runs one `claude -p` process per conversation with stream-json input and output (the command line is in
  section "Backend" → "Console") and translates its output into events from the contract below.
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

- A **workspace** is a real directory (not a symlink) directly in the projects directory whose name does not start
  with `.` (e.g. `studia`), with a display name (e.g. "Studia"). A **repository** is a real directory directly in a
  workspace whose name does not start with `.`, with a real `.git` directory (not a symlink and not a `gitdir:` file,
  which could point anywhere) that libgit2 can open (e.g. `studia/lab-3-sieci`). The file system decides which
  workspaces and repositories exist; the table Workspaces keeps only each workspace's display name and creation
  order. A directory made outside the portal (e.g. in the terminal) is listed under its directory name, after the
  others.
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
  the backend checks the same (`CloneUrl`) and also refuses any host label starting with `xn--` (the frontend accepts
  valid punycode).
- Git messages from the server (`message`) are displayed only as text.

### API contract

Implemented in the backend (section "Backend").

All endpoints require a session (otherwise `401`). `POST` requires the XSRF header.
Errors have a `{"message"}` body with a description (e.g. git output), which the frontend shows under its own message.

| Method | Path | Response |
|---|---|---|
| GET | `/api/workspaces` | `200 [{"name","path","repoCount"}]` in creation order; directories made outside the app after them, by name (ordinal, ignoring case), under their directory name |
| POST | `/api/workspaces` | body `{"name"}`. `201 {"name","path","repoCount":0}`. Name: trimmed, 1-40 code points, each a letter, a digit, a space, `-` or `_`. Directory: lower case, `ł`→`l`, other letters without their diacritics, every run of other characters → one `-`, no `-` at either end (`Zażółć gęślą jaźń` → `zazolc-gesla-jazn`). `400 {"message":"Nieprawidłowa nazwa."}` for a bad name or one whose directory would be empty (`ß`, `Привет`); `409 {"message":"Workspace już istnieje."}` when anything (a directory, a file, a symlink) already has that name |
| GET | `/api/repos?workspace=<katalog>` | `200 [RepoSummary]` sorted by name (ordinal, ignoring case). `404` when the workspace does not exist |
| POST | `/api/repos/clone` | body `{"workspace","url"}`. `201 RepoSummary`. Directory name from the last URL segment without `.git`, it must match `^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$` (so not `.`, `..`, `.git` or `-…`). `400` bad URL or name (`{"message":"Nieprawidłowy adres."}` or `{"message":"Nieprawidłowa nazwa katalogu."}`), `404` no workspace, `409 {"message":"Katalog już istnieje."}` when anything has that name, `502` with git's message, or `"Git nie skończył w ciągu N s i został przerwany."` at the time limit; a failed or stopped clone leaves no directory |
| GET | `/api/git/show?repo=<repo>&path=<plik>` | `200 {"content"}`: the file content in HEAD (for the diff view). `404` when the file is not in HEAD (also a directory, a symlink, a submodule, or no commit yet). The content is what a checkout writes (line endings and ident from .gitattributes); 413 over 5 MB, 415 for a NUL byte or invalid UTF-8, a UTF-8 BOM is dropped (the files API's rules). `400` when `path` is not inside `repo` |
| GET | `/api/git/status?repo=<repo>` | `200 {"branch","ahead","behind","files":[{"path","status"}]}`. `status`: `modified`/`added`/`deleted`/`renamed`/`untracked`/`conflicted`. Untracked files individually (`--untracked-files=all`). `404` when it is not a repository |
| POST | `/api/git/pull?repo=<repo>` | `git pull --ff-only`, run as a fetch and a fast-forward merge. `200 {"message","changedPaths"}`: `"Pobrano N commit/commity/commitów."` with the files that differ between the old and the new HEAD (a rename gives both paths), or `"Już aktualne."` with `[]`. `400 {"message":"Gałąź nie ma gałęzi zdalnej."}` without an upstream (also on a detached HEAD). `409` with git's message when the merge cannot fast-forward or would overwrite local changes. `502` with git's message when the fetch fails, or the time-limit message |
| POST | `/api/git/push?repo=<repo>` | `200 {"message"}`: `"Wypchnięto N commit/commity/commitów do <upstream>."`, `"Wypchnięto gałąź <branch> do origin/<branch>."` for a new upstream (`git push -u origin HEAD`), or `"Nic do wypchnięcia."` without the network when nothing is ahead. `400` `"Odłączony HEAD: przełącz się na gałąź, żeby zrobić push."` or `"Brak zdalnego repozytorium 'origin'."`. `409` with git's output when a ref is `[rejected]` (pull first). `502` for any other failure (network, authentication, `[remote rejected]` by a hook or a protection rule) or the time limit |

`RepoSummary`: `{"name","path","branch" | null,"changes","upstream" | null,"ahead","behind","lastCommit": {"message","date"} | null}`.
Paths (`path`, `files[].path`, `changedPaths`) are always relative to the projects directory.
`workspace`, `repo` and `path` are paths in the files API's syntax: `workspace` is one segment, `repo` two
(`<workspace>/<repository>`), and `path` starts with `repo` + `/`. Anything else, and a path that resolves outside the
projects directory, is `400` with an empty body; a valid path that is not a workspace or a repository is `404` with an
empty body. `lastCommit` is the subject line of HEAD's commit and its committer date (ISO 8601, UTC). `ahead` and
`behind` are counted against the local remote-tracking branch, so they are as fresh as its last fetch. The backend
fetches in the background when the repository list is read: every repository with an upstream at most once per 5
minutes, and the answer never waits. New ↑/↓ appear at the panel's next refresh (returning to the tab, a save,
"Odśwież").

The backend's own messages are Polish (as the mock's); git's messages pass through in English (`LC_ALL=C.UTF-8`).

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
- One time limit per request, `Git:NetworkTimeout` (100 s, under Cloudflare's 125 s), covering the wait for the
  repository's lock and every git step; local steps are also capped at 30 s; at the limit the whole process tree is
  killed and the answer is 502.

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
- **The view does not answer terminal queries** (device attributes, cursor position, modes, colours): an answer from
  xterm would reach the program once per open tab (e.g. as `^[[?1;2c` in vim). Handlers next to the OSC 8 one take
  these sequences over; setting a colour (OSC 4/10/11/12 without `?`) still works. tmux on the server answers the
  cursor position report, the mode report and the colour queries, and passes every query on to every view; the
  device attributes queries (DA1, DA2) get no answer at all, because neither the view nor tmux answers them.
- After attaching, the terminal takes focus only when the user is not typing somewhere else at that moment
  (`isTypingElsewhere`), e.g. in the console field: otherwise the rest of the prompt with Enter would end up in the shell.
- The terminal size fits the panel (FitAddon + ResizeObserver) and goes to the server (`Resize`).
- **Ctrl+S in the terminal belongs to the terminal** (e.g. saving in nano), not to the editor. Browser shortcuts
  (e.g. Ctrl+W, Ctrl+T) still work in the browser and cannot be intercepted.
- Security on the browser side: no clipboard addon (OSC 52), so a program in the terminal cannot write
  anything to the clipboard, and no OSC 8 links. The terminal content disappears from memory on logout (full page reload).
- Font: first `JetBrainsMono Nerd Font` (icons from the dotfiles prompt, if the font is installed
  on the device), then `JetBrains Mono` and monospace.

### `/hubs/terminal` hub contract

Connection as in the console: SignalR, WebSocket only, no negotiation, JSON, requires a session and an `Origin` check,
the session is checked on every call, and connections are closed when the session ends (including expiry). This is the most powerful part of the portal (a full shell), so the rules from "Security"
in `PLAN.md` (a separate user, systemd sandbox) are especially important here.

Implemented in the backend (section "Backend" → "Terminal").

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

Backend rules the tables do not show:
- `exitCode` is `null` (the backend does not report it).
- `Attach` of an unknown id fails with "Nieznany terminal"; `Attach` of an exited terminal gives an empty `snapshot`.
  `Attach` without a valid `client` (1-64 characters) gives the snapshot, and none of that view's `Input` is accepted.
- `CloseTerminal` of an unknown id succeeds without an error (another tab may have closed it); no event is sent.
- `Resize` of an unknown id is ignored.
- Limits: 20 terminals (exited ones included); sizes clamped to 10..1000 columns and 2..500 rows; history 5000 lines;
  a snapshot's history and screen capped at 1,000,000 characters together, the oldest lines dropped first (the
  alternate screen and the cursor/modes tail are not counted, so a snapshot can still end up longer than that).
- Terminals end when the API stops.
- Hubs refuse a missing or foreign `Origin` with `403`.
- Error texts: "Nieznany terminal", "Nieprawidłowa paczka", "Najpierw Attach na tym połączeniu", "Nieprawidłowa
  ścieżka", "Za dużo terminali", "Terminal niedostępny", "Terminal nie odpowiada", "Sesja wygasła". The frontend shows
  its own texts instead.

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
| GET | `/api/files/list?path=<dir>` | the directories and files in a directory of the projects directory; 400 for a bad path (also a name longer than the file system allows), one that leads outside it or into `.git` (also when its end does not exist), or one with a dangling or looping symlink anywhere in it; 404 for a missing directory, a file, or a path under a directory that cannot be searched | session |
| GET | `/api/files/content?path=<file>` | the content and version of a text file; 400 for a bad path as in the listing; 404 for a missing file, a directory, a special file (FIFO, socket, device) or a path under a directory that cannot be searched; 413 over 5 MB; 415 for a NUL byte or invalid UTF-8 | session |
| PUT | `/api/files/content?path=<file>` | saves `{"content","baseVersion"}` when the file on disk still has `baseVersion` (`absent`: the file is created); 400 for a bad path as in the listing, a directory or special file as the target, or a missing field; 404 when the directory of a new file is missing or cannot be searched; 409 with `{"currentVersion"}` when the version differs; 413 for content over 5 MB; 415 for content with a NUL character | session, XSRF token |
| GET | `/api/workspaces` | the workspaces in display order with their repository counts | session |
| POST | `/api/workspaces` | creates a workspace `{"name"}`: its directory and its row; 400 bad name or empty directory; 409 the name is taken | session, XSRF token |
| GET | `/api/repos?workspace=<dir>` | the repositories of a workspace with their state, by name; 400 when workspace is not one valid path segment; 404 when it is not a workspace | session |
| POST | `/api/repos/clone` | git clone of `{"workspace","url"}` into the workspace, within `Git:NetworkTimeout`; 400 bad body, workspace, URL or directory name; 404 no such workspace; 409 the name is taken; 502 git failed or ran out of time | session, XSRF token |
| GET | `/api/git/status?repo=<repo>` | branch, ahead and behind, and the changed files of a repository; 400 when repo is not two valid path segments; 404 when it is not a repository | session |
| GET | `/api/git/show?repo=<repo>&path=<file>` | a file as HEAD has it; 400 as for the status, or when path is not a valid path inside repo; 404 when HEAD has no such file; 413 over 5 MB; 415 for a NUL byte or invalid UTF-8 | session |
| POST | `/api/git/pull?repo=<repo>` | fetch and fast-forward merge under the repository's lock; 400 no upstream; 404 not a repository; 409 the merge failed; 502 the fetch failed or ran out of time | session, XSRF token |
| POST | `/api/git/push?repo=<repo>` | push to the upstream (or -u origin HEAD) under the repository's lock; 400 detached HEAD or no origin; 404 not a repository; 409 [rejected]; 502 any other failure or the time limit | session, XSRF token |
| GET (WebSocket) | `/hubs/terminal` | the terminal hub (contract: "Terminal"); WebSocket only, without negotiation | session, Origin |
| GET (WebSocket) | `/hubs/console` | the console hub (contract: "Console"); WebSocket only, without negotiation | session, Origin |
| any | `/*` other paths that do not look like a file (no `.` in the last segment) | GET and HEAD: the built frontend's `index.html` (Angular's routes), `no-store`, with the CSP header; other methods: 404, also without a session; only with `Frontend:Root` | none |
| GET | `/<file>` of the build, e.g. `/main-<hash>.js`, `/monaco.css` | the file, `no-cache`; only with `Frontend:Root` | none |
| any | `/hubs/*` other than the hubs above | 401 without a session, 404 with one | session, Origin |

Every other endpoint requires a session (`FallbackPolicy`), and so does a path that matches nothing: a missing file such
as `/chunk-x.js` gives 401 without a session and 404 with one, never `index.html`. Every POST/PUT/PATCH/DELETE under
`/api` needs a valid `X-XSRF-TOKEN` (filter `RequireXsrfToken` in `Auth/AuthEndpoints.cs`, 400 otherwise).

Hubs (`/hubs/*`) need a session and an Origin header equal to one of `Hubs:AllowedOrigins`: otherwise 403 with an empty
body, also when Origin is missing. They are outside `/api`, so no XSRF token (the WebSocket upgrade is a GET; the
Origin check and the `SameSite=Strict` cookie cover cross-site requests). An unknown path under `/hubs` gives 401
without a session and 404 with one, never `index.html`.

Every response has the headers of "Security headers" (`Frontend/SecurityHeaders.cs`), and all `/api/*` responses have
`Cache-Control: no-store`. An unknown `/api/*` path (also `/api` itself) gives 401 without a session and 404 with one,
never `index.html`. Unhandled errors give 500 as `application/problem+json`, without details outside Development.

Configuration:

| Key | Where | Meaning |
|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | development: `launchSettings.json` (`Development`); tests: `Testing`; server: `Production` (the unit) | the host environment: `appsettings.<environment>.json` and the Production rules (`Notifications:NtfyUrl` required; the process made non-dumpable once the host has started, `Files/Libc.cs`) |
| `ASPNETCORE_URLS` | development: `launchSettings.json` (`http://localhost:5080`); server: `http://127.0.0.1:5090` (the unit) | where Kestrel listens; on the server only loopback, where `cloudflared` connects |
| `AllowedHosts` | `appsettings.json` (`*`); server: `<domain>` in `/etc/claushh/claushh.env` | the Host header values the API answers (host filtering; another Host gets 400); local requests on the server send `Host: <domain>` |
| `Logging:Console:FormatterName` | not set; server: `systemd` (the unit) | the console log format; `systemd` writes one line per message with its syslog level, for the journal |
| `DOTNET_EnableDiagnostics` | not set; server: `0` (the unit) | `0` turns off the .NET diagnostic port, so there is no `dotnet-diagnostic-*` socket |
| `ConnectionStrings:Claushh` | development: `dotnet user-secrets`; server: variable `ConnectionStrings__Claushh` in `/etc/claushh/claushh.env` | PostgreSQL from `deploy/docker-compose.yml` (server: project `claushh-prod` on `127.0.0.1:5435`) |
| `Sessions:IdleTimeout`, `Sessions:AbsoluteTimeout` | `appsettings.json` | `00:30:00` and `12:00:00` |
| `Sessions:SecureCookies` | `appsettings.json` (`true`), `appsettings.Development.json` (`false`) | `false` only for plain http in development: cookie names without `__Host-`, `Secure` only on HTTPS |
| `Projects:Root` | `appsettings.json` (`/srv/projects`); development: `dotnet user-secrets`; server: variable `Projects__Root` (`/srv/projects`, the unit) | the projects directory: an absolute path to an existing directory whose real path is not `/`, which the API can read, write and search; checked at start (the API does not start otherwise) |
| `Git:NetworkTimeout` | `appsettings.json` (`00:01:40`) | the one deadline of a clone, pull or push request, lock wait included, and of a background fetch; at it the git process tree is killed (502) |
| `Hubs:AllowedOrigins` | `appsettings.json` (empty: every hub request is refused), `appsettings.Development.json` (`http://localhost:4200`, `http://localhost:5080`); server: `Hubs__AllowedOrigins__0=https://<domain>` in `/etc/claushh/claushh.env` | the exact Origin values (scheme, host, port) a hub request may carry, compared ordinally |
| `Git:Environment:*` | not set by default | extra variables for the git CLI's environment (`ChildEnvironment`'s overrides in `GitRunner.StartInfo`), e.g. for a credential helper's configuration |
| `Terminal:SocketDirectory` | not set: `$XDG_RUNTIME_DIR/claushh`; server: `/run/claushh` (the unit, with `RuntimeDirectory=`) | the directory of the API's tmux socket and configuration, created with mode 0700; the socket path must fit in 107 bytes. Without it and without `XDG_RUNTIME_DIR` the terminal is unavailable |
| `Terminal:Environment:<NAME>` | none (tests: `SHELL`, `HOME`); server: `DOCKER_HOST` and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` (the unit) | variables for tmux and the shell on top of the allowlisted environment; on the server they point `docker` and Testcontainers at the rootless Podman socket of `workspace` (`/home/workspace/.local/state/podman/podman.sock`) |
| `Frontend:Root` | not set (development uses `ng serve`); to try the build: `dotnet user-secrets`; server: variable `Frontend__Root` (`/opt/claushh/web`, the unit) | the absolute path of the Angular build (`web/dist/web/browser`) the API serves at `/`; when set, its `index.html` must carry the CSP `<meta>`, checked at start (the API does not start otherwise). Read once: restart the API after a build that changes the policy |
| `Notifications:NtfyUrl` | server: variable `Notifications__NtfyUrl` (required in Production: the API does not start without it); development: optional, `dotnet user-secrets` | the URL of the ntfy topic (an absolute https URL, checked at start). A secret: whoever knows the topic can read it, so it is never logged. Empty: no notifications |
| `Notifications:NtfyToken` | server: variable `Notifications__NtfyToken`; optional | an ntfy access token, sent as `Authorization: Bearer` |
| `Console:ClaudePath` | not set: `claude` on PATH; server: `/home/workspace/.local/bin/claude` (the unit), the launcher of Anthropic's installer | the `claude` CLI the console runs, at least 2.1.285 (checked with `--version` before the first claude process; below that or missing, the console answers "Konsola niedostępna" and conversations can still be read) |
| `Console:ConfigDirectory` | not set: `$XDG_STATE_HOME/claushh/claude`, else `~/.local/state/claushh/claude` (server: `/home/workspace/.local/state/claushh/claude`) | the CLI's own state and login (`CLAUDE_CONFIG_DIR`), created with mode 0700 at start |
| `Console:ApiKeyFile` | not set: the login in the config directory; server: optional, variable `Console__ApiKeyFile` in `/etc/claushh/claushh.env` | a file (mode 0600, outside the projects directory, readable by the API's user) with an Anthropic API key, read by the CLI through `apiKeyHelper` |
| `Console:Environment:<NAME>` | none (tests: `DOTNET_ROOT` for the fake CLI) | variables for the `claude` process on top of its allowlisted environment |

Frontend (`Frontend/`; decisions: `PLAN.md`, "Backend decisions (stage 1, part C)"):
- With `Frontend:Root` set, the API serves the Angular build:
  - the files under that directory before authentication (the same files for everyone, no data);
  - `index.html` for every other path that does not look like a file (`MapFallbackToFile`, `{*path:nonfile}`), so a
    reload on `/login` or another app route works.
- Endpoint matching (`UseRouting`) runs before the files, so `/api` and `/hubs` paths never get a file or the page. A
  missing file is 401 or 404 like any unknown path. Without the key there is no frontend: development uses `ng serve`.
- Content types come from the framework's list, except `.ttf` as `font/ttf`; unknown types are not served. `index.html`
  is `no-store`, every other file `no-cache` (revalidated with its ETag).
- `SecurityHeaders` sets the headers of "Security headers" on every response; the CSP goes only with the page.
  Antiforgery's own `X-Frame-Options` is suppressed.

Sessions (`Auth/`):
- Table `Sessions`: public `Id` (the `sessionId` of `/me`, constant for the life of the session), `SecretHash`
  (SHA-256 of the random 32-byte secret from the cookie, unique), `CreatedAt`, `LastActivityAt`, `IdleExpiresAt`
  (never past `AbsoluteExpiresAt`), `AbsoluteExpiresAt`, `RevokedAt`, `Device` (User-Agent), `Ip`. Rows stay after logout
  and are deleted 90 days after the session ended (`AuthCleanup`, at start and every hour).
- A session is active when it is not revoked and both deadlines are in the future. Only `keepalive` moves `IdleExpiresAt`;
  reading a session (`SessionAuthenticationHandler`, `/me`) never extends it. All time comes from `TimeProvider`.
- Cookies, all `SameSite=Strict; Path=/`: `__Host-claushh-session` (the secret, `HttpOnly`, no `Expires`),
  `__Host-claushh-af` (antiforgery cookie token, `HttpOnly`), `XSRF-TOKEN` (request token that Angular sends back in
  `X-XSRF-TOKEN`). With `Sessions:SecureCookies=false`: `claushh-session`, `claushh-af`, and `Secure` only on HTTPS.

Client address (`Program.cs`, `LoginGuard.ClientIp`; decisions: `PLAN.md`, "Backend decisions (stage 1, part C)"):
- `ForwardedHeaders` runs first in every environment with the framework's default trust: only a loopback peer
  (127.0.0.0/8 and `::1`, also IPv4-mapped), which on the server is the local `cloudflared`.
- From such a peer the client address is `CF-Connecting-IP` and the scheme is `X-Forwarded-Proto`, one entry each.
  From any other peer both are ignored. `X-Forwarded-For` is never read, since its left part comes from the client.
- A loopback request without `CF-Connecting-IP` keeps its own address (127.0.0.1). A request without any peer address
  (e.g. over a Unix socket) is trusted like loopback.
- With `X-Forwarded-Proto: https` from `cloudflared` a request counts as HTTPS, so the `Secure` and `__Host-` cookies
  work behind the tunnel. Plain http with `Sessions:SecureCookies=true` fails in antiforgery (500).
- `LoginGuard.ClientIp` turns the address into two values:
  - the text shown in the history, the session list and the logs (an IPv4-mapped address as IPv4);
  - the key of the per-IP limit (`LimitKey`): the IPv4 address itself, or the IPv6 /64 written as `2001:db8:1:2::/64`.

Login protection (`Auth/`):
- TOTP codes are checked by `TotpVerifier` against `TimeProvider`: the 30 s step of now, the one before and the one
  after. A code is accepted once: the last accepted step is stored in `AspNetUserTokens` (`Claushh` / `TotpLastStep`),
  and a code from that step or an earlier one is rejected. `create-user` checks its code the same way, so that code is
  used up and the first login needs the next one. `--reset-totp` first removes the stored step, so the new key's
  current code confirms it.
- Every attempt that reaches the check of the credentials is recorded in `LoginAttempts` (`At`, `Ip`, `LimitKey`,
  `Device` as the User-Agent cut to at most 256 characters, `Success`), also for unknown names; the typed user name
  never. Attempts answered with `429` are not recorded. Attempts are deleted after 90 days (`AuthCleanup`).
- 10 failures with one limit key within 15 minutes give `429` with `Retry-After` (seconds until the 10th most recent
  failure leaves the window), with an empty body. The key is the client's IPv4 address or its IPv6 /64 ("Client
  address"). Attempts recorded before the key existed have an empty key and count for no client.
- 5 wrong or reused codes after a correct password lock the account (`AccessFailedCount` and `LockoutEnd` of
  `AspNetUsers`, written by `LoginGuard`; Identity's own lockout methods use the real clock): for 15 minutes the first
  time, twice as long for every further lock in a row, at most 24 hours (the number of locks in a row is the token
  `Claushh` / `LockoutsInARow` in `AspNetUserTokens`). While it is locked every login gets `429` with `Retry-After`,
  whatever the name and password; when both limits apply, `Retry-After` is the later end. A successful login resets
  both counts; `create-user --reset-totp` and `--reset-password` also clear the lockout and reset both counts.
- Logins in the API process run one at a time (`LoginGuard.EnterAsync`), so the checks and writes of parallel attempts
  never interleave. A login waits at most 10 s for the one before it (`LoginGuard.GateWait`); then it gets `429` with
  `Retry-After: 10`, and nothing is recorded.

Notifications (`Notifications/`; decisions: `PLAN.md`, "Backend decisions (stage 1, part C)"):
- `LoginNotifications` sends a phone notification through ntfy for two events, never with the user name:
  - every successful login: title `Claushh: logowanie`, priority `default`, with the address, the device and the time
    in UTC;
  - every start of an account lock: title `Claushh: konto zablokowane`, priority `high`, with the lock's length, the
    last attempt's address, device and time, and `create-user --reset-password` as the way out.

  Failed attempts and `429` send nothing.
- Each message is one `POST` of the text to `Notifications:NtfyUrl`, with `Authorization: Bearer
  <Notifications:NtfyToken>` when the token is set. Titles are ASCII (header values); the body is UTF-8.
- The login only queues the message: at most 100 wait, and a full queue drops it with a warning. A background service
  sends them one at a time outside the login gate, with a 10 s HTTP limit and one attempt each.
- A failure is logged with the status code or the exception type only, never the URL (its path is the secret topic),
  and the login is not affected. The notification client has no HTTP logging for the same reason.
- Without `Notifications:NtfyUrl` nothing is queued, and one log line at start says notifications are off.

Files (`Files/`; the rules the frontend can see are in "Files API contract"):
- Every path goes through `ProjectPaths.Resolve` first (`FileEndpoints`: `400` when it returns null, before any file is
  touched); `FileStore` works on the resolved path.
- The version is the lower-case hex SHA-256 of the file's bytes on disk (the BOM included), and `absent` when there is
  no file. The text rule is `FileStore.DecodeText`: `null` for a NUL byte or invalid UTF-8, otherwise the text without a
  leading BOM; a save applies the same rule to the content it is given.
- A read measures the file, refuses one over 5 MB without reading it, and reads into a buffer of its length plus one
  byte (the extra byte shows that the file has grown meanwhile, and the buffer then grows, to 5 MB plus one at most), so
  a read allocates about the size of the file and not the limit.
- A save of a file or a free name first refuses content with a NUL character or without a UTF-8 form (`415`) and content
  over 5 MB (`413`, counted with `GetByteCount`, so oversized content is not even encoded). Then it takes the lock of
  the file: a fixed array of 64 semaphores picked by the hash of the resolved path, so a symlink and its target share
  one. Under the lock it hashes the file (version, BOM and Unix mode, read from the open file) and answers `409` when
  it is not `baseVersion`. Then it writes a temporary file `.claushh-<id>.tmp` in the same directory (the name does not
  contain the file's name; the file is created for its owner only when it replaces a file, with the default mode when
  it creates one) and flushes it to disk. Then it hashes the file again: when it changed meanwhile, the temporary file
  is deleted and the answer is `409` with the version just found; otherwise the temporary file gets the old file's mode
  (set on its open handle) and is renamed over the file. The temporary file is also deleted when any step fails. What
  is left of the race with writers outside this API is the time to hash the file and rename it.
- Saving by rename (decisions: `docs/PLAN.md`): a writable file in a directory the API cannot write cannot be saved
  (`500`), and the saved file is a new inode.

Workspaces and git (`Workspaces/`, `Git/`):
- Local git state is read in-process with LibGit2Sharp 0.32.0 (libgit2 for linux-x64 comes with it, in
  `LibGit2Sharp.NativeBinaries`): finding repositories, the status, the branch, the upstream, ahead and behind, the
  last commit and the HEAD content. A repository is opened for one call and disposed. A repository libgit2 cannot read
  (one owned by another user, an unknown ref format such as reftable, a broken `.git`) is not listed and is logged.
- Status: git's rules for staged and unstaged changes, untracked files one by one (also inside untracked directories),
  ignored files left out, renames detected in the index only, as `git status` does (a rename that is not staged is
  `deleted` plus `untracked`). The first match wins: a conflict → `conflicted`; new in the index → `added`; renamed →
  `renamed` (the new path); deleted in the index or the working tree → `deleted`; modified or a type change →
  `modified`; new in the working tree → `untracked`. A repository's `changes` is the number of these entries, so the
  table and the status bar agree.
- `branch` is `null` for a detached HEAD (a branch without commits keeps its name), `upstream` is the tracked branch
  (`origin/main`) or `null`. On a branch without commits that tracks an upstream, `behind` is the number of commits of
  the upstream (0 while the upstream has none either, e.g. a freshly cloned, completely empty remote).
- Table Workspaces (Directory text primary key, DisplayName text, CreatedAt timestamptz): the list joins the directories
  with the rows. A row whose directory is gone is ignored and kept (the name comes back with the directory) and is
  taken over by a new workspace with the same directory. Creating runs under one process-wide lock: the name must be
  free (no entry at all, not even a dangling symlink), then mkdir, then the row; when the row cannot be written, the
  empty directory is removed again and the request fails with 500. The name rules are the frontend's: JavaScript's
  trim (not .NET's), code points (not UTF-16 characters), and İ lowercased as JavaScript does.
- The `git` CLI runs only for the network and its local steps (`GitRunner`): without a shell (`ArgumentList`), stdin
  closed, in the repository (the workspace for a clone), always with `-c protocol.allow=never -c
  protocol.https.allow=always -c core.fsmonitor=false`. Its environment is built by `Processes/ChildEnvironment`: not
  the API's whole environment (a denylist would miss whatever variable the API's own process picks up next), but an
  allowlist (`HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `LANG`, `LANGUAGE`, every `LC_*`, `TZ`, `LANG=C.UTF-8` added
  when none of `LANG`/`LC_ALL`/`LC_CTYPE` is set), then `GitRunner`'s own overrides: `XDG_CONFIG_HOME`,
  `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` passed through when the API has them (git's config lookup and
  credential helpers such as libsecret need them), the configured `Git:Environment:*` values, then git's own
  `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and `LC_ALL=C.UTF-8` (English, stable messages), which always win.
  `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the like are simply never set. Hooks
  run as in the terminal. stdout and stderr are read at the same time, each kept up to its last 64 KB; the `message`
  of an answer is stderr then stdout, trimmed, at most 4000 characters. Logs name the operation, the directory, the
  exit code and the duration, never the output (but the directory is the resolved path: responses never contain
  resolved paths, logs may).
- Time limits: one deadline per request, `Git:NetworkTimeout` from its start, covering the lock wait and every step;
  local steps (merge, diff) are also capped at 30 s. At a limit the process tree is killed (`git` starts
  `git-remote-https`) and the answer is `502` "Git nie skończył w ciągu N s i został przerwany.". A local step keeps
  running under its own cap when the client goes away (only a network step is stopped then): there is no one to
  answer either way, but a `git merge` half done would leave the repository in a worse state than letting it finish.
- One lock per repository directory (`RepoLocks`), also for the target of a clone; a request waits for it within its
  deadline.
- Background fetch (`BackgroundFetch`): once `GET /api/repos` has built the list, every repository with an upstream
  whose last attempt is at least 5 minutes old (by `TimeProvider`) gets `git fetch <remote>` in the background with its
  own `Git:NetworkTimeout`; a failure is logged and tried again 5 minutes later. A repository that is busy (a clone,
  pull, push or another fetch) is skipped and tried at the next list. A clone, pull or push that finds a background
  fetch holding the repository's lock stops it (its process tree is killed; a pull fetches anyway), and running
  fetches are killed when the API stops.
- Clone: the checks in the mock's order (body and workspace `400`/`404`, the URL rule, the directory name, any entry at
  the target `409`), then `git clone -- <url> <name>` under the target's lock, run in the workspace directory with
  the destination given by name (not the resolved path), so git's own "Cloning into '…'" message never puts a
  resolved path in a `502` response. A failure or a timeout removes the target directory if it exists and answers
  `502`; a clone that is not a repository the portal can read is a `500`.
- Pull: no upstream (also a detached HEAD) → `400`; `git fetch <remote>` (a failure → `502`); nothing new → "Już
  aktualne."; `git merge --ff-only @{upstream}` (a failure → `409` with git's message); then `changedPaths` from `git diff
  --name-only --no-renames -z <old HEAD> HEAD` (on a branch that had no commits, `git ls-tree -r --name-only -z HEAD`).
- Push: a detached HEAD → `400`; an upstream with nothing ahead → "Nic do wypchnięcia." without the network; with an
  upstream `git push --porcelain <remote> HEAD:<its branch>` (explicit, so `push.default` does not matter); without one
  but with `origin`, `git push --porcelain -u origin HEAD`; neither → `400`. When ahead cannot be computed (the
  upstream has no tip yet, e.g. a freshly cloned empty remote, or there is no common history) the shortcut is skipped
  and the push runs regardless, so git's own porcelain output decides `200`/`409`/`502` as for any push; its success
  message then counts HEAD's own commits, since there is nothing ahead can be compared against. A porcelain line
  `!…[rejected]` → `409`; any other failure → `502`. A message that repeats the repository's resolved path (e.g. a
  stale lock file) has it replaced
  with the API path, as clone's destination name does for its own message.

Hubs (`Hubs/`, shared by every hub):
- SignalR with the JSON protocol, WebSocket only; the frontend skips negotiation. Detailed errors are off: a client
  sees only `HubException` texts, which are Polish, and the frontend shows its own texts anyway.
- `HubOrigins` runs before authentication for every path under `/hubs`.
- `HubSessionFilter`, a global hub filter: on connect it registers the connection under its session (claim
  `session_id`) and checks the session once; on every call it checks it again (`SessionService.IsActiveAsync`, one
  indexed query). An ended session: the connection is aborted (the client does not reconnect and checks the session
  over HTTP) and the call fails; the connection closes before the "Sesja wygasła" error can be sent, so the client
  sees the call cancelled. It never extends the session. A connection whose connect fails (the check or the hub's own
  `OnConnectedAsync`) is removed from the registry right away, so it is not kept forever.
- `HubSessionSweep` asks which registered sessions are still active (`SessionService.ActiveIdsAsync`, one query) and
  aborts the connections of the others: every 5 s (expiry, `create-user` in another process) and right after logout,
  ending another session and revoke-others in this process. Events sent to clients are not checked, so a connection of
  an ended session can receive them until it is aborted: at once for an end in this process, within 5 s otherwise. A
  failure of that in-request sweep is logged and left to the 5 s timer, instead of failing the request.

Terminal (`Terminal/`; the contract is in "Terminal"):
- tmux 3.7 or later in control mode (`tmux -C`, stdin and stdout as pipes), no PTY. The API runs its own tmux server on
  `<Terminal:SocketDirectory>/tmux.sock` with its own `tmux.conf` there (`history-limit 5000`, as the xterm scrollback;
  `remain-on-exit off`; `detach-on-destroy on`; `status off`; `default-terminal tmux-256color`), so the user's
  `~/.tmux.conf` and own tmux sessions stay apart. At start (a hosted service, so `create-user` never runs it) the API
  checks `tmux -V`, writes the configuration and ends a server a previous run left (`kill-server`); on a graceful stop
  (also Ctrl+C on `dotnet run`) it closes every terminal and ends the server. Terminals do not survive a restart.
  Without tmux 3.7, or without `Terminal:SocketDirectory` and `XDG_RUNTIME_DIR`, the error log says so,
  `ListTerminals` is empty and the other methods answer "Terminal niedostępny"; the rest of the API works.
- Every tmux process gets only HOME, USER, LOGNAME, SHELL, PATH, LANG, LANGUAGE, LC_* and TZ of the API's environment
  (`Processes/ChildEnvironment`), `LANG=C.UTF-8` when no locale variable is set, `COLORTERM=truecolor`, then
  `Terminal:Environment`: none of the API's own variables reach tmux or the shell (the connection string,
  `ASPNETCORE_*`, `DOTNET_*`, `CLAUDECODE*`); the login shell's profile may still set its own, e.g. `DOTNET_ROOT`. The
  shell is the login shell from SHELL and runs as the API's user.
- A terminal is the tmux session `claushh-<id>` (`id`: a new GUID as 32 hex digits) in the real path of `projectPath`,
  which must be a directory (`ProjectPaths`), and one control client for its whole life. Its title is the last segment
  of `projectPath` or "projekty", plus " (k)" with the smallest free k from 2. At most 20 terminals, exited ones
  included; sizes are clamped to 10..1000 columns and 2..500 rows.
- Output: the `%output` lines of the terminal's pane, tmux's octal escapes undone, one UTF-8 decoder per terminal (a
  character split between lines is kept, invalid bytes become U+FFFD). Every non-empty piece is a `TerminalOutput` to
  all connections with `seq` + 1 from 1. The reader waits for each send, so every connection gets the order and a slow
  browser slows the terminal instead of filling memory.
- Commands go to the control client one line at a time and are matched to tmux's `%begin`…`%end`/`%error` blocks in
  order; inside a block a line starting with `%` is pane text. Each command has 10 s ("Terminal nie odpowiada"); a late
  reply still takes its own command's place. Waiting for and writing a command's line also has the 10 s limit; a write
  cut off by that deadline ends the control client, so the terminal reports its exit.
- `Attach` (one at a time with `Input` and `Resize` of the same terminal, under its lock): `refresh-client -C` to the
  view's size, then one line of tmux commands, so screen, modes and `seq` agree: `display-message` (cursor, modes,
  alternate screen, scroll region, history size) and `capture-pane -p -e -J -S - -E -` (history and screen with
  colours, wrapped lines joined). `seq` is that of the last fragment read before the capture's reply. The text is the
  lines joined by CRLF (xterm has no `convertEol`), then `ESC[0m`, the scroll region, the cursor and the modes the
  view's `reset()` cleared (hidden cursor, application cursor keys and keypad, bracketed paste, mouse reporting). While
  a program shows the alternate screen, a second line takes the capture line by line plus the normal screen tmux keeps,
  and the text is history and normal screen, `ESC[0m`, `ESC[?1049h`, then the alternate screen. The oldest lines of the
  history and normal screen are left out first (a single longer line is left out whole) once together they would push
  the text over 1,000,000 characters; the alternate screen and the cursor/modes tail are never cut, so they alone can
  still leave the snapshot longer than that. A `Resize` while a program shows the alternate screen leaves the normal
  screen tmux kept at its old size: the next `Attach`'s line counts then disagree, and its snapshot falls back to the
  plain capture, without the switch to the alternate screen.
- `Input`: `client` 1-64 characters, `seq` ≥ 1, `data` at most 4096 UTF-16 units, otherwise "Nieprawidłowa paczka";
  an unknown or exited terminal is skipped. Under the lock: a `client` whose last `Attach` was on another connection
  gets "Najpierw Attach na tym połączeniu"; a `seq` not above the last accepted is skipped; otherwise the UTF-8 bytes
  go to the pane with `send-keys -H` (each byte as it is), at most 1024 per command, and `seq` is recorded as soon as
  the batch is written to tmux, before its replies: a reply can wait behind heavy output past the 10 s deadline, and the
  batch the frontend then sends again with the same `seq` is not typed twice. The last `seq` and `Attach` connection of
  every `client` stay until the terminal is closed.
- `Resize`: clamped, then `refresh-client -C`; an unknown terminal is ignored; the last view to resize sets the size.
  tmux applies a pane's new size on its own timer, so the shell may still see the old size for up to about a quarter
  second after `Resize` returns.
- The end of the control client's output (the shell exited and its session closed, or tmux went away) marks the
  terminal exited and sends `TerminalExited` with `exitCode: null`; it stays listed until closed. It also runs a
  best-effort `kill-session`, so a shell detached from inside the pane (`tmux detach`; `TMUX` there points at the
  API's own socket) does not keep running unlisted. `CloseTerminal` takes it off the list first (no event), then runs
  `kill-session`; an unknown id is no error.

Console (`Claude/`, `Hubs/ConsoleHub.cs`; the contract is in "Console"; decisions: `PLAN.md`, "Backend decisions
(stage 3)"):
- `/hubs/console` has the shared hub rules ("Hubs"). `GetConversation` and `StartConversation` need `projectPath` to be
  a directory in the projects directory (`ProjectPaths`, as for the terminal), otherwise "Nieprawidłowa ścieżka".
  Conversations are keyed by `projectPath` as sent; a conversation's id is a new GUID.
- Tables `Conversations` (`Id`, `ProjectPath`, `StartedAt`, `LastEventAt`, `Resumable`; index `ProjectPath` +
  `StartedAt`), `ConversationEvents` (`ConversationId` with cascade, `Seq`, `Json` as text; key on both) and
  `ConsoleRules` (`ProjectPath`, `Rule`, `CreatedAt`; key on both).
- Every event is stored, then sent to all console connections, under the conversation's lock, so every connection and
  a replay see one order. `Json` is the event as it was sent (text, not `jsonb`). Text deltas are sent at once and
  stored as one row per `messageId`, written before the next other event; `GetConversation` returns the project's
  latest conversation (by `StartedAt`) with its rows and the text still open. A failed insert is logged and the event
  is still sent.
- At start (a hosted service, so `create-user` never runs it) the API creates `Console:ConfigDirectory` with mode
  0700. No claude process runs while the host starts: before the first claude process the API runs
  `<Console:ClaudePath> --version` within 10 s with the console's environment, and a failed check is repeated by
  the next prompt. Below 2.1.285, or without the CLI, the error log says so and the console answers "Konsola
  niedostępna"; `GetConversation` and `StartConversation` still work. The version found is logged.
- One long-lived process per conversation, started at the first prompt that finds none, in the real path of
  `projectPath`, without a shell, with `--session-id <conversation id>`, or `--resume <conversation id>` once the CLI
  has reported that id as its session (`system/init`, `Conversations.Resumable`):
  ```
  claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
    --permission-prompt-tool stdio --restricted
    --tools Bash,Read,Edit,Write,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,TaskCreate,TaskGet,TaskList,TaskUpdate,TaskStop,ToolSearch,ExitPlanMode
    --strict-mcp-config --disable-slash-commands --no-chrome --settings <json> --model <m> --effort <e> --permission-mode <mode>
  ```
  `--settings` is `{"disableAllHooks":true,"permissions":{"blockReadsOutsideWorkingDirectories":true,"allow":[…]},
  "cleanupPeriodDays":90}`, plus `apiKeyHelper` with `Console:ApiKeyFile`. `--restricted` ignores the user, project and
  local settings files, so a cloned repository's `.claude/` settings (hooks, `env`, `apiKeyHelper`, allow rules) are
  not used, and with `--strict-mcp-config` neither is its `.mcp.json`.
- The process's environment: the allowlist of `Processes/ChildEnvironment`, then `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`
  and `DBUS_SESSION_BUS_ADDRESS` when the API has them (as for git, so `git push` in a step reaches the credential
  helper), `CLAUDE_CONFIG_DIR`, `DISABLE_UPDATES=1`, `DISABLE_AUTOUPDATER=1`, `TERM=dumb`, then `Console:Environment`.
  The API's own variables (the connection string, `ANTHROPIC_API_KEY`, `CLAUDECODE*`) never reach the CLI. The CLI
  also opens a socket under `/tmp/cc-socks/`, outside its config directory.
- `initialize` must answer within 30 s. Before every prompt `set_model`, `set_permission_mode` and
  `apply_flag_settings {effortLevel}` are sent and each reply awaited (10 s; then "Konsola nie odpowiada" and the
  process is killed). Then `prompt` and `status working` are stored and sent, and the prompt goes to stdin as a `user`
  line with `origin: {kind: "human"}` and a new `uuid`. A prompt starting with `/` also gets `client_composed: true`,
  so the CLI gives it to the model as text instead of running its own command; that turn goes without the CLI's
  attachments such as nested CLAUDE.md files. Every stdin line is written under one lock within 10 s.
- One reader per process handles each stdout line (at most 16 MB; a longer one kills the process) before the next,
  awaiting each store and send; replies to the API's own control requests are matched without the conversation's lock.
  Only the conversation's own lines count (`parent_tool_use_id` null). Text deltas come from `stream_event`
  `text_delta`, with `messageId` `<message id>:<block index>`. A step goes out when its tool's `tool_result` arrives:
  `stepId` is the `tool_use` id; kind `read` (Read), `edit` (Edit, NotebookEdit, a Write that updates a file), `write`
  (a Write that creates one), `command` (Bash), `search` (Glob, Grep) or `other` (WebFetch, WebSearch, Task); the target
  relative to the conversation's directory (absolute outside it). Task bookkeeping, ToolSearch and ExitPlanMode have no
  step, nor does a tool that did not run (`non_execution_kind`). A command's output is its stdout, then its stderr when
  not empty, or the result's text when it failed; other tools show output only on an error. A tool the CLI refuses by
  itself (`system/permission_denied`, e.g. a file outside the directory) is a step of kind `other` with the CLI's reason
  as error output. `result` ends the turn: `idle`, `idle` "przerwano" after an interrupt, or `error` "Polecenie
  zakończone błędem: <text, at most 500 characters>". Thinking, rate limits, costs and unknown lines are ignored. Every
  control request of the CLI is answered; one the console does not support gets an error reply.
- `Interrupt` sends the CLI's `interrupt` request; open questions end as denied at once. Without a `result` within 10 s
  the process tree is killed and the turn ends as `idle` "przerwano". An unknown or idle conversation is a no-op.
- A process that ends during a turn ends the turn: open questions denied, then `status error` "Proces konsoli
  zakończył się (kod N)."; one that ends while idle sends nothing (exit code 1 after an interrupted turn is normal). A
  `--resume` launch that fails stores and sends `status error` "Nie udało się wznowić rozmowy. Zacznij nową („Nowa”).";
  every failed start answers "Konsola niedostępna".
- At most 8 live processes: a launch closes the least recently used idle one, and with 8 busy it is refused ("Za dużo
  aktywnych rozmów"). A process without a turn for 15 minutes gets EOF on stdin and is killed 5 s later if it still
  runs (checked every minute); the next prompt resumes the conversation.
- On a graceful stop open turns are interrupted and stdin is closed; whatever runs after 5 s in total is killed, and
  the turns end as `idle` "przerwano". At start a conversation whose log ends with `working` or `waiting` gets `deny`
  for its unanswered questions and `status error` "Serwer został zatrzymany w trakcie pracy.". Logout and session
  expiry close the connections, not the turns; the next login replays them.
- In plan mode the CLI may run another model than the chosen one; the console leaves that to the CLI.
- Questions come as the CLI's `control_request` `can_use_tool` on stdout (`--permission-prompt-tool stdio`) and are
  answered with a `control_response` on stdin; a question has no time limit. Each gets a new GUID as its `requestId`.
  `description`: Bash's whole `command`; for Read, Edit, Write and NotebookEdit the path relative to the conversation's
  directory (absolute outside it); WebFetch's `url`; ExitPlanMode's `plan`; otherwise `<tool> <input as JSON>`; never
  the text the model wrote. `alwaysRule` is `Tool(ruleContent)` only when `permission_suggestions` holds exactly one
  `addRules` entry that allows exactly one rule and `suppress_always_allow_rule` is not set (file edits never have
  one). Then `status waiting`. Read-only commands such as `git status` never ask inside the directory; reads outside it
  ask (`blockReadsOutsideWorkingDirectories`).
- `AnswerPermission` checks `decision` first ("Nieznana decyzja"). An unknown conversation or `requestId`, or one
  already answered, is silent (the first answer wins); `allow-always` without a rule fails ("To pytanie nie ma reguły
  do zapisania") and leaves the question open. `permission-resolved` (then `status working` when no other question is
  open) is stored and sent before the answer is written, so the allowed tool's step always follows its question. The
  CLI gets: allow → `{"behavior":"allow","updatedInput":<the input as received>}`; an allowed ExitPlanMode → the same
  plus `setMode default` for the session, so edits ask again; allow-always → the same plus the one rule as `addRules`
  with `destination: "session"`, and the rule is saved in `ConsoleRules` for the conversation's `projectPath`; deny →
  `{"behavior":"deny","message":"The user denied this action."}`. A question the CLI withdraws
  (`control_cancel_request`) ends as denied.
- A project's rules go to every launch in `--settings` `permissions.allow`, so they hold for new and resumed processes;
  the CLI never writes `.claude/settings.local.json`.
- `added`/`removed` of an edit or write: for a new file the lines of its content, otherwise the `+` and `-` lines of
  the CLI's `structuredPatch` (`\ No newline at end of file` counts as neither). An edit that succeeded also sends
  `files-changed` with its `filePath` relative to the projects directory; paths outside it or inside `.git` are left
  out.
- When a turn ran a command and the conversation's project is a repository, `result` first sends `files-changed` with
  every path whose git status (`Repositories.Status`) differs from the status at the prompt (new, gone or changed). A
  file the command changes again after it was already modified is missed; a save of it then gets the editor's `409`.
- A step's output over 32,000 characters keeps its end after `⟨pominięto N znaków⟩`.
- Conversations whose last event is more than 90 days old are deleted with their events, at start and every hour
  (`ConversationCleanup`, by `TimeProvider`); the rules stay. The CLI keeps its transcripts as long
  (`cleanupPeriodDays: 90`).

Commands (`dotnet run --project src/Claushh.Api -- <command>`; on the server as `workspace`, with the service's
environment file and a terminal, through `systemd-run`: README.md, "Deployment", step 10):

| Command | What it does |
|---|---|
| `create-user` | creates the single account: user name, password (at least 12 characters, no echo), TOTP key and `otpauth://` URI, switched on only after a correct code; refuses when an account exists |
| `create-user --reset-totp` | a new TOTP key for the existing account (after a correct code), all its sessions ended and the lockout cleared |
| `create-user --reset-password` | a new password for the existing account (at least 12 characters, different from the current one, no echo, typed twice), all its sessions ended and the lockout cleared; the TOTP key stays |

Migrations: `dotnet tool restore`, then
`ASPNETCORE_ENVIRONMENT=Development dotnet ef migrations add <Name> --project src/Claushh.Api --output-dir Data/Migrations`.
`migrations add` does not connect to the database; without a user-secret, pass any connection string in
`ConnectionStrings__Claushh`. The connection string can also go to the app as an argument: `dotnet ef migrations add
<Name> --project src/Claushh.Api --output-dir Data/Migrations -- --ConnectionStrings:Claushh=Host=localhost`.

Folders in `src/Claushh.Api/` (each is created together with the code it concerns). Existing: `Auth/` (Identity, TOTP,
sessions), `Data/` (DbContext, migrations), `Files/` (files API and path protection), `Workspaces/` (workspaces),
`Git/` (repositories and git), `Processes/` (a clean child environment, shared by git, the terminal and the console),
`Hubs/` (SignalR hubs: the Origin check, the session check, the terminal and console hubs), `Terminal/` (tmux, the
terminals), `Frontend/` (the built frontend and the security headers), `Notifications/` (phone notifications of
logins), `Claude/` (the console: the claude CLI and its conversations; not `Console/`, whose namespace would hide
`System.Console`).

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
| Integration + older unit | `cd web && npm test` | Vitest (jsdom). Integration: `console.integration.spec.ts` (panel + store + editor, SignalR and HTTP stubbed; also permission requests: hidden characters, button delay, "tak, zawsze", and a double Enter), `workspaces.integration.spec.ts` (Workspace panel + router + git status + explorer + editor, HTTP stubbed; also the strict clone URL validation), `security.integration.spec.ts` (AuthService + interceptor + SessionTimer + the "Bezpieczeństwo" window, HTTP, reload and clock stubbed; also expiry without a server response), `logout-confirmation.integration.spec.ts` (routes with guards + AuthService + login screen after an unconfirmed logout, also with a newer session from another tab), `login-wait.integration.spec.ts` (routes with guards + AuthService + login screen after a `429`: the wait in seconds, minutes or hours). Older unit tests: auth, files API, paths, explorer, `EditorStore` |
| E2E | `cd web && npm run e2e` | build + Playwright in Chromium on `e2e/mock-api/server.mjs`: login and sessions (including unconfirmed logout with "Back", a new tab and logging in again, embedding in a frame, Trusted Types), explorer and Monaco, console (steps, options, permissions, "tak, zawsze", interrupt, replay, multiple tabs, file changes), workspaces (opening a repo, git status, pull, push, create, clone, a conversation per repo), terminal (commands, keys, reload without duplicates, multiple terminals, `exit`, Ctrl+S, resizing, pasting with the decision panel, characters on a dropped connection without loss or duplication, also after closing the tab, queue limit, focus, OSC 8 links, no answers to terminal queries, closing a terminal that another tab already closed), session (countdown, "Przedłuż", activity once a minute on a fake clock, expiry, also without a server response and hubs closed by the server), the "Bezpieczeństwo" window with a second device (a separate browser context), diff view, Monaco worker startup, mock robustness and the contract rules that the frontend does not let through (clone URL, XSRF token bound to the identity, saving like the files API: `absent`, 5 MB, a NUL character, workspace, repo and path parameters). **Every test** (`fixtures.ts`) fails when the page reports a CSP or Trusted Types violation, an unhandled exception (including one caught by Angular's ErrorHandler, `console.error('ERROR', …)`) or Monaco does not create a worker |
| Backend | `dotnet test` (needs Docker) | xUnit integration tests over HTTP (`WebApplicationFactory`, PostgreSQL 17 from Testcontainers, a test clock): login and its failures, `me`, `keepalive` and both deadlines, logout and 409, ending another session, XSRF token bound to the session, `no-store`, closed `/api/*`, the built frontend (the page for app paths with its CSP and `no-store`, file types and `no-cache`, `/api` and `/hubs` paths and missing files never the page, the security headers on every response, the start check of `Frontend:Root`), `create-user`, TOTP codes used once, the limit per IP, the client address behind Cloudflare (`CF-Connecting-IP` and `X-Forwarded-Proto` only from a loopback peer, `X-Forwarded-For` ignored, IPv6 limited per /64, IPv4-mapped peers as IPv4), the account lockout and its growth, a login that cannot start within 10 s, session list, `revoke-others`, login history, cleanup, the password reset, login notifications (content, one for the start of a lock and none for failed attempts, a failing or unreachable ntfy, the start check), the files API (listing, symlinks, `.git`, reading, saving, conflicts, re-creating a deleted file, limits, text rules, file modes, long names, two saves at once, empty error bodies), workspaces and git (the repository list and its order, what is and is not a repository, every git status, ahead and behind, HEAD content with a checkout's line endings and the files API's limits), workspaces (the list and its order, names and directories, creating, a stale row), cloning (every refused URL, git's own errors, the time limit against a server that never answers, only https), pull and push (every answer, both paths of a rename, a branch without commits, two pulls at once, a hook that refuses, only https), the background fetch (every 5 minutes by the test clock, a pull or push taking the repository from a fetch that hangs), the hubs (session and Origin on the WebSocket, WebSockets only, connections closed on logout, ending a session, revoke-others, expiry and a revocation by another process, hub calls never extending the session), the terminal (opening in a directory by its real path, titles, refused paths, the limit, output seq without gaps, the allowlisted environment, exit, close, the start routine), attach and input (snapshot with CRLF, every line exactly once when attaching during output, bracketed paste restored, a batch sent twice typed once, Input only after Attach on the same connection, inputSeq after a reconnect, batch limits, UTF-8 across send-keys commands, resize limits, an exited terminal, an unknown id, the history and normal screen before the switch to the alternate screen and the program's own text after it), the console hub (refused paths, the conversation event in every tab, the latest conversation, the stored events as sent, the config directory's mode, session and Origin), the claude process (the command line, its directory and environment, events in contract order, replay with merged text and the open text, options before every prompt, busy and unknown conversations, prompt and option limits, prompts starting with "/", tools the CLI refuses, unknown control requests, interrupts, also ignored ones and an exit after them, a process that ends, a failed resume, recovery at start, the process limit, idle processes, an old CLI, logout during a turn), the console's questions (the command and its rule, deny, allow, allow-always and the next launch's rules, a write question, unknown decisions and requests, two tabs, several suggested rules, plan approval, interrupt and exit with a question open, a withdrawn question), edit counts, files-changed for edits and for commands in a repository, the output cap, 90-day retention; needs the git CLI ≥ 2.45 (`--ref-format=reftable`) |

Backend tests make repositories with the git CLI (`tests/Claushh.Api.Tests/TestGit.cs`): a fixed identity and date,
`HOME` set to a temporary directory so the machine's `~/.gitconfig` stays out (libgit2's configuration search paths
point there too), and bare repositories in a second temporary directory as remotes. `ApiFactory` writes a global git
configuration and binds it to `Git:Environment:GIT_CONFIG_GLOBAL` (`ConfigureWebHost`), so the git the API starts
(through `ChildEnvironment`'s allowlist, not through the test process's own environment) also uses it:
`https://git.test/<name>.git` leads to the bare repositories, and the file transport they need is allowed (the API's
`-c protocol.allow=never` still refuses everything but https). `TestGit` sets `HOME` itself for the git processes it
starts directly, independently of this. Tests shorten `Git:NetworkTimeout` with `ApiFactory.SetNetworkTimeout`.
`ApiFactory.ResetAsync` stops the background fetches of the previous test and forgets their times
(`BackgroundFetch.ResetAsync`).
Hub tests connect with the SignalR .NET client over the in-memory server's WebSocket (`tests/Claushh.Api.Tests/TestHub.cs`):
WebSocket only, no negotiation, the browser's cookies and Origin: `https://localhost` (`Hubs:AllowedOrigins` in the tests).
`ApiFactory` also writes a stand-in frontend build to a temporary `Frontend:Root`: `index.html` with a known CSP `<meta>`,
one file of each type, and decoys under `api/` and `hubs/` that must never be served.
`ApiFactory.WaitForALockWaitAsync` waits until a connection of the API waits for a lock a test holds (a row or a table).
`ApiFactory` sets `Notifications:NtfyUrl` to `https://ntfy.test/claushh-test` and replaces ntfy with `TestNtfy`, the
primary handler of the API's `ntfy` client: it records every notification and can answer 500 or throw. Every login of
the run sends one, so the notification tests use their own addresses.
From the terminal on, `dotnet test` needs tmux 3.7 or later on PATH. `ApiFactory` gives the API a tmux directory and a
HOME in temporary directories and `/bin/sh` as the shell, and sets `CLAUSHH_TEST_CANARY` and `ConnectionStrings__Canary`
in the test process (the terminal tests check that they never reach the shell). `ApiFactory.ResetAsync` closes every
terminal. `TestTerminal` is a browser tab on `/hubs/terminal`; tests that type before `Input` exists in them use the
tmux CLI on the test server (`ApiFactory.Tmux`).

Console tests never run the real `claude`. `ApiFactory` sets `Console:ClaudePath` to the fake CLI next to the tests
(`tests/Claushh.FakeClaude`; the project reference copies its apphost there), `Console:ConfigDirectory` to a temporary
directory and `Console:Environment:DOTNET_ROOT` (the fake is a .NET app with only the allowlisted environment). A test
writes a conversation's script to `<config>/fake/<conversation id>.jsonl` (`TestClaude`): recordings from
`tests/Claushh.Api.Tests/ConsoleRecordings/` (hand-written or scrubbed CLI output; a test refuses paths under `/home/`,
`@`, UUIDs, API ids other than the `*_fixtureN` placeholders, the user name and usage data) and inline steps. The fake
logs every launch (arguments, working directory, environment) and every stdin line. `TestConsole` is a browser tab on
`/hubs/console`; its calls and waits give up after 20 s. `ApiFactory.ResetAsync` ends every console process, deletes
the fake's files and empties the console's tables.

Notes on e2e:
- The mock has one shared state, the tests run sequentially and start with `POST /__test/reset`. It listens only on
  `127.0.0.1` (the `/__test/*` endpoints have no authentication), and a malformed request ends with `400`, not a crash.
- E2E files import `test` and `expect` from `./fixtures`, not from `@playwright/test`.
- Failures on demand: `POST /__test/drop-sockets` (drops the hub connections without ending the session),
  `POST /__test/fault?dropInputAck=N&downAfterDropMs=D&attachDelayMs=M&hubDownMs=K` (loss of `Input` acknowledgments
  with a D ms outage, a slow `Attach`, hubs unavailable for K ms).
- A second browser ("second device") via the `newDevice` fixture, so that it is also under CSP control.
- The session idle time in the mock can be shortened: `POST /__test/session-timeout?idle=<s>`.
- A repository's ahead/behind in the mock can be set directly: `POST /__test/repo-state {"repo","ahead"?,"behind"?}`,
  so a test gets its own push/pull state (e.g. a rejected push) without adding a fourth repository, which would move
  the list order and counts other tests pin.
- Git in the mock is simulated: the "committed" state is the file content from the reset, the status is the difference from it.
- Browser: `npx playwright install chromium` or the `CHROMIUM_PATH` variable pointing to the system Chromium.
- Monaco and xterm display spaces as `\u00a0`. `helpers.ts` → `editorText` and `terminalText` normalize the text.
- `CodeEditor` (Monaco) and `TerminalView` (xterm) do not work in jsdom, so they are tested only in e2e.
