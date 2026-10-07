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
| Title bar | the command centre (workspace / repository / branch; a click shows Source Control), the toggles of the side bar, the panel and the console, the account menu with the user name, "Security…" and "Log out" |
| Left | the activity bar with Explorer (OPEN EDITORS, the tree with file icons and git marks), Search (a query with case, whole word and regular expressions, the files to include and exclude, the results by file) and Source Control (workspaces and repositories with Open / Pull / Push, the open repository's changes) |
| Center | the editor (Monaco) with tabs, editor actions (the changes view), breadcrumbs and the minimap; the Terminal panel below |
| Right | **"Console"** as VS Code's secondary side bar: the conversation with Claude as monospace text without icons, images or the name "Claude" (step verbs, counts and notes in color); a composer card with the open file's chip, chips for **model**, **effort** and **mode** (ask before edits / accept edits / plan) and Send; permission requests (yes / yes, always / no) |
| Status bar | branch, number of changes, console status, unsaved files, cursor position, indentation, encoding, line endings, language, session countdown |

The mockup also shows a tunnel status in the status bar. It was dropped as it would add nothing: through the tunnel
the page does not load at all while the tunnel is down, and a tunnel that fails while the page is open already shows
in the status bar as "Console: disconnected" (console status).

Colors: a dark theme after VS Code's structure: two surfaces, one amber accent for focus, the primary action and the
active tab; blue for info notes, green for success and git additions, purple for badges; errors, warnings and the
modified mark in VS Code's colors.
Fonts: IBM Plex Sans (interface) and JetBrains Mono (code, console, terminal), self-hosted through Fontsource; in the
terminal the device's own JetBrainsMono Nerd Font comes first, and the frontend ships its Regular face (Nerd Fonts,
OFL) for the characters JetBrains Mono lacks, so the dotfiles prompt's icons show on every device, a phone included.
The terminal is set like a desktop terminal: 11 pt (13 px on a phone), a line height near 1, 10 px of padding, and
bold text keeps its color.
The terminal takes pywal's palette through the API and keeps it after a reload: the background, the foreground, the
cursor and the 16 colours of the `colors.json` that `Terminal:ThemeFile` names (`GET /api/terminal/theme`), with the
padding in the background colour, so it looks like the desktop terminal whatever the wallpaper; without the file it
keeps the portal's colours. Rejected: a fixed palette (it drifts from the wallpaper) and colours only from the shell
(pywal's sequences at shell start; a reload loses them, because the snapshot keeps only the text's colours).
Icons: codicons; file and folder icons from Material Icon Theme (MIT), a selection.

Devices: laptop and PC, and a phone with every function in three tabs (Editor, Terminal, Console).

Frontend decisions (UI refresh):
- Everything the owner reads is English, in one language without a switch: the interface, the backend's own texts,
  hub errors and the phone notifications. Dates are day first with a 24-hour clock (`en-GB`, `05/10/2026, 14:03`);
  file names still sort with Polish collation (ł after l), a choice apart from the interface's language. Stored
  console events keep the texts they were sent with. Rejected: a language switch (translation infrastructure for one
  reader) and ISO dates.
- The look follows VS Code's structure with the amber accent: two neutral surfaces (the editor darker), borders one
  step lighter, and one shared system for buttons, inputs, focus and tabs in `styles.scss`, with the components
  keeping only their layout. The accent marks focus, the primary action, the active tab and the cursor; errors,
  warnings and git marks use VS Code's dark defaults. Rejected: VS Code's blue accent and a light theme (it doubles
  the Monaco and xterm themes).
