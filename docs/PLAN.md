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
| Status bar | branch, number of changes, console status, cursor position, tunnel status |

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
- Login attempt limit (`RateLimiter`) and lockout after several failures.
- Phone notification on every login (ntfy or Telegram).
- Cookies `HttpOnly`, `Secure`, `SameSite=Strict`, antiforgery.
- Short sessions (e.g. 30 minutes of inactivity), list of active sessions, "wyloguj wszędzie" (log out everywhere).
- `[Authorize]` on SignalR hubs and checking the `Origin` header on WebSockets.
- `ForwardedHeaders` trusts only the local `cloudflared`, the real IP from the `CF-Connecting-IP` header.

### Limiting damage

- Everything runs as the `workspace` user without administrator privileges.
- systemd: `ProtectSystem=strict`, `ProtectHome=true` (except the `workspace` home),
  `ReadWritePaths=/srv/projects`, `NoNewPrivileges=true`.
- Every file API checks whether the path after `Path.GetFullPath` (and resolving symlinks) lies
  inside the projects folder.
- GitHub token with access only to selected repositories.
- Secrets in an environment file with `600` permissions or through `LoadCredential=`, never in the repo.
- By default the console asks for permission before edits and commands such as `git push`.

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
- [ ] **Stage 1: login and access.** Identity with TOTP, a single account created by a command, sessions,
      rate limiting, login history, notifications, ForwardedHeaders, Cloudflare Tunnel, systemd service.
- [ ] **Stage 2: files and editor.** Files API with path protection, file tree, Monaco with saving.
- [ ] **Stage 3: console.** `claude` process with stream-json, Console panel, model / effort / mode,
      permission requests through MCP, resuming conversations.
- [ ] **Stage 4: git, terminal, workspaces.** Workspace panel, status / diff / commit / push,
      terminal xterm.js + PTY + tmux.
- [ ] **Stage 5: polish.** Colors, diff view, session list and "wyloguj wszędzie" (log out everywhere), passkeys,
      backups, a possible phone view.
