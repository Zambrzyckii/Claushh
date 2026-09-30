# Claushh project plan

A private web portal for working on projects from any device. It runs on a home computer,
and in the browser it provides a code editor, a console for Claude Code, a terminal and git support. The code stays on the server
and is pushed from there to GitHub.

> This document describes **the goal and decisions**. The current state of the code and the repository map are described in
> [`ARCHITECTURE.md`](ARCHITECTURE.md). After every plan change or completed stage, update both files.

## Assumptions

- **One user.** There is no registration, the account is created once during installation.
- **Access from any device and network** through a regular browser, without installing anything.
- **Security over convenience.** The portal gives full control over the projects folder and access
  to GitHub, so every security layer is mandatory.
- **Official tools.** The console runs the official `claude` CLI logged in to the owner's account.

## Interface

Mockup: https://claude.ai/artifact/Dq73kRw5FM9eADKQugRdfd (private).

Layout modeled on VS Code:

| Area | Contents |
|---|---|
| Top bar | workspace / repo / branch path, session countdown, panel toggles, "Wyloguj" (log out) |
| Left | file tree, marking of changed files (`M`) |
| Center | editor (Monaco) with tabs, syntax highlighting and manual editing |
| Right | collapsible **"Konsola"** (console) panel: conversation with Claude as plain monospace text, without icons, colors or the name "Claude"; under the prompt field a choice of **model**, **effort** and **mode** (ask before edits / accept edits / plan); permission requests (tak / tak, zawsze / nie) |
| Bottom | collapsible panel with the tabs **Workspace** (list of workspaces and their repositories: branch, status, last commit, Otwórz (open) / Pull / Push) and **Terminal** |
| Status bar | branch, number of changes, console status, cursor position |

The mockup also shows a tunnel status in the status bar. It was dropped as it would add nothing: through the tunnel
the page does not load at all while the tunnel is down, and a tunnel that fails while the page is open already shows
in the status bar as "Konsola: brak połączenia" (console status).

Colors: dark theme with a single amber accent, to be refined in later iterations.
Fonts: IBM Plex Sans (interface), JetBrains Mono (code, console). In the terminal the Nerd Font version,
so that the icons from the dotfiles prompt work.

Devices: mainly laptop and PC. The phone is secondary.

## Tech stack

| Layer | Solution |
|---|---|
| System | EndeavourOS with the owner's dotfiles, system user `workspace`, systemd service with sandboxing |
| Backend | ASP.NET Core (.NET 10), SignalR, ASP.NET Core Identity (TOTP, passkeys) |
| Database | PostgreSQL 17 in Docker (pinned version, only `127.0.0.1`), EF Core + Npgsql |
| Frontend | Angular, Monaco (`ngx-monaco-editor-v2`), xterm.js, `@microsoft/signalr` |
| Console | process `claude -p --output-format stream-json --input-format stream-json` |
| Terminal | PTY (Pty.Net) + tmux, so that sessions survive closing the tab |
| Git | LibGit2Sharp for status and diffs, `git` CLI for pull/push |
| Access from outside | Cloudflare Tunnel (+ optionally Cloudflare Access) |

### Claude Code integration

- The backend runs `claude` in headless mode with a JSON stream. Every event (file read,
  edit, command, response) goes through SignalR to the Console panel.
- Model, effort and permission mode are process launch parameters.
- Permission requests: the `--permission-prompt-tool` flag and a small MCP server in C# (the official MCP SDK for C#),
  which forwards the request to the browser and waits for the decision.
- Claude Code stores the conversation history. In the database we keep only session identifiers (`--resume <id>`)
  assigned to repositories.
- We stay with the official CLI instead of the Agent SDK. Before any change, Anthropic's current
  authentication terms must be checked.

### Data in the database

Account and 2FA secret, active sessions and login history (date, IP, device), workspaces and repositories,
console conversation identifiers, settings (default model, effort, mode).

## Security

### Access from the internet

- No open ports on the router. `cloudflared` connects outward, the home IP is not visible,
  HTTPS and DDoS protection are on Cloudflare's side.
- Optional first layer: Cloudflare Access (code by e-mail before the page is shown at all).
- Firewall: `ufw default deny incoming`. SSH only on the home network.

### Login and sessions

