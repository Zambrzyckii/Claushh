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
| Terminal | tmux in control mode (`tmux -C`), no PTY package; terminals end with the API |
| Git | LibGit2Sharp for everything local (status, branches, HEAD content), the git CLI for clone, fetch, pull and push |
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

Account and 2FA secret, active sessions and login history (date, IP, device), the display names of workspaces,
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
- `ForwardedHeaders` trusts only a loopback peer (the local `cloudflared`; any local process could set the header, and a
  local process already has a shell): the real IP from the `CF-Connecting-IP` header, the scheme from
  `X-Forwarded-Proto`.

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
- Closed by default: `FallbackPolicy` requires a session; anonymous are only `/api/health`, `GET /api/auth/me`,
  `POST /api/auth/login` and the built frontend (static files and the `index.html` fallback, the same files for
  everyone, no data).
- Development runs over plain http, where ASP.NET antiforgery refuses `Secure`-only cookies, so there the cookies have no
  `__Host-` prefix (`Sessions:SecureCookies=false`).
  Behind Cloudflare Tunnel requests also reach the API as HTTP; `ForwardedHeaders` takes `X-Forwarded-Proto: https` from
  the local `cloudflared`, so production keeps `Secure` and the `__Host-` prefix.
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

Backend decisions (stage 1, part C):
- The API serves the built frontend when `Frontend:Root` holds the absolute path of `web/dist/web/browser`: static
  files before authentication, and `index.html` as the fallback for every path that does not look like a file. Without
  the key there is no frontend, and development keeps `ng serve`. Rejected: building the frontend inside `dotnet build`
  (a Node step in every backend build) and `MapStaticAssets` (it needs a manifest written at build time).
- `index.html` is `no-store`, every other file `no-cache` (one rule, never stale; ETags keep the revalidation cheap).
  Rejected: `no-cache` for `index.html`, and `immutable` for the hashed names (a possible later step).
- The CSP header is read at start from the `<meta>` of the served `index.html`, plus `frame-ancestors 'none'`; without
  the `<meta>` the API does not start, so the header cannot drift from the page. It goes only with the page: the Monaco
  workers take their CSP from their own response, and the mock never sent one there. Rejected: a copy of the policy in
  C# and the CSP on every response (untested for the workers).
- `X-Frame-Options: DENY` and the other headers of `ARCHITECTURE.md`, "Security headers", go on every response, set at
  the start of the pipeline; antiforgery's own `SAMEORIGIN` is suppressed. HSTS (12 months, `includeSubDomains`) and the
  redirect from plain http come from Cloudflare's settings. Rejected: `UseHsts` and `UseHttpsRedirection` in the API
  (Cloudflare covers both at the edge, before a request reaches the tunnel).
- No path under `/hubs` falls back to the page: unknown ones are `401` without a session and `404` with one. The
  catch-all stays when more hubs arrive, since `MapHub` routes are more specific.
- The Kestrel URL and `AllowedHosts` are left to the deployment.
- `ForwardedHeaders` runs first in every environment and reads `CF-Connecting-IP` (as the client address) and
  `X-Forwarded-Proto` only from a loopback peer, one entry each; a loopback request without `CF-Connecting-IP` keeps the
  peer's address. Rejected: `X-Forwarded-For` (its left part comes from the client),
  `ASPNETCORE_FORWARDEDHEADERS_ENABLED` (it trusts every proxy) and refusing loopback requests without the header (the
  tunnel acceptance check in "Deployment" catches that case).
- The per-IP limit counts by the IPv4 address (IPv4-mapped addresses as IPv4) or the IPv6 /64, kept in
  `LoginAttempts.LimitKey`; the history keeps the full address. Old rows are not backfilled (the window is 15 minutes).
  Rejected: a bucket per IPv6 address (a connection usually has a whole /64, so changing the address costs nothing),
  the prefix in `Ip` (the address would be lost) and an `inet` column (more code for the same query).

Backend decisions (stage 2):
- The projects directory is the configuration key `Projects:Root` (`/srv/projects` in `appsettings.json`, a user-secret
  in development, a temporary directory in tests), checked when the API starts: an absolute path to an existing
  directory whose real path is not `/`, which the API can read, write and search (saving files and creating
  workspaces write there), otherwise the API refuses to start, with a message naming the key. Without that check a root
  the API cannot use would list as empty and answer `404` for everything under it, with nothing logged. The directory
  may itself be a symlink: `ProjectPaths` resolves it to its real path at the first request that needs it (a failure is
  not remembered, so a directory that is back is used again). Rejected: a constant `/srv/projects` (development and
  tests need other directories) and a check on first use (a misconfigured server would start and fail on every
  request).