- Fonts are self-hosted through Fontsource (IBM Plex Sans 400/500/600; JetBrains Mono 400, 700 and italic 400): the
  browser fetches only the subsets a page needs. Monaco and xterm measure their cells when they are created, so they
  wait for JetBrains Mono (3 s at most) and measure again when a font arrives later. Rejected: system font stacks
  (each device falls back to its own) and a font CDN (the CSP allows only the portal's own files).
- Icons are codicons (CC BY 4.0, attributed in `README.md`) in the shell and the console's chrome; the console's log has none. Rejected:
  inline SVGs (markup per icon) and text glyphs.
- The Monaco and xterm themes read the tokens when they are created (`theme.ts`), so the palette lives in
  `styles.scss` only; a terminal with pywal's palette from the server takes that instead (above). Rejected: hex values repeated in TypeScript.
- Panels slide in and out instead of appearing: `transform` only, 200 ms in and 150 ms out, nothing with reduced
  motion. The console column and the bottom panel use Angular's `animate.enter`/`animate.leave`, without a package.
  Rejected: animating width or height (xterm would refit and resize tmux on every frame) and `@angular/animations`
  (deprecated, and a package).
- Phone layout: below 768 px, or with a coarse pointer and at most 500 px of height (a phone in landscape), the page
  has the tabs Editor · Terminal · Console instead of the columns. Every desktop function stays reachable: the
  side bar (Explorer, Search and Source Control) as a drawer, Security as a full-screen sheet, Log out in a menu, a Save button and
  a Send button. Rejected: bottom tabs (they fight the keyboard) and a third tab named after the product (the
  console's rule).
- The two layouts are two template branches, so crossing the breakpoint recreates the views: Monaco's undo history
  is lost, the text is kept and terminals attach again. Rejected: one DOM tree placed by CSS (every pane would have
  to work in both layouts).
- Inside the phone layout nothing is destroyed: inactive tabs are hidden with `visibility` and made `inert` (they cannot
  hold the focus), the terminal mounts on its first visit (opening it starts a tmux session), and the side bar's drawer
  stays mounted and slides with a CSS transition, so it keeps its expanded folders. The sheets are native `<dialog>`s
  opened with `showModal()` (Esc, a focus trap and an inert page come with it) that slide with `@starting-style`;
  browsers without `overlay` transitions close them without the slide. Rejected: `@if` with `animate.leave` for the
  drawer (each close would lose the tree) and for the sheets (Esc, the focus trap and the inert page by hand).
- Touch is separate from the phone layout: with a coarse pointer, Enter in the console makes a new line and a Send
  button sends, and the editor and the terminal never take the focus on their own (the soft keyboard would open).
  Rejected: tying this to the phone layout (a tablet in the desktop layout could not send without Shift+Enter).
- Monaco stays the editor on the phone, as best effort with a Save button; whether a phone editor is needed is
  decided after a check on the owner's phone.
- The phone's terminal has a row of keys a phone keyboard lacks (Esc, Tab, a sticky Ctrl, the arrows and Paste); they
  type through `term.input`, so the queue's no-loss and no-duplicate rule holds, and Paste goes through the same check
  as a paste. Rejected: a minimal row without Paste (a keyboard's clipboard chip may skip the paste check) and no row.
- iOS Safari does not resize the page for the soft keyboard (`interactive-widget` is not supported there), so in the
  phone layout the page keeps room at the bottom for the part of the screen `visualViewport` says the keyboard covers.
  Rejected: letting the keyboard cover the phone keys and the console's Send button.

Frontend decisions (VS Code layout):
- The workspace follows VS Code's layout practically one to one, colors aside: a title bar, the primary side bar with
  its activity bar on top, the editor with the bottom panel under it, the console as the secondary side bar and the
  status bar. Left out: the extensions of the owner's VS Code, a product logo or mascot, and buttons without a
  function here.
- Colors: blue (`#4fc1ff`) for info notes and the console's links, green (`#89d185`) for success, git additions and
  the console's "+N", purple (`#c586c0`) for badges and the console's step verbs; added, untracked and renamed files
  are green, deleted ones take the error color. The palette stays in `styles.scss`.
- The console's composer is a card: the prompt, then the mode chip and Send (Stop while the console works), then one
  chip for the model and the effort. A chip is a pill with a native `<select>` laid over it, so a tap opens the
  platform's own picker (the wheel on iOS) and the keyboard, focus and screen readers come from the select. The chrome
  has codicons; the log stays monospace text without icons or images. Rejected: a custom listbox (its own keyboard,
  focus and Esc handling, and no iOS picker) and one select for model × effort (12 options).
- With a coarse pointer every input, select and textarea outside Monaco and xterm has 16 px text, so iOS Safari never
  zooms into a focused field; the line heights are fixed in px, so the fields keep their heights. Rejected: a size per
  field (component rules outrank a global rule, so a new field would slip through).
- File and folder icons are a selection (about a hundred icons) of Material Icon Theme 5.39.0 (MIT), the theme of the
  owner's VS Code, kept as committed copies: `web/scripts/file-icons.mjs` copies the allowed SVGs and the license into
  `public/file-icons/` and writes the name map, so builds and tests never need the package (an exact-version
  devDependency). They are `<img>`s, so no SVG markup reaches the DOM. The logos of AI tools are left out. Rejected: an
  asset glob from `node_modules` (the allowlist in two places), the whole set (about 1 MB and a 215 KB map), and
  vscode-icons (share-alike art), Iconify (no file-name manifest) and Seti (a single-color font).
- The title bar holds the command centre (the open repository and branch; a click shows Source Control), the toggles
  of the side bar, the panel and the console, and an account menu (the user name, "Security…", "Log out"), the same
  menu as the phone's. Rejected: the Popover API (jsdom lacks it).
- Ctrl+Alt+B (Cmd+Option+B on macOS), VS Code's key for the secondary side bar, shows and hides the console wherever
  the focus is, the terminal included, unlike Ctrl+S, which belongs to the program in the terminal. Opening puts the
  focus in the prompt. Rejected: VS Code's Ctrl+B and Ctrl+J (the side bar and the panel): browsers use them
  (Firefox's bookmarks, Chrome's downloads), and a shell reads them as "back one character" and Enter.
- The primary side bar has an activity bar on top with Explorer, Search and Source Control, whose badges count the unsaved
  files and the changes. Every view stays mounted and the inactive ones are hidden; closing the side bar takes it out of
  the flow at once and slides it out, as the phone's drawer. Rejected: `@if` with `animate.leave` (each close would
  lose the tree) and `display: none` with `@starting-style` (the side bar would slide in at every page load).
- Source Control shows the Workspaces panel, always as cards, and the open repository's CHANGES; a click opens the
  file with its changes shown. The phone has no Workspace sheet any more: its repository button opens the drawer on
  Source Control (two copies of the panel would mean two of every row).
- The bottom panel holds only the terminal, inside the editor's column, and starts closed, so the terminal hub
  connects only when the terminal is first shown. The session countdown moves to the status bar on the desktop.
- The side bar, the bottom panel and the console resize by dragging their edge, as VS Code's sashes, and with the
  keyboard (the arrows, Home, End); a double-click brings back the size at start. Minimums keep the panels usable
  (the console's composer needs 320 px) and the editor at least 240 × 120 px; a window too narrow for the chosen
  widths takes the room from the console first. The sizes stay in memory with the rest of `WorkbenchState`. While an
  edge is dragged the terminals keep their size and fit once at the end (tmux resized on every frame is rejected
  above). Rejected: remembering the sizes in `localStorage` (only the unconfirmed logout marker goes there, and a
  logout clears it).
- The Explorer view starts with OPEN EDITORS, collapsed as in VS Code (a dot marks unsaved files, closing asks the
  tab's question). The editor actions hold only what the portal can do, the changes view; actions without a function
  here (run, split, timeline) are left out. The minimap is on in the desktop layout only (at a phone's width it would
  take a quarter of the editor).
- The status bar shows VS Code's items read-only, without their pickers: the indentation and the line endings from
  Monaco's model, the language by its display name, and "UTF-8" as a constant, since the files API serves only UTF-8.
- Search in files is VS Code's Search view in the side bar: a field with Match Case, Match Whole Word and Use Regular
  Expression, the files to include and exclude behind "…", and the results by file with a count and the matches
  highlighted (text in spans, never HTML); a click opens the file at the match. Typing searches after 300 ms; Enter,
  the toggles and another repository at once; a new search cancels the request of the one before. The view stays
  mounted with the others, so its results survive a switch of view; on the phone the Editor tab's Search button opens
  the drawer on it.
- The composer names the open file, as VS Code's chip does: the editor's active file when it lies in the open
  repository, with the lines of a selection; × leaves it out until another file becomes active. The CLI gets a note
  with the path only, which the model could read in its working directory anyway. When the server refuses the file
  (the console moved or deleted it), the console leaves it out and keeps the prompt, so the next Send goes without it.
  Rejected: `@path` in the text (its expansion is unverified, it is off for prompts starting with `/`, and paths with
  spaces need quoting) and the file's contents (up to 5 MB of tokens, more than VS Code sends).

## Tech stack

| Layer | Solution |
|---|---|
| System | EndeavourOS with the owner's dotfiles, user `workspace`, systemd service with sandboxing |
| Backend | ASP.NET Core (.NET 10), SignalR, ASP.NET Core Identity (TOTP, passkeys) |
| Database | PostgreSQL 17 in Docker (pinned version, only `127.0.0.1`), EF Core + Npgsql |
| Frontend | Angular, Monaco (`monaco-editor`), xterm.js, `@microsoft/signalr` |
| Console | one long-lived `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio` process per conversation, with the hardening flags of "Backend decisions (stage 3)" |
| Terminal | tmux in control mode (`tmux -C`), no PTY package; terminals end with the API |
| Git | LibGit2Sharp for everything local (status, branches, HEAD content), the git CLI for clone, fetch, pull and push |
| Access from outside | Cloudflare Access (one-time PIN by e-mail) and Cloudflare Tunnel |

### Claude Code integration

- The backend runs `claude` in headless mode with a JSON stream. Every event (file read,
  edit, command, response) goes through SignalR to the Console panel.
- Model, effort and permission mode are launch parameters, re-applied before every prompt by control requests.
- Permission requests: `--permission-prompt-tool stdio`; the CLI asks with control requests on stdout and the backend
  answers on stdin with the browser's decision ("Backend decisions (stage 3)").
- Claude Code keeps the model's memory for `--resume`; the portal keeps its own log of the console events for replay
  (kept 90 days).
- We stay with the official CLI instead of the Agent SDK. Before any change, Anthropic's current
  authentication terms must be checked.

### Data in the database

Account, 2FA secret and passkeys, active sessions and login history (date, IP, device), the display names of workspaces,
console conversations with their events, and the console's "always" rules (model, effort and mode live in the browser).

## Security

### Access from the internet

- No open ports on the router. `cloudflared` connects outward, the home IP is not visible,
  HTTPS and DDoS protection are on Cloudflare's side.
- First layer: Cloudflare Access (a one-time PIN sent to the owner's e-mail before the page is shown at all).
- Firewall: firewalld, with no inbound port for the tunnel; SSH only from the home network.

### Login and sessions

- Password (hash from ASP.NET Core Identity) + **mandatory TOTP**, or a passkey (username-less, user verification
  required) as a second way in; password + TOTP keeps working.
- No registration endpoint. The account is created by an installation command (e.g. `dotnet run -- create-user`).
- Login attempt limit per IP and an account lockout after several wrong codes (own code, see "Backend decisions (stage 1)").
- Phone notification through ntfy of every successful login, every start of an account lock, and every passkey added or removed.
- Cookies `HttpOnly`, `Secure`, `SameSite=Strict`, antiforgery.
- Short sessions (e.g. 30 minutes of inactivity, hard limit of 12 h), extended only by user activity,
  list of active sessions, login history, "Log out everywhere".
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
  Identity is used only for the user, the password hash, the TOTP key and the passkeys (the codes are checked by own
  code, below; passkeys: "Backend decisions (passkeys)").
  Rejected: the Identity cookie with `ITicketStore` (one expiry per ticket, so two deadlines, a session list and
  revoking need workarounds around a serialized blob) and the plain Identity cookie with the security stamp (it cannot
  end a single session).
- The XSRF token is bound to the session, not only to the user (`IAntiforgeryAdditionalDataProvider`), and one filter on
  `/api` validates it for POST/PUT/PATCH/DELETE: the built-in antiforgery middleware skips DELETE and does not stop the request.
- Closed by default: `FallbackPolicy` requires a session; anonymous are only `/api/health`, `GET /api/auth/me`,
  `POST /api/auth/login`, `POST /api/auth/passkeys/login-options`, `POST /api/auth/passkeys/login` and the built
  frontend (static files and the `index.html` fallback, the same files for everyone, no data).
- Development runs over plain http, where ASP.NET antiforgery refuses `Secure`-only cookies, so there the cookies have
  no `__Host-` prefix (`Sessions:SecureCookies=false`). Behind Cloudflare Tunnel requests also reach the API as HTTP;
  `ForwardedHeaders` takes `X-Forwarded-Proto: https` from the local `cloudflared`, so production keeps `Secure` and the
  `__Host-` prefix.
- The account is created only by `create-user` on the server; TOTP is switched on only after a correct code from the app,
  in one transaction. A lost phone: `create-user --reset-totp` (a new key, all sessions ended, the lockout cleared),
  which needs shell access to the server anyway. A leaked password: `create-user --reset-password` (a new password,
  all sessions ended, the lockout cleared), which asks only for the new password, because shell access proves more
  than the old one. There are no recovery codes, because the login contract has only `totpCode`.
- TOTP codes are checked by own code (RFC 6238, the step of now ±1) that stores the last accepted step and rejects that
  step and earlier ones, so a code works once. Rejected: Identity's validator (±2 steps, the real clock, no reuse check)
  with a remembered last code (another, older code from the same window would still pass).
- Login protection has two layers in own code (`LoginGuard`, time from `TimeProvider`): a limit of failed attempts per
  IP protects the password, the account lockout protects the code. Rejected: the `RateLimiter` middleware and
  Identity's lockout (both use the real clock, so their windows cannot be tested without waiting; the middleware also
  counts successful requests and forgets everything on restart). Password and passkey logins, re-authentications and
  adding a passkey run one at a time in the API process, so parallel attempts cannot slip between a check and its write.
- The login history records every attempt that reaches the check, also for unknown names (guessing stays visible), but
  never the typed name (it sometimes holds a mistyped password) and not attempts refused with 429 (a flood would drown
  the list).
- Every attempt records its method, `password` or `passkey`; rows from before the column read as `password`. A failed
  re-authentication is recorded as a `password` attempt and counts towards the per-IP limit; a successful one is not
  recorded (it creates no session).
- The limits are constants in code (10 failures per IP in 15 minutes, 5 wrong codes, lockouts from 15 minutes to
  24 hours, 90 days). Rejected: configuration (nothing to tune for one user, and a setting could weaken the protection
  by accident).
- The User-Agent is stored as sent (cut to at most 256 characters) and turned into "Chrome · Linux" on read
  (`DeviceName`, the mock's rules). Rejected: formatting on write (a fix of the rules would need a data migration).
- The account lockout counts only wrong or reused codes after a correct password (5 → 15 minutes the first time), so a
  stranger without the password cannot lock the only account. While it is locked every password login and
  re-authentication gets 429 whatever the credentials (a 429 only after a correct password would confirm the password,
  and a 401 would not tell the owner why login fails). The way out is `create-user --reset-totp` or `--reset-password`
  on the server, which also clear the lockout. Rejected: a separate unlock command (one more command for the same
  situation; shell access proves more than a code).
- The account lockout protects the TOTP code; a passkey login checks no code, so failed assertions count only towards
  the per-IP limit. A passkey login neither counts towards nor resets the lockout.
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
- A path that starts with `//` is `404` with an empty body, before routing, the files of the build and
  authentication. Rejected: collapsing the slashes (the app, the API and the hubs never use such paths).
- The server's Kestrel URL and `AllowedHosts` are in "Deployment decisions".
- `ForwardedHeaders` runs first in every environment and reads `CF-Connecting-IP` (as the client address) and
  `X-Forwarded-Proto` only from a loopback peer, one entry each; a loopback request without `CF-Connecting-IP` keeps the
  peer's address. Rejected: `X-Forwarded-For` (its left part comes from the client),
  `ASPNETCORE_FORWARDEDHEADERS_ENABLED` (it trusts every proxy) and refusing loopback requests without the header (the
  tunnel acceptance check in "Deployment" catches that case).
- The per-IP limit counts by the IPv4 address (IPv4-mapped addresses as IPv4) or the IPv6 /64, kept in
  `LoginAttempts.LimitKey`; the history keeps the full address. Old rows are not backfilled (the window is 15 minutes).
  Rejected: a bucket per IPv6 address (a connection usually has a whole /64, so changing the address costs nothing), the
  prefix in `Ip` (the address would be lost) and an `inet` column (more code for the same query).
- A login waits at most 10 s for the one before it; then it gets `429` with `Retry-After: 10`, and nothing is recorded
  (like every `429`). Rejected: `503` (the frontend shows it as "Server error", and the contract and the mock would
  change).
- The login screen shows the wait from `Retry-After` as "N s" below a minute, "N min" below an hour and "N h"
  otherwise, rounded up. Rejected: full words with plural forms (more code for the same information).
- Phone notifications through ntfy of every successful login, every start of an account lock, and every passkey
  added or removed: one `POST` of the text to the topic URL (a secret, in the server's environment file), with an
  optional access token. The login only queues the message; a background service sends it once, outside the login
  gate, and a failure is only logged (as `AuthCleanup` does). Required in Production (the API does not start without
  `Notifications:NtfyUrl`), optional elsewhere, so the local test in Development needs none. Rejected: Telegram (the
  bot token is part of the URL path), sending inside the login (ntfy's response time would hold the login gate),
  retries (more code for a rare event) and a notification for every failed attempt (failed attempts are already in the
  login history).

Backend decisions (passkeys):
- A passkey is a second way in next to password + TOTP. Identity stores the passkeys (schema version 3, table
  `AspNetUserPasskeys`), and its `PasskeyHandler` makes the WebAuthn options and checks the credentials; the API
  registers the handler itself and calls it directly. Rejected: `SignInManager` (it keeps the ceremonies in Identity's
  cookie schemes, which the portal does not use) and schema version 1 with the passkey entity mapped by hand
  (unsupported).
- The RP ID is `Passkeys:ServerDomain`, a lower-case host name checked at start in every environment, so it never
  comes from a request's `Host`. A credential's origin must be one of `Hubs:AllowedOrigins`, which now means the exact
  origins the portal is served from; a cross-origin or embedded ceremony is refused. User verification and
  discoverable credentials are required, and no attestation is asked for. Rejected: renaming `Hubs:AllowedOrigins`
  (configuration, deployment, tests and docs would change) and a second list `Passkeys:Origins` (two lists that must
  stay equal).
- The ceremonies' states stay on the server, in the API process (`PasskeyCeremonies`): a registration's state per
  session and the sessions that re-authenticated, each for 5 minutes by `TimeProvider`, a state used once. A restart
  loses only ceremonies in progress. Rejected: a data-protected cookie with the state (it cannot be made single-use).
- Adding or removing a passkey needs the password and a code again (`POST /api/auth/reauthenticate`), checked inside
  the login gate with the login's limits; a wrong or reused code counts towards the lockout as at login, and a
  failure is recorded as a failed login. The session then stays fresh for 5 minutes, whatever it does meanwhile, and
  is not extended. A failure is `403`, not `401`, because the frontend ends the session on a `401`. Rejected: a fresh
  mark used up by one action (a TOTP code works once, so a second action within the same 30 s would fail).
- Adding a passkey runs inside the login gate, so the limit's count and the insert cannot interleave, and the state's
  user must be the session's user. `createdAt` is the `TimeProvider` time (Identity's handler takes the real clock).
- The limits are constants: 10 passkeys, names of 1-64 characters without control or format characters (names go
  into the phone notifications); a missing name becomes the device, e.g. "Chrome · Linux".
- `create-user --reset-totp` and `--reset-password` remove every passkey in their transaction: no way in that was
  added before a reset survives it.
- Adding and removing a passkey send a `high` notification that names it. Passkey texts are English.
- Login with a passkey is username-less and starts from a button (no autofill). `POST /api/auth/passkeys/login-options`
  is anonymous, runs outside the login gate (it writes no rows) and only behind the per-IP limit; it keeps the login's
  state under a random id in the challenge cookie (`HttpOnly`, `SameSite=Strict`, 5 minutes, used once). At most 3
  pending login challenges per address (the per-IP limit's key) and 10,000 in all; beyond that the oldest goes.
- `POST /api/auth/passkeys/login` runs through the login gate and the per-IP limit like a password login, and every
  attempt past them is recorded with the method `passkey` and uses up the challenge. The account lockout protects the
  TOTP code; a passkey login checks no code, so failed assertions count only towards the per-IP limit. A passkey login
  neither counts towards nor resets the lockout.
- After a passkey login the passkey's sign count and backup state are saved (Identity's handler leaves that to the
  app). The login creates the same session as a password login, and its notification names the passkey.

Frontend decisions (passkeys):
- The browser's passkey API is wrapped in `core/browser/webauthn.ts`. The API's options go through
  `PublicKeyCredential.parseCreationOptionsFromJSON` and `parseRequestOptionsFromJSON` (Chrome 129, Firefox 119,
  Safari and iOS 18.4), and the credential goes back as JSON built by hand, because some password managers break
  `PublicKeyCredential.toJSON()`. A browser without those functions is not offered passkeys. Integration specs replace
  the wrapper; the e2e tests use Chromium's virtual authenticator at `http://localhost:4400`. Rejected: decoding the
  options by hand (code for browsers older than the owner's) and a WebAuthn package.
- The Security window lists the passkeys (name, date added, synced or this device only) and adds, renames and removes
  them. When adding or removing gets `403`, the window asks for the password and a code inline and then repeats the
  change once (nothing goes out until a password and a 6-digit code are filled in, and closing the window drops them); a
  name is checked by the backend's rule before anything is sent, and a blank name lets the backend name the passkey
  after the device. Rejected: asking for the password and code before every change (the backend allows changes for 5
  minutes after one check).
- The login screen's "Log in with a passkey" button asks for the login options, lets the browser's prompt run outside
  the `claushh-auth` lock (it may stay open for minutes, and the other tabs must not wait for it) and sends the
  passkey under the lock, like a password login. A cancelled prompt sends no login. Rejected: autofill (conditional
  mediation), which would keep a pending prompt next to the password form.

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
  because the status code must not tell whether something exists there. A symlink anywhere in the path that cannot be
  resolved (dangling, looping, or pointing where the API cannot search) is `400`, and so is a name longer than the file
  system allows. Any other path that does not exist, or that lies under a directory (not a symlink) that cannot be
  searched, is `404`. Other file system errors are a `500`, for example: an unexpected error of `realpath`, a directory
  that disappears while it is listed, or a projects directory that cannot be resolved when it is first needed. An entry
  whose type cannot be read is left out of a listing (`404` when asked for directly), and a directory that cannot be
  read lists as empty. Rejected: lexical checks (`Path.GetFullPath`), which do not see symlinks, and a managed walk
  over `LinkTarget`, which would re-implement the kernel's path resolution with its corner cases.
- Listings include dotfiles (`.gitignore`, `.env`): .NET's directory enumeration skips hidden entries by default (on
  Linux, names starting with `.`), so the listing asks for all of them. They leave out `.git`, names that are not valid
  paths (a `\` in the name) or not valid UTF-8 (.NET decodes those with U+FFFD, so the name resolves to nothing),
  symlinks that lead outside or cannot be resolved, and special files. A symlink that stays inside is listed with its
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
  the file exists after all, `absent` is a `409` with its real version. So "Overwrite with my version" re-creates a
  deleted file with the editor's content. Rejected: `404` for a deleted file (the editor could not save its text
  again) and creating through a dangling symlink (the new file would appear wherever the link points).
- `realpath`, `statx` and `access` are called through P/Invoke (`Files/Libc.cs`), so the backend runs only on Linux,
  like the deployment. The API and test assemblies are marked `[SupportedOSPlatform("linux")]` (`Program.cs`,
  `ApiFactory.cs`), so the platform analyzer accepts the Unix-only calls such as `File.SetUnixFileMode`. Rejected: the
  attribute on `FileStore` alone (every caller would get the warning).
- Search in files is in-process (`POST /api/search`): `ProjectPaths` for the root and the walk, a directory link never
  entered, `node_modules` and what a repository's `.gitignore` ignores skipped (LibGit2Sharp, tracked files too, as
  ripgrep does), text read as the files API reads it, and each line matched by .NET's `NonBacktracking` engine, which
  runs in time linear in the input. Limits are constants: 2,000 matches, files up to 1 MiB, 10 s per request, checked
  between lines and, inside a long line, as the pattern's match timeout. A POST keeps the searched text out of URLs and
  so out of access logs, and the API never logs it: a pattern .NET refuses is a `400`, and its exception, whose message
  quotes the pattern, is dropped. Rejected: `git grep`
  through `GitRunner` (it keeps only the last 64 KB of output, its columns count bytes, the projects directory and
  workspaces are not repositories, and its regular expressions are POSIX or PCRE), ripgrep (a new system package for
  the server) and GET (the query in URLs).

Backend decisions (stage 3):
- The console's code lives in `Claude/` (`Claushh.Api.Claude`) and `Hubs/ConsoleHub.cs`. Rejected: `Console/`, whose
  namespace would hide `System.Console` in the API's own code.
- Replay comes from the portal's own event log in PostgreSQL: every event as it was sent, in order, per conversation,
  text deltas merged per `messageId`. Rejected: reading the CLI's transcripts (an internal format that changes between
  releases, deleted after 30 days by default, without the server's question ids).
- The CLI's state and login live in `Console:ConfigDirectory` (`CLAUDE_CONFIG_DIR`, by default
  `~/.local/state/claushh/claude`, mode 0700), so the owner's own `~/.claude` (settings, CLAUDE.md, plugins, plans) is
  not used by the console. Rejected: the API user's `~/.claude`.
- The CLI's version is checked before the first claude process, not at start (`claude --version`, at least
  2.1.285, logged): the API's start never waits on the CLI, and a failed check is repeated by the next prompt, so a
  CLI installed while the API runs needs no restart. Without a usable CLI the console answers "Console unavailable"
  and replay still works. Console processes get `DISABLE_UPDATES=1` and `DISABLE_AUTOUPDATER=1`, so the CLI never
  updates itself under the API; the server's CLI is the launcher of Anthropic's installer, updated on purpose
  ("Deployment decisions"). Rejected: a pin without a check (an update in development would break silently).
- One long-lived `claude -p` process per conversation, stream-json both ways; questions, interrupts and option changes
  are control requests on the same pipes. The conversation's id is the CLI's session id, and a new process resumes it
  with `--resume` and every flag again. Rejected: a process per prompt (every prompt would reload the session).
- Hardening against cloned repositories: `--restricted` (no user, project or local settings files; file tools confined
  to the working directory; writes to settings, `.git` and tool configuration only with a question), an explicit
  `--tools` list (AskUserQuestion, EnterPlanMode, worktrees, scheduling, notifications and Skill off), no MCP servers
  (`--strict-mcp-config`), `--disable-slash-commands`, and `--settings` without hooks and with
  `blockReadsOutsideWorkingDirectories`. Rejected: `--safe-mode` (it also drops CLAUDE.md) and `--bare` (it never reads
  the subscription login).
- The process gets an allowlisted environment (as git and the terminal) and its own config directory; the API's
  `ANTHROPIC_API_KEY` never reaches it (it would silently replace the login). Authentication is the login in
  `Console:ConfigDirectory`, or `Console:ApiKeyFile` through `apiKeyHelper`: a file that lies outside the projects
  directory as written and with symlinks resolved, and whose mode has no group or other bit; the start check refuses
  any other, and the console is then unavailable.
- Model, effort and mode are launch flags and are sent again before every prompt, each reply awaited. Rejected:
  remembering and diffing them (an approved plan changes the mode inside the CLI).
- A prompt that starts with `/` is marked `client_composed`, so the CLI gives it to the model as text; otherwise a
  typed `/effort` is answered by the CLI itself (also with `--disable-slash-commands`) and the panel's options would no
  longer show the truth.
- Limits are constants: 8 live processes, 15 minutes idle, prompts up to 100,000 characters; the console hub alone
  accepts messages up to 1 MiB. A conversation with no process is dropped from memory after 15 idle minutes and read
  again from the database at its next use.
- A turn always ends: an interrupt has 10 s before the process tree is killed, a process that ends ends its turn (as
  interrupted during an interrupt), a stop interrupts and gives 5 s, and at start the turns a crash left open end with
  an error. Exit codes are only logged. The CLI's `--help` lists no `default` permission mode although the CLI accepts
  it, one more reason for the version check.
- Questions go over stdio: `can_use_tool` control requests on stdout, the answer on stdin, as the Agent SDK does. The
  value `stdio` is not in `--help`, and `--permission-prompts host` alone sends no question at all. Rejected: an MCP
  server in C# (its tool gets no rule suggestions, it needs a server per process, and the C# SDK's compatibility is
  unknown).
- A question shows exactly what it is for (the whole command, the path, the URL, the plan), never the model's text.
  `alwaysRule` only for exactly one suggested rule, and the answer is built from the server's own copy of the
  question, so allow-always saves exactly that rule. Rejected: joining several rules into one (the contract saves one).
- "Always" rules live in PostgreSQL per project (`ConsoleRules`) and go to every launch in `--settings`
  `permissions.allow`; the answer adds the rule for the session only. A rule is removed with SQL (README.md).
  Rejected: the CLI's `.claude/settings.local.json` in the repository (it needs the project's settings files, and a
  cloned repository could commit one).
- Plan mode stays: ExitPlanMode is a question with the plan as its text, and allowing it switches the mode back to
  asking before edits; plan files go to the console's config directory. AskUserQuestion and EnterPlanMode are off (the
  model asks in plain text).
- The answer is sent as `permission-resolved` before it is written to the CLI, so the allowed tool's step never
  overtakes its question.
- Edit and write steps go out when their tool has run, with exact counts from the CLI's own diff, and a denied tool never
  shows as done. Rejected: steps at `tool_use` with counts guessed from the input.
- `files-changed` comes from successful edits, and for commands from the repository's git status at the end of the turn
  compared with the prompt's, only when the project was a repository at the prompt; that status is read outside the
  conversation's lock. Rejected: every status path at each turn (false "The file changed" notes) and classifying
  commands by their first word.
- A step's output keeps its last 32,000 characters. Conversations are deleted 90 days after their last event, like login
  attempts; the rules stay.
- A prompt's open file (`SendPrompt.file`) becomes a second text block of the user line: "The user opened the file
  src/main.c in the editor. This may or may not be related to the current task.", or with a selection "The user
  selected lines 5 to 10 of src/main.c …". The path is relative to the conversation's directory as the user named it,
  never resolved, and the file's content never goes with it. The file must be a regular file whose real path lies in
  the conversation's directory, and its path has no control characters or line separators, so the sentence cannot be
  broken out of; otherwise "Invalid file". Rejected: text appended to the prompt by the frontend (it changes the stored
  prompt, and no server checks it).

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
- The git CLI runs without a shell, stdin closed, with `-c core.fsmonitor=false` and `GIT_ALLOW_PROTOCOL=https`, no
  prompts (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`), English messages (`LC_ALL=C.UTF-8`) and an environment
  built from a clean slate (see the next bullet), so git's own repository variables are simply never set; hooks stay.
  `GIT_ALLOW_PROTOCOL` makes git allow only the listed transports and read no protocol rule from its configuration
  files; `Git:Environment:GIT_ALLOW_PROTOCOL` replaces the list (the tests add `file` for their local remotes).
  Rejected: a shell command line (quoting mistakes), disabling hooks (a pre-push hook of the owner's would silently
  not run from the panel) and `-c protocol.allow=never -c protocol.https.allow=always` (a `protocol.<name>.allow` in
  any configuration file wins over it).
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
  a timeout git's process tree gets SIGTERM, so git removes its lock files, and if git still runs 1 s later, the whole
  tree is killed; a partial clone is removed, and the answer is `502` with "Git did not finish within N s and was
  stopped.". Rejected: `504` (the frontend shows "Server error" without the reason), a limit per git step (a pull
  waiting behind another operation could pass 125 s) and killing at once (git's `*.lock` files would stay and block
  the next git command in that repository).
- The clone URL is checked with the frontend's rule in .NET terms (`[0-9]` and `\z` in the pattern, then the WHATWG
  canonical-form checks for ports, `.`/`..` segments and IPv4 hosts), and git gets exactly that string after `--`.
  Rejected: .NET's `Uri` (canonicalises differently from WHATWG) and validating punycode with `IdnMapping` (a different
  algorithm from the browser's; refusing `xn--` hosts costs nothing for GitHub).
- Clone: checks in the mock's order, then `git clone` under the lock of the target path; a failure removes the target.
  Rejected: cloning into a temporary name and renaming (a second place where a half-finished clone can stay).
- One `SemaphoreSlim` per repository path, shared by clone (target), pull, push and the background fetch; a request
  waits for it within its deadline. The background fetch skips a busy repository, and a request that finds a
  background fetch holding the lock cancels it (its process tree is stopped; a pull fetches anyway). Rejected: striped
  locks as in the files API (a pull could wait behind an operation on an unrelated repository that shares its stripe)
  and refusing a second pull with `409` (the panel already disables its buttons while a request is pending).
- ↑/↓ come from the local remote-tracking branches. When `GET /api/repos` has built the list, every repository with an
  upstream whose last fetch attempt is at least 5 minutes old (by `TimeProvider`) is fetched in the background with the
  network limit; the response does not wait, a failure is logged and tried again after another 5 minutes, a busy
  repository is skipped, and running fetches are stopped when the API stops. So ↑/↓ show the remote's state within about
  5 minutes of using the panel (owner's decision). Rejected: a timer for all repositories (network traffic while nobody
  uses the portal) and a fetch inside the request (every save would wait for GitHub).
- Pull is the contract's `git pull --ff-only` run as its two steps, so that the status follows the step that failed: no
  upstream `400`, the fetch `502`, nothing new "Already up to date.", the fast-forward merge `409` (diverged branches,
  local changes that would be overwritten, a lock file), success "Pulled N commits." ("Pulled 1 commit.") with
  `changedPaths` from `git diff --name-only --no-renames -z` (a rename gives both paths). Rejected: one `git pull` call
  (its exit code does not say whether the network or the merge failed).
- Push: a detached HEAD `400`; an upstream with nothing ahead "Nothing to push." without the network (as the mock);
  with an upstream `git push --porcelain <remote> HEAD:<upstream branch>`; without one but with `origin` the contract's
  `git push --porcelain -u origin HEAD`; neither `400`. `[rejected]` in the porcelain output is `409`, any other failure
  (network, authentication, `[remote rejected]` by a hook or protection rule) `502`. Rejected: plain `git push` (with an
  upstream named differently from the branch, `push.default=simple` refuses) and telling the rejection apart from
  stderr text (the porcelain output is meant for programs).
- The backend's own texts are English and equal to the mock's where the mock has one; git's messages pass through in
  English; `404` and parameter `400`s have an empty body. Rejected: Polish backend texts (the owner reads one
  language; reversed 2026-10-05).
- Hubs (SignalR, the console hub later too): WebSocket only, the JSON protocol, English `HubException` texts and no
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
  variable would leak). The shell runs as the API's user (on the server `workspace`: "Limiting damage").
- The shell starts in the real path of `projectPath` (a directory checked by `ProjectPaths`); the shell itself is not
  confined, which is the sandbox's job. Ids are new GUIDs, titles unique with the smallest free " (k)", at most 20
  terminals. Rejected: the mock's `t<n>` ids and count-based titles (they repeat after a restart or a close).
- Output gets `seq` in the API, one per non-empty decoded piece of `%output`, and the reader waits for each send.
  Rejected: a queue per terminal (unbounded memory, or a second kind of back-pressure).
- `exitCode` is always `null`: the end of the control client's output marks the exit. Rejected: `remain-on-exit on`
  with a subscription for the code (it relies on notifications a tmux bug sent inside command replies).
- The snapshot is tmux's screen (`capture-pane` with colours, history and screen) plus cursor and modes from
  `display-message`, taken on one line of tmux commands, so screen and `seq` agree (tmux sends a reply only after the
  output read before it). When the output at the snapshot's `seq` ends inside an escape sequence, its beginning goes
  at the end of the snapshot, so the live output completes it. Rejected: the mock's raw output tail (it can start
  inside an escape sequence and loses the modes a program set).
- `Input` goes to the pane as bytes (`send-keys -H`, 1024 per command). Rejected: `send-keys -l` (tmux quoting of `;`,
  quotes and control characters).
- `Resize` of an unknown id and `CloseTerminal` of an unknown id are silent. Rejected: errors there (`Resize` is a
  `send`, and a second tab would keep a dead tab with "Could not close the terminal.").
- The terminal view does not answer terminal queries; tmux answers the cursor position report, the mode report and
  the colour queries in the pane and passes every query on to every view, so an answer from xterm would reach the
  program once per open tab. The device attributes queries (DA1, DA2) get no answer at all: neither the view nor
  tmux answers them. Rejected: filtering replies out of `Input` on the server (a cursor report and Ctrl+F3 are the
  same bytes) and letting xterm answer them (garbage with two tabs).

### Limiting damage

- Everything runs as the `workspace` user without administrator privileges: the API, the terminal and the console;
  `workspace` is in neither `wheel` nor `docker`.
- systemd (`deploy/claushh.service`): `ProtectSystem=strict`, `ProtectHome=tmpfs` with only the `workspace` home
  bound, `ReadWritePaths=/srv/projects`, `PrivateTmp`, `NoNewPrivileges` and the further options in "Deployment
  decisions". The terminal and the console are the API's children and run inside the same sandbox.
- Containers in the terminal come from the rootless Podman of `workspace`, never from the `docker` group.
- The installed API and frontend (`/opt/claushh`) belong to root.
- Every file API checks whether the path, resolved like `realpath(3)` (every symlink followed), lies inside the
  projects directory.
- GitHub token with access only to selected repositories.
- Secrets in `/etc/claushh/claushh.env` (root, `600`), which systemd reads before the service starts, and the tunnel
  token as a systemd credential (`LoadCredential=`); never in the repo.
- The .NET diagnostic port is off on the server (`DOTNET_EnableDiagnostics=0`), and the service writes no core dumps
  (`LimitCORE=0`).
- In Production the API makes its process non-dumpable as soon as it has started: other processes of `workspace` can
  neither read its `/proc` files (its environment holds the secrets) nor attach to it.
- By default the console asks for permission before edits and commands such as `git push`. The request shows the command with all
  hidden characters, and a permanent permission ("yes, always") requires a known rule and confirmation.
- Terminal: pasted text without control characters, multiple lines only after confirmation, typed characters are not lost
  or duplicated when the connection drops.

### Using untrusted computers

Whenever you log in on someone else's computer (e.g. in a computer lab), always log out
and do not save the password in the browser. The password alone without the TOTP code gives nothing. Never add a
passkey on someone else's computer.

## Deployment on EndeavourOS

- The server is the home computer, a desktop. Files: `deploy/` (`ARCHITECTURE.md`, "Flow" and "Repository map");
  decisions: "Deployment decisions" below.
- Packages: `docker` with compose, `podman` (rootless containers for the terminal), `cloudflared`, `git`, `tmux` (3.7
  or later); the .NET 10 SDK and Node.js only to build. The console's `claude` CLI (2.1.285 or later) is installed for
  `workspace` with Anthropic's installer; `Console:ClaudePath` points at its launcher ("Deployment decisions").
- A `workspace` user with its own home directory, cloned dotfiles, a configured `git` and, for the console, a
  `claude` logged in once, with the owner's subscription, in the console's own configuration directory
  (`Console:ConfigDirectory`). Projects in `/srv/projects`.
- API as a systemd service (`claushh.service`, a self-contained build, so that system updates do not break it) on
  `127.0.0.1:5090`.
- PostgreSQL from `deploy/docker-compose.yml`, project `claushh-prod`, on `127.0.0.1:5435`.
- `cloudflared` as a systemd service (`cloudflared.service`).
- No sleep: the sleep targets are masked; automatic power-on after a power outage in the BIOS.
- Updates (`pacman -Syu`) manually, after each one check that the portal works. A .NET security patch needs a new build
  of the API, installed like any update.
- Backup: a daily `pg_dump` in the custom format from a systemd timer, kept 14 days, with a restore command. The git
  remotes are the copy of `/srv/projects`.
- Before the portal goes behind the tunnel (commands and checks: `README.md`, "Deployment"):
  - ntfy: an unguessable topic (whoever knows it can read and send its messages), subscribed in the ntfy app on the
    phone, optionally with an access token; the API gets `Notifications__NtfyUrl` (and `Notifications__NtfyToken`) from
    its `600` environment file.
  - The unit sets `Frontend__Root` (`/opt/claushh/web`) and the Kestrel URL (`http://127.0.0.1:5090`); the
    environment file sets `AllowedHosts` and the public origin in `Hubs__AllowedOrigins__0`.
  - The acceptance check on loopback (phase A) comes first: the service, the non-dumpable process, a login, a portal
    terminal inside the sandbox, containers, a backup with its restore, a reboot. The tunnel starts only after it has
    passed.
  - Cloudflare Access comes before the tunnel: the Access application, with a policy for the owner's e-mail and the
    one-time PIN, exists before the tunnel's public hostname and before `cloudflared` starts.
  - Cloudflare: HSTS for 12 months with `includeSubDomains`, without preload (HTTPS must then stay on for as long as
    browsers keep the policy); "Always Use HTTPS"; one rate-limiting rule `http.request.uri.path in {"/api/auth/login"
    "/api/auth/passkeys/login-options" "/api/auth/passkeys/login" "/api/auth/reauthenticate"}` (if the rule editor
    refuses `in`, the same paths joined with `or`), 5 requests in 10 s per IP, blocked for 10 s; Pseudo IPv4 off;
    "Remove visitor IP headers" off.
  - The tunnel acceptance check (phase B), through the real tunnel: a failed login with a forged `CF-Connecting-IP`
    and a forged `X-Forwarded-For`, and a request over `http://` with `X-Forwarded-Proto: https`. Then check that:
    - a browser without an Access session gets the PIN page before any page of the portal;
    - `http://` redirects to `https://`, and HSTS is present;
    - the portal loads with `AllowedHosts=<domain>` (a `400` means that `cloudflared` sends another Host);
    - a login sets the `__Host-claushh-session` cookie;
    - the login history shows the device's real public IP, not the forged values and not 127.0.0.1;
    - two networks (phone data and home Wi-Fi) show different IPs;
    - a terminal still answers after 10 idle minutes (the hub's WebSocket through the tunnel);
    - the login notification arrives.
    - a passkey: adding one in Security asks for the password and a code first and sends the "added" notification; a
      login with it shows `passkey` in the history and its notification names it; the same on the phone (the Security
      sheet, then the login button); removing it sends the "removed" notification.

Deployment decisions:
- The API runs as `claushh.service` (`deploy/claushh.service`), as the user `workspace`, on `http://127.0.0.1:5090`
  (development keeps 5080 on the same machine), `Type=exec`, with logs in the `systemd` console format for the
  journal. When the database is not up yet at boot, the start fails in the migrations and `Restart=on-failure` tries
  again every 5 s. Rejected: `Type=notify` (a new package for the readiness signal).
- Generic settings are `Environment=` lines of the unit; the install-specific ones (connection string, domain, ntfy)
  are in `/etc/claushh/claushh.env` (root, `600`), which systemd reads before the service starts and which wins over
  `Environment=`. Values with `;` are single-quoted, which systemd and `sh` read the same way; the database password is
  hex, so nothing needs escaping. Rejected: secrets in `Environment=` (every local user can read them with
  `systemctl show`) and `LoadCredential=` for the API's settings (the API reads its configuration from the
  environment; one mechanism for all of it).
- `AllowedHosts` is the public domain from the first start; local requests on the server send `Host: <domain>`. The
  tunnel acceptance check shows which Host `cloudflared` sends: a `400` would mean another one, fixed with the
  tunnel's HTTP Host header setting. Rejected: `*` until that check (the `400` is the check).
- The sandbox of the unit is also that of the terminal and the console, which are the API's children:
  - `ProtectSystem=strict`, `ProtectHome=tmpfs` with only `/home/workspace` bound (`BindPaths=`),
    `ReadWritePaths=/srv/projects`, `PrivateTmp`, `NoNewPrivileges`, and `KillMode=mixed` (the API's own stop order
    runs first);
  - an empty `CapabilityBoundingSet=`, `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`,
    `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictSUIDSGID`,
    `RestrictRealtime`, `LockPersonality`. In the terminal they cost `dmesg`, other users' processes in `ps`, and
    setting the clock or the host name;
  - tried at the acceptance check, and kept where the terminal's work (containers, `dotnet test`, `npm test`, e2e)
    still passes: `SystemCallFilter=@system-service` with `SystemCallErrorNumber=EPERM` and
    `SystemCallArchitectures=native`, `RestrictNamespaces=yes`, `PrivateDevices=yes`,
    `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`;
  - not set: `MemoryDenyWriteExecute=` (the .NET JIT and Node write code at run time), `RemoveIPC=` (at a stop it
    would remove the IPC objects of the whole user, whose user manager and Podman keep running), `UMask=0077`
    (containers whose image runs as another user could not read their bind mounts; `/srv/projects` and the home are
    `0700` anyway), `ProcSubset=pid` (tools read `/proc/meminfo` and the like) and `PrivateNetwork=` (the tunnel and
    the terminal need the network).
- `DOTNET_EnableDiagnostics=0`: the API opens no .NET diagnostic socket. `LimitCORE=0`: the API and its children
  write no core dumps (a crash before the start, e.g. in the migrations while PostgreSQL is not up yet, would leave
  the process's memory on disk); `create-user` runs with the same limit.
- Containers in the terminal come from the rootless Podman of `workspace`. A user drop-in
  (`deploy/podman-socket.conf`) moves its `podman.socket` to `~/.local/state/podman/podman.sock`, inside the bound
  home, and the unit points `DOCKER_HOST` and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` of the terminal at it
  (`Terminal:Environment`); the override is needed because Testcontainers' default `/var/run/docker.sock` is the
  system Docker. The user's manager starts at boot (lingering). Rejected: the `docker` group (root-equivalent) and the
  default socket under `/run/user/<uid>/` (`ProtectHome=tmpfs` hides it, and binding it needs the user's UID in the
  unit and an ordering on the user's manager).
- PostgreSQL 17 from `deploy/docker-compose.yml` runs under the system Docker as the compose project `claushh-prod` on
  `127.0.0.1:5435`, with its variables in `/etc/claushh/compose.env` (root, `600`); the host port is `POSTGRES_PORT`
  (default 5432), and development uses the project `claushh-dev`. Rejected: `name:` in the file (a command without
  `-p` would act on that project) and one project for both (they would share the data volume).
- Backups: `claushh-backup.service` (root, oneshot) from a daily timer with `Persistent=true` (a day missed while the
  computer was off runs at the next start) runs `deploy/backup.sh`: the container's own `pg_dump -Fc` into
  `/var/backups/claushh` (root, `0700`), first as `.part`, then renamed, kept 14 days; a `.part` that a killed dump
  left is deleted once it is a day old. `backup.sh restore` loads a dump into a new database in one transaction and
  then, only with the API stopped (`inactive` or `failed`, not while systemd is about to start it again), gives it the
  live database's name; the replaced database stays as `before_restore_<time>`. With a database name as a second
  argument it only loads the dump into a new database of that name. Rejected: the host's `pg_dump` (another major
  version; its dump may not load into 17), plain SQL (larger, no selective restore) and `pg_restore --clean` into the
  live database (the tables of a newer migration would block it or survive it).
- The tunnel is remotely managed. `cloudflared` runs on the host, so its requests reach the API from loopback, which
  `ForwardedHeaders` trusts; it runs as `deploy/cloudflared.service` with a dynamic user, its own sandbox and the token
  as a credential (`LoadCredential=` from `/etc/cloudflared/tunnel-token`, root, `600`, passed as `--token-file`, which
  needs cloudflared 2025.4.0 or later). Rejected: the token on the command line (visible in `ps` and
  `systemctl show`) and `cloudflared` in Docker (its requests would not come from loopback).
- Firewall: firewalld, with `ssh` removed from the zone `public` and allowed by one rich rule from the home network;
  no inbound port for the tunnel. Rejected: `--add-source` on the zone `home` (it would also open that zone's other
  services to the network).
- The Data Protection keys stay at the framework's default, `~/.aspnet/DataProtection-Keys` in the bound home of
  `workspace`, so the antiforgery tokens of open tabs survive a restart. Rejected: a key path in code.
- Layout: `/opt/claushh/{api,web,deploy}` belongs to root (the API's user cannot change the installed API or
  frontend); `/etc/claushh` and `/var/backups/claushh` are root `0700`; `/srv/projects` belongs to `workspace`
  (`0700`). The console's `claude` is installed with Anthropic's installer as `workspace`
  (`/home/workspace/.local/bin/claude`), with its updates off (`DISABLE_UPDATES=1`, `DISABLE_AUTOUPDATER=1`); the
  owner updates it on purpose. Rejected: the API's files owned by `workspace`.
- The computer is a desktop: the BIOS powers it on after a power loss, and `sleep.target`, `suspend.target`,
  `hibernate.target` and `hybrid-sleep.target` are masked.
- Build and install are two steps: `deploy/install.sh build <dir>` runs as the owner (a self-contained `dotnet
  publish` for linux-x64 and the frontend build); `sudo deploy/install.sh install <dir>` checks the server, copies the
  build next to the installed one while the API still runs, takes a dump before an update, stops the API, swaps in the
  new `/opt/claushh/{api,web,deploy}` (the previous copy stays as `*.previous`), installs the units and starts the API
  again when it is enabled, with a health check. It never enables the API and never starts `cloudflared`. Rejected: one
  script run as root (`npm ci` would run dependency scripts as root and leave root-owned files in the checkout)
  replacing files under a running process, and copying with the API stopped (a full disk would leave it stopped).
- A rollback is the `*.previous` copies plus the dump taken before the update, because an older build does not undo
  migrations.
- Before the tunnel, the first login and a portal terminal are tested on loopback: a temporary drop-in
  `claushh.service.d/local-test.conf` starts the API with `--Sessions:SecureCookies=false`,
  `--Hubs:AllowedOrigins:1=http://127.0.0.1:5090` and `--AllowedHosts=*` (command-line settings win over the
  environment). It is removed before the tunnel starts, and the `__Host-` cookie behind the tunnel shows that it is
  gone. Rejected: an `Environment=` drop-in (the environment file wins over it), a separate `systemd-run` shell (it
  would not test the terminal inside the service) and the tunnel first. Passkeys need a domain, so they are registered
  and tried through the tunnel (phase B), never on `127.0.0.1`.
- In Production, once the host has started, the API makes its process non-dumpable (`prctl(PR_SET_DUMPABLE, 0)`,
  `Files/Libc.cs`): its `/proc` files belong to root, and no process of its user can attach to it. When that fails,
  the API logs it with its errno and ends with exit status 71 (`EX_OSERR`); the unit's `RestartPreventExitStatus=71`
  keeps systemd from starting it again, so the unit is left `failed`. Rejected: the first line of `Program.cs` (a test
  that runs the API in Production inside the test process would change that process for the rest of the run), a
  setting that switches it off, and reading `ASPNETCORE_ENVIRONMENT` directly (a host that defaults to Production
  without it would skip it). It has no automated test: an in-process test would change the test host itself, and a
  test in a child process would need a second runnable API with a database, tmux and a frontend build; the acceptance
  check on the server covers it (`README.md`, "Deployment", phase A).

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
  - [x] Backend, part C: security headers and serving `index.html`, ForwardedHeaders, notifications.
  - [x] Frontend: session countdown in the top bar (stage 5).
  - [ ] Deployment: Cloudflare Tunnel and Access, systemd service, backups.
- [x] **Stage 2: files and editor.**
  - [x] Frontend: explorer with lazy loading, Monaco with tabs, saving (Ctrl+S), detection of
        conflicts with changes on disk, status bar (cursor, language, unsaved).
  - [x] Backend: files API from the contract in `ARCHITECTURE.md`, path protection (including symlinks), file versions,
        size limits, binary file detection.
  - [x] Marking of changed files (`M`, `U`, …) in the explorer (frontend, based on the git status from stage 4).
- [x] **Stage 3: console.**
  - [x] Frontend: Console panel (plain text), model / effort / mode, permission requests, interrupt (Esc),
        new conversation, replaying the conversation after a reload and in other tabs, refreshing files changed
        by the console, SignalR connection with session control.
  - [x] Backend: hub `/hubs/console` from the contract in `ARCHITECTURE.md`, `claude` process with stream-json,
        permission requests through stdio control requests (`--permission-prompt-tool stdio`), storing
        conversations, resuming (`--resume`).
- [x] **Stage 4: git, terminal, workspaces.**
  - [x] Frontend: Workspace panel (workspaces, repository table, Open / Pull / Push, creating a
        workspace, cloning), open repo in the URL, path and branch in the top bar, branch and number of changes
        in the status bar, git markers in the explorer, a separate console conversation for each repo.
  - [x] Frontend: Terminal tab (xterm.js): multiple terminals, reattaching after a reload without losing
        or duplicating output, size fitting, `exit`, Ctrl+S for the program in the terminal.
  - [x] Backend: workspaces and git API from the contract in `ARCHITECTURE.md` (LibGit2Sharp locally, the `git` CLI
        for the network, display names in the database, a background fetch at most every 5 minutes).
  - [x] Backend: hub `/hubs/terminal` from the contract in `ARCHITECTURE.md` (terminal: tmux in control mode).
- [ ] **Stage 5: polish.**
  - [x] Frontend: session countdown with extension on activity, "Security" dialog (active sessions,
        login history, "Log out other sessions" and "Log out everywhere"), diff view against HEAD in the editor.
  - [x] Frontend: fixes from the security review (pasting and typing in the terminal, OSC 8 links, focus,
        permission requests in the console, strict clone URL, unconfirmed logout without returning to the app,
        expiry without the server, "Log out everywhere", CSP with Trusted Types and headers, XSRF token bound to the identity,
        mock only on `127.0.0.1`), verified in several rounds of independent review, with integration and e2e tests.
  - [x] Backend: passkeys.
  - [x] Frontend: passkeys (Security dialog, login button).
  - [x] Colors (the owner will refine them in later iterations), a possible phone view (low priority).
  - [x] Frontend: the VS Code layout (title bar, side bars, search, open editors, file icons, the console composer and its file chip, resizable panels).