- Password (hash from ASP.NET Core Identity) + **mandatory TOTP**, optionally a passkey.
- No registration endpoint. The account is created by an installation command (e.g. `dotnet run -- create-user`).
- Login attempt limit per IP and an account lockout after several wrong codes (own code, see "Backend decisions (stage 1)").
- Phone notification on every login (ntfy or Telegram).
- Cookies `HttpOnly`, `Secure`, `SameSite=Strict`, antiforgery.
- Short sessions (e.g. 30 minutes of inactivity, hard limit of 12 h), extended only by user activity,
  list of active sessions, login history, "wyloguj wszędzie" (log out everywhere).
- `[Authorize]` on SignalR hubs and checking the `Origin` header on WebSockets. The session is checked on every
  hub call, and open connections are closed when the session ends (including expiry).
- Expiry also works without a connection to the server: after the deadline the browser returns to the login screen on its own.
- An unconfirmed logout (e.g. a tunnel failure) does not allow returning to the app without logging in, and the browser
  retries ending the session until the server confirms.
- Content-Security-Policy (no inline scripts, with Trusted Types), no embedding in a frame (`frame-ancestors 'none'`),
  `nosniff`, `Referrer-Policy`, HSTS. Details: `ARCHITECTURE.md`, "Security headers".
- `ForwardedHeaders` trusts only the local `cloudflared`, the real IP from the `CF-Connecting-IP` header.

Backend decisions (stage 1):
- Password: at least 12 characters, without composition rules (length matters more, and TOTP is mandatory anyway).
- EF Core migrations are applied at startup (one instance; no separate deployment step). The connection string comes
  from `dotnet user-secrets` in development and from an environment variable on the server, never from the repository.
- Backend tests are integration tests over HTTP with a real PostgreSQL 17 (Testcontainers), not a database mock.
- Sessions live on the server in the `Sessions` table: the cookie holds a random secret, the database only its SHA-256.
  Identity is used only for the user, the password hash and the TOTP key (the codes are checked by own code, below).
  Rejected: the Identity cookie with `ITicketStore` (one expiry per ticket, so two deadlines, a session list and
  revoking need workarounds around a serialized blob) and the plain Identity cookie with the security stamp (it cannot
  end a single session).
- The XSRF token is bound to the session, not only to the user (`IAntiforgeryAdditionalDataProvider`), and one filter on
  `/api` validates it for POST/PUT/PATCH/DELETE: the built-in antiforgery middleware skips DELETE and does not stop the request.
- Closed by default: `FallbackPolicy` requires a session; anonymous are only `/api/health`, `GET /api/auth/me` and
  `POST /api/auth/login`.
- Development runs over plain http, where ASP.NET antiforgery refuses `Secure`-only cookies, so there the cookies have no
  `__Host-` prefix (`Sessions:SecureCookies=false`). Behind Cloudflare Tunnel requests also reach the API as HTTP,
  so production needs `ForwardedHeaders` (stage 1, part C) first.
- The account is created only by `create-user` on the server; TOTP is switched on only after a correct code from the app,
  in one transaction. A lost phone: `create-user --reset-totp` (a new key, all sessions ended, the lockout cleared),
  which needs shell access to the server anyway. A leaked password: `create-user --reset-password` (a new password,
  all sessions ended, the lockout cleared), which asks only for the new password, because shell access proves more
  than the old one. There are no recovery codes, because the login contract has only `totpCode`.
- TOTP codes are checked by own code (RFC 6238, the step of now ±1) that stores the last accepted step and rejects that
  step and earlier ones, so a code works once. Rejected: Identity's validator (±2 steps, the real clock, no reuse check)
  with a remembered last code (another, older code from the same window would still pass).
- Login protection has two layers in own code (`LoginGuard`, time from `TimeProvider`): a limit of failed attempts per
  IP protects the password, the account lockout protects the code. Rejected: the `RateLimiter` middleware and Identity's
  lockout (both use the real clock, so their windows cannot be tested without waiting; the middleware also counts
  successful requests and forgets everything on restart). Logins run one at a time in the API process, so parallel
  attempts cannot slip between a check and its write.
- The login history records every attempt that reaches the check, also for unknown names (guessing stays visible), but
  never the typed name (it sometimes holds a mistyped password) and not attempts refused with 429 (a flood would drown
  the list).
- The limits are constants in code (10 failures per IP in 15 minutes, 5 wrong codes, lockouts from 15 minutes to
  24 hours, 90 days). Rejected: configuration (nothing to tune for one user, and a setting could weaken the protection
  by accident).