- A path in the API is `""` (the projects directory itself) or non-empty segments joined by `/`, none of them `.`, `..`
  or `.git`, with no leading `/`, no `\` and no NUL: the rules of the frontend's `isSafeRelativePath`, plus no `.git`
  segment. Anything else is `400`. Rejected: normalising bad input (e.g. dropping a doubled `/`), because the API would
  accept paths the frontend never sends.
- The joined path is resolved like `realpath(3)`: every component, relative targets, `..` inside targets, loops. The
  result must be the projects directory or lie under it, so a link in the middle of a path cannot lead out either. When
  the end of the path does not exist (or cannot be reached), the nearest ancestor that `realpath` resolves decides, and
  containment is checked first: a path that leads outside the projects directory or into `.git` is `400` even then,
  because the status code must not tell whether something exists there. A dangling or looping symlink anywhere in the
  path is `400`, and so is a name longer than the file system allows. Any other path that does not exist, or that lies
  under a directory that cannot be searched, is `404`. Other file system errors are a `500`: an unexpected error of
  `realpath`, a directory that disappears while it is listed, or a projects directory that cannot be resolved when it is
  first needed. An entry whose type cannot be read is left out of a listing (`404` when asked for directly), and a
  directory that cannot be read lists as empty. Rejected: lexical checks (`Path.GetFullPath`), which do not see symlinks, and a managed walk over
  `LinkTarget`, which would re-implement the kernel's path resolution with its corner cases.
- Listings include dotfiles (`.gitignore`, `.env`): .NET's directory enumeration skips hidden entries by default (on
  Linux, names starting with `.`), so the listing asks for all of them. They leave out `.git`, names that are not valid
  paths (a `\` in the name) or not valid UTF-8 (.NET decodes those with U+FFFD, so the name resolves to nothing),
  symlinks that lead outside, nowhere or in a loop, and special files. A symlink that stays inside is listed with its
  target's kind and keeps its own path. Rejected: the default (dotfiles would vanish from the explorer).
- `.git` (a directory or a file) is left out of listings, and a path with a `.git` segment, before or after resolution,
  is `400`. Rejected: only hiding it in the listing (the contract's minimum), because the editor could still read
  `.git/config` or corrupt git's files with a direct request.
- Only directories and regular files are treated as such; FIFOs, sockets and devices are left out of listings, reading
  one is `404`, and saving onto one (or onto a directory) is `400`. The file type comes from `statx(2)` without
  following a final symlink. Rejected: treating them as files, because opening a FIFO blocks the request forever and
  .NET has no public API that tells a FIFO from a regular file.
- A file's version is the lower-case hex SHA-256 of its bytes on disk, and a file that does not exist has the version
  `absent`. Rejected: the mock's shortened SHA-1 (fine for a mock, but the version guards overwrites) and the
  modification time (too coarse, and editors keep it).
- Text is strict UTF-8: a NUL byte anywhere, or invalid UTF-8, is `415`, so Windows-1250 and other encodings count as
  binary. A UTF-8 BOM is left out of `content` on read and written back on save when the file on disk had one; line
  endings are never changed. The editor never writes what it cannot read back: a save of content with a NUL character,
  or that has no UTF-8 form, is also `415` and leaves the file unchanged. Rejected: guessing other encodings,
  normalising line endings (every save of a Windows file would rewrite all its lines), and saving a NUL character (the
  next read would refuse the file as binary, and the editor could not open it again).
- The size limit is 5 MB (5 × 1024 × 1024 bytes): `413` when the file on disk is larger (read), or when the content to
  write is larger as UTF-8 plus the kept BOM (save).
- A save runs under a lock per file (a fixed array of semaphores picked by the hash of the resolved path): read the
  current bytes and compare the version, write a temporary file in the same directory, flush it to disk, compare the
  version again, give the temporary file the old file's Unix mode and rename it over the file (atomic). A save through a
  symlink writes the target and the link stays. The temporary file is named `.claushh-<id>.tmp`, without the file's
  name (a name close to the 255-byte limit would leave no room for a suffix), and it is created for its owner only when
  it replaces a file (the old file's mode is set on its open handle just before the rename), so the new content of a
  private file, such as a `.env` of mode `600`, is never readable by others while it is written. It is removed when a
  step fails or the version changed. Responses never contain resolved paths or exception texts, and file contents are
  never logged. Rejected: writing in place (a crash or a concurrent reader would see half a file), and checking the
  version only before the write (the whole write and flush would be the window for a change from outside). Accepted
  limits: the lock covers saves through this API only, so the console and the terminal write without it, and the
  second check catches their changes except in the time it takes to hash the file and rename it. Saving by rename means
  that a writable file in a directory the API cannot write cannot be saved (`500`), and that the saved file is a new
  inode: hard links elsewhere keep the old content, and owner, group, ACLs and extended attributes are those of a new
  file (the mode is kept).
- Saving a file that disappeared: a save with another `baseVersion` is `409 {"currentVersion":"absent"}`, and a save
  with `baseVersion` `absent` creates the file when the name does not exist at all (not even as a dangling symlink,
  which could lead anywhere) and its directory exists inside the projects directory (`404` when it is missing). When
  the file exists after all, `absent` is a `409` with its real version. So "Nadpisz moją wersją" (Overwrite with my
  version) re-creates a deleted file with the editor's content. Rejected: `404` for a deleted file (the editor could
  not save its text again) and creating through a dangling symlink (the new file would appear wherever the link
  points).
- `realpath`, `statx` and `access` are called through P/Invoke (`Files/Libc.cs`), so the backend runs only on Linux,
  like the deployment. The API and test assemblies are marked `[SupportedOSPlatform("linux")]` (`Program.cs`,
  `ApiFactory.cs`), so the platform analyzer accepts the Unix-only calls such as `File.SetUnixFileMode`. Rejected: the
  attribute on `FileStore` alone (every caller would get the warning).

Backend decisions (stage 4):
- Git access: LibGit2Sharp in-process for everything local (finding repositories, status, branch, upstream, ahead and
  behind, last commit, HEAD content); the `git` CLI only for the network (clone, fetch, pull, push). New repositories on
  the server use the `files` ref format and SHA-1, which libgit2 reads; a repository libgit2 cannot read is not listed
  and is logged. Rejected: the CLI for the status too (one process per repository on every save) and LibGit2Sharp for
  the network (libgit2 does not use git's credential helpers, and the `protocol.*` rules are git CLI settings).
- A workspace is a real directory (not a symlink) directly in `Projects:Root` whose name does not start with `.`, as
  `ProjectPaths` lists the root. A repository is a real directory directly in a workspace, not starting with `.`, whose
  `.git` is a real directory (checked with `lstat` before libgit2 opens it) and which libgit2 opens without searching
  parent directories. Rejected: accepting a `.git` file (worktrees, submodules): its `gitdir:` line can point anywhere,
  also outside the projects directory. The opened repository must also point back here (`Repository.Info.Path` is
  `<dir>/.git/` and `Info.WorkingDirectory` is `<dir>/`): a misconfigured `core.worktree` could otherwise read or
  write outside the projects directory; a `.git/commondir` is refused before libgit2 opens it, for the same reason.
- `workspace`, `repo` and `path` use the files API's path syntax and `.git` rule; `workspace` is exactly one segment,
  `repo` exactly two, and `path` must start with `repo` + `/`. Syntax errors and paths that resolve outside are `400`,
  a valid path that is not a workspace or repository is `404`, both with an empty body. Rejected: the mock's `404` for
  everything (the files API answers bad paths with `400`, and one rule is easier to check).
- Status: git's rules, untracked files one by one, ignored files skipped, renames detected in the index only, the
  contract's six statuses in a fixed order (first match wins). Rejected: detecting working-tree renames (the panel would
  show renames that the terminal's `git status` does not).
- `lastCommit` is HEAD's subject line and committer date. Rejected: the author date (after a rebase the list would show
  when the change was first written rather than when it landed).
- HEAD content is the tree entry at that path in HEAD (git's tree, so no symlink of the working tree is followed),
  through the checkout filters (line endings and `ident` from `.gitattributes`), then the files API's rules (5 MB,
  UTF-8, BOM dropped). Rejected: the raw blob (with `eol=crlf` every line would differ) and the mock's `404` for binary
  files (the diff view would say "new file").
- Repositories are listed by directory name, ordinal and ignoring case. Rejected: the file system's order (looks random
  on ext4) and the last commit (rows would move under the cursor after every pull).
- A workspace's display name lives in the table `Workspaces` (`Directory` primary key, `DisplayName`, `CreatedAt`); the
  file system decides which workspaces exist. A directory without a row is shown under its directory name; a row
  without a directory is ignored and kept; creating a workspace inserts the row or takes over a stale one. Rejected: a
  marker file in the workspace (the files API lists dotfiles, so it would show in the explorer and could be deleted by
  accident) and a name derived from the directory (loses Polish letters and case).
- Workspaces with a row by `CreatedAt` (the mock's order: Studia, Prywatne, then new ones), then the others by directory
  name, ordinal and ignoring case. Rejected: the file system's order.
- The name and directory rules are exactly the frontend's and the mock's: trimmed as JavaScript does, 1-40 code points
  of letters, digits (Unicode L and N), spaces, `_` and `-`; the directory lower case, `ł`→`l`, NFD without combining
  marks, every run outside `[a-z0-9_-]` → one `-`, trimmed of `-`. A name whose directory would be empty is `400`; any
  existing entry with that name (also a dangling symlink) is `409`. Rejected: transliterating more letters (`ß`→`ss`),
  which would accept names the mock refuses.
- Creating: under one process-wide lock, the name must be free, then `mkdir`, then the row; if the row cannot be
  written, the directory is removed again and the request fails (`500`). Rejected: the row first (a failed `mkdir`
  would leave a name for a directory that does not exist).
- The git CLI runs without a shell, stdin closed, with `-c protocol.allow=never -c protocol.https.allow=always -c
  core.fsmonitor=false`, no prompts (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`), English messages
  (`LC_ALL=C.UTF-8`) and an environment built from a clean slate (see the next bullet), so git's own repository
  variables are simply never set; hooks stay. Rejected: a shell command line (quoting mistakes) and disabling hooks
  (a pre-push hook of the owner's would silently not run from the panel).
- git's environment (`Processes/ChildEnvironment`, owner's decision 2026-10-02) is built from an allowlist (`HOME`,
  `USER`, `LOGNAME`, `SHELL`, `PATH`, `LANG`, `LANGUAGE`, every `LC_*`, `TZ`), not inherited and then trimmed by a
  denylist: a denylist only ever catches variables someone already thought of, and the API's own process picks up new
  ones over time (a secret from a systemd unit, a variable a future dependency reads) that a denylist would miss and
  leak into every git process. `GitRunner`'s own overrides (`XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`,
  `DBUS_SESSION_BUS_ADDRESS` passed through, then `Git:Environment:*`, then git's own variables) are layered on top of
  the allowlist, in that order. Rejected: the previous denylist (missed `GIT_ALLOW_PROTOCOL`,
  `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, `GIT_SSL_NO_VERIFY`, `GIT_TRACE*` and
  `ConnectionStrings__*`).
- Time limits: one deadline per clone, pull or push request, `Git:NetworkTimeout` (100 s) from its start, covering the
  lock wait and every git step, which keeps the answer under Cloudflare's 125 s; local steps also at most 30 s each. On
  a timeout the process tree is killed, a partial clone is removed, and the answer is `502` with
  "Git nie skończył w ciągu N s i został przerwany.". Rejected: `504` (the frontend shows "błąd serwera" without the
  reason) and a limit per git step (a pull waiting behind another operation could pass 125 s).
- The clone URL is checked with the frontend's rule in .NET terms (`[0-9]` and `\z` in the pattern, then the WHATWG
  canonical-form checks for ports, `.`/`..` segments and IPv4 hosts), and git gets exactly that string after `--`.
  Rejected: .NET's `Uri` (canonicalises differently from WHATWG) and validating punycode with `IdnMapping` (a different
  algorithm from the browser's; refusing `xn--` hosts costs nothing for GitHub).
- Clone: checks in the mock's order, then `git clone` under the lock of the target path; a failure removes the target.
  Rejected: cloning into a temporary name and renaming (a second place where a half-finished clone can stay).
- One `SemaphoreSlim` per repository path, shared by clone (target), pull, push and the background fetch; a request
  waits for it within its deadline. The background fetch skips a busy repository, and a request that finds a
  background fetch holding the lock cancels it (its process tree is killed; a pull fetches anyway). Rejected: striped
  locks as in the files API (a pull could wait behind an operation on an unrelated repository that shares its stripe)
  and refusing a second pull with `409` (the panel already disables its buttons while a request is pending).
- ↑/↓ come from the local remote-tracking branches. When `GET /api/repos` has built the list, every repository with an
  upstream whose last fetch attempt is at least 5 minutes old (by `TimeProvider`) is fetched in the background with the
  network limit; the response does not wait, a failure is logged and tried again after another 5 minutes, a busy
  repository is skipped, and running fetches are killed when the API stops. So ↑/↓ show the remote's state within about
  5 minutes of using the panel (owner's decision). Rejected: a timer for all repositories (network traffic while nobody
  uses the portal) and a fetch inside the request (every save would wait for GitHub).
- Pull is the contract's `git pull --ff-only` run as its two steps, so that the status follows the step that failed: no
  upstream `400`, the fetch `502`, nothing new "Już aktualne.", the fast-forward merge `409` (diverged branches, local
  changes that would be overwritten, a lock file), success "Pobrano N commit/commity/commitów." with `changedPaths` from
  `git diff --name-only --no-renames -z` (a rename gives both paths). Rejected: one `git pull` call (its exit code does
  not say whether the network or the merge failed).
- Push: a detached HEAD `400`; an upstream with nothing ahead "Nic do wypchnięcia." without the network (as the mock);
  with an upstream `git push --porcelain <remote> HEAD:<upstream branch>`; without one but with `origin` the contract's
  `git push --porcelain -u origin HEAD`; neither `400`. `[rejected]` in the porcelain output is `409`, any other failure
  (network, authentication, `[remote rejected]` by a hook or protection rule) `502`. Rejected: plain `git push` (with an
  upstream named differently from the branch, `push.default=simple` refuses) and telling the rejection apart from
  stderr text (the porcelain output is meant for programs).
- The backend's own texts are Polish and equal to the mock's where the mock has one; git's messages pass through in
  English; `404` and parameter `400`s have an empty body. Rejected: English backend texts (the panel would mix languages
  in its own messages).
- Hubs (SignalR, the console hub later too): WebSocket only, the JSON protocol, Polish `HubException` texts and no
  detailed errors. Rejected: long polling and SSE (more ways in, and the frontend never uses them).
- The `Origin` of every request under `/hubs` must equal one of `Hubs:AllowedOrigins` (ordinal), checked before
  authentication; a missing or other value is `403`. Production has an empty list until the deployment sets the public
  origin. No XSRF token on hubs: the upgrade is a GET outside `/api`. Rejected: `WebSocketOptions.AllowedOrigins` (a
  request without `Origin` passes it).
- A global hub filter checks the session on connect and on every call (one indexed query) and never extends it; an
  ended session aborts the connection, so the client sees the call cancelled. Rejected: remembering the check per
  connection (a revocation by `create-user` in another process would pass) and `CloseOnAuthenticationExpiration` (the
  session ticket has no expiry).
- Open connections are registered by session; a sweep aborts those of sessions that are no longer active, every 5 s and
  right after logout, ending a session and revoke-others. Events sent to clients are not checked; a connection of an
  ended session receives them until it is aborted (at once, or within 5 s for an end in another process). Rejected: a
  timer per connection (blind to another process) and `SessionService` calling the hubs (the session rules would depend
  on the hubs).
- Terminal engine: tmux in control mode (`tmux -C` over pipes), one tmux session and one control client per terminal,
  all on the API's own tmux server; tmux 3.7 or later (control clients size their sessions from 3.3,
  `bracket_paste_flag` from 3.7). Rejected: a PTY package attaching a normal tmux client (its output is tmux's
  re-render, so a snapshot and `seq` cannot be taken together; `Pty.Net` is a 2018 prerelease) and one control client
  for all terminals (one stuck terminal would stall the others).
- Terminals end with the API: at start the API ends what is left of its tmux server, on a graceful stop it ends it.
  Rejected for now: surviving restarts (a tmux server in its own unit, sessions adopted at start, `seq` restarting);
  restarts are rare, and it can come later without a contract change.
- The tmux server's socket and configuration live in `Terminal:SocketDirectory` (mode 0700, default
  `$XDG_RUNTIME_DIR/claushh`), with the API's own configuration. Rejected: tmux's default socket (shared with the
  owner's own tmux, which the start-time `kill-server` would end).
- Only an allowlist of the API's environment reaches tmux and the shell (HOME, USER, LOGNAME, SHELL, PATH, LANG,
  LANGUAGE, LC_*, TZ), plus `COLORTERM=truecolor` and `Terminal:Environment`. Rejected: removing a denylist (any new
  variable would leak). The shell runs as the API's user; a separate user for it is left to the deployment stage.
- The shell starts in the real path of `projectPath` (a directory checked by `ProjectPaths`); the shell itself is not
  confined, which is the sandbox's job. Ids are new GUIDs, titles unique with the smallest free " (k)", at most 20
  terminals. Rejected: the mock's `t<n>` ids and count-based titles (they repeat after a restart or a close).
- Output gets `seq` in the API, one per non-empty decoded piece of `%output`, and the reader waits for each send.
  Rejected: a queue per terminal (unbounded memory, or a second kind of back-pressure).
- `exitCode` is always `null`: the end of the control client's output marks the exit. Rejected: `remain-on-exit on`
  with a subscription for the code (it relies on notifications a tmux bug sent inside command replies).
- The snapshot is tmux's screen (`capture-pane` with colours, history and screen) plus cursor and modes from
  `display-message`, taken on one line of tmux commands, so screen and `seq` agree (tmux sends a reply only after the
  output read before it). Rejected: the mock's raw output tail (it can start inside an escape sequence and loses the
  modes a program set).
- `Input` goes to the pane as bytes (`send-keys -H`, 1024 per command). Rejected: `send-keys -l` (tmux quoting of `;`,
  quotes and control characters).
- `Resize` of an unknown id and `CloseTerminal` of an unknown id are silent. Rejected: errors there (`Resize` is a
  `send`, and a second tab would keep a dead tab with "Nie udało się zamknąć terminala.").
- The terminal view does not answer terminal queries; tmux answers the cursor position report, the mode report and
  the colour queries in the pane and passes every query on to every view, so an answer from xterm would reach the
  program once per open tab. The device attributes queries (DA1, DA2) get no answer at all: neither the view nor
  tmux answers them. Rejected: filtering replies out of `Input` on the server (a cursor report and Ctrl+F3 are the
  same bytes) and letting xterm answer them (garbage with two tabs).

### Limiting damage

- Everything runs as the `workspace` user without administrator privileges.
- systemd: `ProtectSystem=strict`, `ProtectHome=true` (except the `workspace` home),
  `ReadWritePaths=/srv/projects`, `NoNewPrivileges=true`.
- Every file API checks whether the path, resolved like `realpath(3)` (every symlink followed), lies inside the
  projects directory.
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

- Packages: `dotnet-sdk`, `aspnet-runtime`, `cloudflared`, `docker`, `git`, `tmux` (3.7 or later), the `claude` CLI.
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
- [x] **Stage 2: files and editor.**
  - [x] Frontend: explorer with lazy loading, Monaco with tabs, saving (Ctrl+S), detection of
        conflicts with changes on disk, status bar (cursor, language, unsaved).
  - [x] Backend: files API from the contract in `ARCHITECTURE.md`, path protection (including symlinks), file versions,
        size limits, binary file detection.
  - [x] Marking of changed files (`M`, `U`, …) in the explorer (frontend, based on the git status from stage 4).
- [ ] **Stage 3: console.**
  - [x] Frontend: Console panel (plain text), model / effort / mode, permission requests, interrupt (Esc),
        new conversation, replaying the conversation after a reload and in other tabs, refreshing files changed
        by the console, SignalR connection with session control.
  - [ ] Backend: hub `/hubs/console` from the contract in `ARCHITECTURE.md`, `claude` process with stream-json,
        permission requests through MCP (`--permission-prompt-tool`), storing conversations, resuming (`--resume`).
- [x] **Stage 4: git, terminal, workspaces.**
  - [x] Frontend: Workspace panel (workspaces, repository table, Otwórz (open) / Pull / Push, creating a
        workspace, cloning), open repo in the URL, path and branch in the top bar, branch and number of changes
        in the status bar, git markers in the explorer, a separate console conversation for each repo.
  - [x] Frontend: Terminal tab (xterm.js): multiple terminals, reattaching after a reload without losing
        or duplicating output, size fitting, `exit`, Ctrl+S for the program in the terminal.
  - [x] Backend: workspaces and git API from the contract in `ARCHITECTURE.md` (LibGit2Sharp locally, the `git` CLI
        for the network, display names in the database, a background fetch at most every 5 minutes).
  - [x] Backend: hub `/hubs/terminal` from the contract in `ARCHITECTURE.md` (terminal: tmux in control mode).
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