- The User-Agent is stored as sent (cut to at most 256 characters) and turned into "Chrome · Linux" on read
  (`DeviceName`, the mock's rules). Rejected: formatting on write (a fix of the rules would need a data migration).
- The account lockout counts only wrong or reused codes after a correct password (5 → 15 minutes the first time), so a
  stranger without the password cannot lock the only account. While it is locked every login gets 429 whatever the
  credentials (a 429 only after a correct password would confirm the password, and a 401 would not tell the owner why
  login fails). The way out is `create-user --reset-totp` or `--reset-password` on the server, which also clear the
  lockout. Rejected: a separate unlock command (one more command for the same situation; shell access proves more than
  a code).
- Repeated lockouts grow: every lock in a row without a successful login lasts twice as long (15 minutes up to
  24 hours), so someone who knows the password gets about 35 code guesses on the first day and 5 a day after that,
  instead of 480 a day. Rejected: a lock that lasts until `create-user` (SSH works only from the home network, so the
  owner could not unlock it while away).
- Login attempts and ended sessions are deleted 90 days after they ended, by a background cleanup at start and every
  hour. A cleanup error is only logged: by default a failing background service stops the whole API.

Backend decisions (stage 2):
- The projects directory is the configuration key `Projects:Root` (`/srv/projects` in `appsettings.json`, a user-secret
  in development, a temporary directory in tests), checked when the API starts: an absolute path to an existing
  directory, otherwise the API refuses to start, with a message naming the key. The directory may itself be a symlink:
  `ProjectPaths` resolves it once to its real path (and refuses `/`). Rejected: a constant `/srv/projects` (development
  and tests need other directories) and a check on first use (a misconfigured server would start and fail on every
  request).
- A path in the API is `""` (the projects directory itself) or non-empty segments joined by `/`, none of them `.`, `..`
  or `.git`, with no leading `/`, no `\` and no NUL: the rules of the frontend's `isSafeRelativePath`, plus no `.git`
  segment. Anything else is `400`. Rejected: normalising bad input (e.g. dropping a doubled `/`), because the API would
  accept paths the frontend never sends.
- The joined path is resolved like `realpath(3)`: every component, relative targets, `..` inside targets, loops. The
  result must be the projects directory or lie under it, so a link in the middle of a path cannot lead out either. A
  path whose last component is a dangling symlink, or whose resolution loops, is `400`; any other path that does not
  exist is `404`. Rejected: lexical checks (`Path.GetFullPath`), which do not see symlinks, and a managed walk over
  `LinkTarget`, which would re-implement the kernel's path resolution with its corner cases.
- Listings include dotfiles (`.gitignore`, `.env`): .NET's directory enumeration skips hidden entries by default (on
  Linux, names starting with `.`), so the listing asks for all of them. They leave out `.git`, symlinks that lead
  outside, nowhere or in a loop, and special files. A symlink that stays inside is listed with its target's kind and
  keeps its own path. Rejected: the default (dotfiles would vanish from the explorer).
- `.git` (a directory or a file) is left out of listings, and a path with a `.git` segment, before or after resolution,
  is `400`. Rejected: only hiding it in the listing (the contract's minimum), because the editor could still read
  `.git/config` or corrupt git's files with a direct request.
- Only directories and regular files are treated as such; FIFOs, sockets and devices are left out of listings. The file
  type comes from `statx(2)` without following a final symlink. Rejected: treating them as files, because opening a
  FIFO blocks the request forever and .NET has no public API that tells a FIFO from a regular file.
- `realpath` and `statx` are called through P/Invoke (`Files/Libc.cs`), so the backend runs only on Linux, like the
  deployment.

### Limiting damage

- Everything runs as the `workspace` user without administrator privileges.
- systemd: `ProtectSystem=strict`, `ProtectHome=true` (except the `workspace` home),
  `ReadWritePaths=/srv/projects`, `NoNewPrivileges=true`.
- Every file API checks whether the path after `Path.GetFullPath` (and resolving symlinks) lies
  inside the projects folder.
- GitHub token with access only to selected repositories.
- Secrets in an environment file with `600` permissions or through `LoadCredential=`, never in the repo.
- By default the console asks for permission before edits and commands such as `git push`. The request shows the command with all
  hidden characters, and a permanent permission ("tak, zawsze" – yes, always) requires a known rule and confirmation.
- Terminal: pasted text without control characters, multiple lines only after confirmation, typed characters are not lost
  or duplicated when the connection drops.

### Using untrusted computers

Whenever you log in on someone else's computer (e.g. in a computer lab), always log out
and do not save the password in the browser. The password alone without the TOTP code gives nothing.

## Deployment on EndeavourOS

- Packages: `dotnet-sdk`, `aspnet-runtime`, `cloudflared`, `docker`, `git`, `tmux`, the `claude` CLI.
- A `workspace` user with its own home directory, cloned dotfiles, a logged-in `claude`
  and a configured `git`. Projects in `/srv/projects`.
- API as a systemd service (self-contained build, so that system updates do not break it).
- PostgreSQL from `deploy/docker-compose.yml`.
- `cloudflared` as a systemd service.
- No sleep (`HandleLidSwitch=ignore` on the laptop), automatic power-on after a power outage in the BIOS.
- Updates (`pacman -Syu`) manually, after each one check that the portal works.
- Backup: a daily `pg_dump` from a systemd timer.

## Stages

The order is chosen so that only already secured things reach the internet.

- [x] **Stage 0: skeleton.** Repo structure, documentation, empty backend with `/api/health`,
      Angular with the layout from the mockup, Postgres in Docker Compose.
- [ ] **Stage 1: login and access.**
  - [x] Frontend: login form (username, password, TOTP), `authGuard` / `guestGuard`, logout
        with state cleanup, handling of an expired session, tab synchronization, protection against bfcache and open redirect.
  - [x] Backend, part A: PostgreSQL + EF Core, Identity with TOTP, a single account created by a command (`create-user`),
        server-side sessions, `me` / `login` / `logout` / `keepalive`, ending another session, antiforgery bound to the session.
  - [x] Backend, part B: lockout, rate limiting, blocking reuse of a TOTP code, login history, session list,
        `revoke-others`, cleanup of old rows, growing lockouts, password reset.
  - [ ] Backend, part C: security headers and serving `index.html`, ForwardedHeaders, notifications.
  - [x] Frontend: session countdown in the top bar (stage 5).
  - [ ] Deployment: Cloudflare Tunnel, systemd service.
- [ ] **Stage 2: files and editor.**
  - [x] Frontend: explorer with lazy loading, Monaco with tabs, saving (Ctrl+S), detection of
        conflicts with changes on disk, status bar (cursor, language, unsaved).
  - [ ] Backend: files API from the contract in `ARCHITECTURE.md`, path protection (including symlinks), file versions,
        size limits, binary file detection.
  - [x] Marking of changed files (`M`, `U`, …) in the explorer (frontend, based on the git status from stage 4).
- [ ] **Stage 3: console.**
  - [x] Frontend: Console panel (plain text), model / effort / mode, permission requests, interrupt (Esc),
        new conversation, replaying the conversation after a reload and in other tabs, refreshing files changed
        by the console, SignalR connection with session control.
  - [ ] Backend: hub `/hubs/console` from the contract in `ARCHITECTURE.md`, `claude` process with stream-json,
        permission requests through MCP (`--permission-prompt-tool`), storing conversations, resuming (`--resume`).
- [ ] **Stage 4: git, terminal, workspaces.**
  - [x] Frontend: Workspace panel (workspaces, repository table, Otwórz (open) / Pull / Push, creating a
        workspace, cloning), open repo in the URL, path and branch in the top bar, branch and number of changes
        in the status bar, git markers in the explorer, a separate console conversation for each repo.
  - [x] Frontend: Terminal tab (xterm.js): multiple terminals, reattaching after a reload without losing
        or duplicating output, size fitting, `exit`, Ctrl+S for the program in the terminal.
  - [ ] Backend: workspaces and git API and hub `/hubs/terminal` from the contracts in `ARCHITECTURE.md`
        (terminal: PTY + tmux).
- [ ] **Stage 5: polish.**
  - [x] Frontend: session countdown with extension on activity, "Bezpieczeństwo" (security) dialog (active sessions,
        login history, "Wyloguj pozostałe sesje" (log out other sessions) and "Wyloguj wszędzie" (log out
        everywhere)), diff view against HEAD in the editor.
  - [x] Frontend: fixes from the security review (pasting and typing in the terminal, OSC 8 links, focus,
        permission requests in the console, strict clone URL, unconfirmed logout without returning to the app,
        expiry without the server, "Wyloguj wszędzie", CSP with Trusted Types and headers, XSRF token bound to the identity,
        mock only on `127.0.0.1`), verified in several rounds of independent review, with integration and e2e tests.
  - [ ] Backend: passkeys, backups.
  - [ ] Colors (the owner will refine them in later iterations), a possible phone view (low priority).
