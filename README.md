# Claushh

A private web portal for working on projects from any device: code editor, console for Claude Code,
terminal and git in the browser. Runs on a home computer (EndeavourOS), access through Cloudflare Tunnel,
login with a password and a TOTP code. One user.

Status: **frontend ready (login and sessions, editor with a diff view, console, workspaces and git, terminal);
backend: login, sessions, login protection, the security headers, serving the built frontend, the client IP behind
Cloudflare and login notifications (stage 1, parts A-C), the files API (stage 2), the workspaces and git API and the
terminal hub (stage 4).** Not deployed yet: the steps are in "Deployment" below.
Progress: [`docs/PLAN.md`](docs/PLAN.md), section "Stages".

## Documentation

| File | About |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | goal, interface, stack, security, deployment, stages |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | current code map, endpoints, conventions, tests |
| [`CLAUDE.md`](CLAUDE.md) | working rules for the repository (also for Claude Code) |

## Running in development

Requirements: Linux for the backend, .NET 10 SDK, Node.js 22.12+ (npm 11), Docker, git (the API runs it for clone,
fetch, pull and push), tmux 3.7 or later (the terminal; dotnet test needs it too).

```bash
# database (the compose project claushh-dev; the server uses claushh-prod)
cp deploy/.env.example deploy/.env    # fill in the password and a free POSTGRES_PORT
docker compose -p claushh-dev -f deploy/docker-compose.yml --env-file deploy/.env up -d

# backend: http://localhost:5080/api/health
dotnet user-secrets set --project src/Claushh.Api ConnectionStrings:Claushh \
  "Host=localhost;Port=<POSTGRES_PORT>;Database=claushh;Username=claushh;Password=<POSTGRES_PASSWORD from deploy/.env>"
dotnet user-secrets set --project src/Claushh.Api Projects:Root <directory>    # the projects directory of the portal
dotnet run --project src/Claushh.Api -- create-user    # once: the account and its TOTP key
dotnet run --project src/Claushh.Api

# frontend: http://localhost:4200
cd web
npm install
npm start
```

The backend reads repositories with libgit2, which comes with the build. Repositories in the projects directory must
belong to the user the API runs as: libgit2 refuses others, like git's safe.directory.

The Terminal tab runs your login shell (your `SHELL`) as you, on a tmux server of the API's own (socket in
`$XDG_RUNTIME_DIR/claushh`, apart from your own tmux), with only a few variables of the API's environment (HOME, USER,
PATH, the locale): none of the API's connection string, `ASPNETCORE_*`, `DOTNET_*` or `CLAUDECODE*` reach it (your login
profile may still set its own, e.g. `DOTNET_ROOT`). Terminals end when the API stops, also on Ctrl+C. Open the portal
at `http://localhost:4200`: hubs accept only the origins in `Hubs:AllowedOrigins` (`appsettings.Development.json`), so
`http://127.0.0.1:4200` gets no terminal or console.

Cloning, fetching and pulling a public repository needs no credential helper in development; pushing always needs
credentials (also for a public repository); the server's GitHub token is set up in "Deployment", step 8.

Login notifications (ntfy) are off in development unless `Notifications:NtfyUrl` is set
(`dotnet user-secrets set --project src/Claushh.Api Notifications:NtfyUrl https://ntfy.sh/<your topic>`, and optionally
`Notifications:NtfyToken`); on the server the API does not start without it.

Lost phone or leaked password: `create-user --reset-totp` gives the account a new TOTP key,
`create-user --reset-password` a new password; both end all sessions (commands in `docs/ARCHITECTURE.md`).

## Running the built frontend

The API serves the production build itself when `Frontend:Root` points at it, as on the server (one process, one
origin):

```bash
npm --prefix web run build    # the build in web/dist/web/browser
dotnet user-secrets set --project src/Claushh.Api Frontend:Root <absolute path>/web/dist/web/browser
dotnet run --project src/Claushh.Api
```

Then open `http://localhost:5080`, which is already one of the hubs' allowed origins (`appsettings.Development.json`).
The API takes the Content-Security-Policy header from `index.html` once at start, so restart it after a build that
changes the policy. Without `Frontend:Root` the API serves no frontend, and development uses `npm start` as above.

## Deployment

The portal runs on the home computer (EndeavourOS, a desktop): the API as `claushh.service` under the user
`workspace` on `127.0.0.1:5090`, PostgreSQL as the compose project `claushh-prod` on `127.0.0.1:5435`, and in front of
them Cloudflare Access (a one-time PIN by e-mail) and a remotely managed Cloudflare Tunnel (`cloudflared.service`).
Decisions: `docs/PLAN.md`, "Deployment decisions"; the files: `deploy/` (`docs/ARCHITECTURE.md`, "Repository map").
You run every step yourself, from the repository root; `<domain>` is the portal's public host name and `<LAN>` the
home network's address (e.g. `192.168.1.0`).

### First install

1. Packages: `sudo pacman -S --needed podman cloudflared`. Choose `netavark` when pacman asks for the network stack.
   Do not install `podman-docker`: the `docker` CLI already talks to Podman's Docker-compatible API.
2. The user: `sudo useradd -m -s /usr/bin/zsh workspace` (no password: nobody logs in as it). Then
   `grep workspace /etc/subuid /etc/subgid` shows 65536 IDs in each file, overlapping no other range there; otherwise
   `sudo usermod --add-subuids 165536-231071 --add-subgids 165536-231071 workspace` (any free range).
3. `sudo loginctl enable-linger workspace`: the user manager of `workspace`, and with it Podman's socket, starts at
   boot.
4. Directories:
   ```bash
   sudo install -d -o workspace -g workspace -m 0700 /srv/projects
   sudo install -d -m 0700 /etc/claushh /etc/cloudflared /var/backups/claushh
   ```
5. The environment files (root, `600`), filled in with `sudoedit`; make the database password with
   `openssl rand -hex 32`:
   ```bash
   sudo install -m 0600 deploy/.env.example /etc/claushh/compose.env
   sudo install -m 0600 deploy/claushh.env.example /etc/claushh/claushh.env
   sudoedit /etc/claushh/compose.env /etc/claushh/claushh.env
   ```
   `compose.env`: the password and `POSTGRES_PORT=5435`. `claushh.env`: the same password, `<domain>` (twice) and the
   ntfy topic URL (`docs/PLAN.md`, "Deployment on EndeavourOS").
6. Build as you, install as root. `install` checks steps 2-5 and copies the files and the units; the first time it
   starts nothing:
   ```bash
   deploy/install.sh build ~/claushh-build
   sudo deploy/install.sh install ~/claushh-build
   ```
7. The database; afterwards `ss -ltn` shows port 5435 only on `127.0.0.1`:
   ```bash
   sudo docker compose -p claushh-prod -f /opt/claushh/deploy/docker-compose.yml --env-file /etc/claushh/compose.env up -d
   ```
8. As `workspace` (`sudo -iu workspace`):
   - the dotfiles, and the git identity (`git config --global user.name …` and `user.email …`);
   - the GitHub token: a fine-grained personal access token with "Only select repositories" and Contents read and
     write, kept by git's `store` helper for `https://github.com` only:
     ```bash
     install -d -m 0700 ~/.config/git
     git config --global credential.https://github.com.helper 'store --file /home/workspace/.config/git/github-credentials'
     mkdir /srv/projects/<workspace>
     git clone https://github.com/<owner>/<repository>.git /srv/projects/<workspace>/<repository>
     ```
     Give the token as the password: the helper writes it to that file, readable only by `workspace`;
   - `git config --show-origin --get-regexp '^protocol\.'` prints nothing: a `protocol.<name>.allow` there would win
     over the API's `protocol.allow=never` (`install.sh install` refuses then too);
   - Podman's socket in the home directory, where the API's unit sees it:
     ```bash
     install -D -m 0644 /opt/claushh/deploy/podman-socket.conf ~/.config/systemd/user/podman.socket.d/claushh.conf
     ```

   Then, as you, check that Podman has the user unit (`pacman -Ql podman | grep systemd/user` and
   `sudo systemctl --user -M workspace@ cat podman.socket`), and start the socket:
   ```bash
   sudo systemctl --user -M workspace@ daemon-reload
   sudo systemctl --user -M workspace@ enable --now podman.socket
   ```
9. The first start, on loopback only. `sudo systemctl edit --drop-in=local-test claushh`, with:
   ```ini
   [Service]
   ExecStart=
   ExecStart=/opt/claushh/api/Claushh.Api --Sessions:SecureCookies=false --Hubs:AllowedOrigins:1=http://127.0.0.1:5090 --AllowedHosts=*
   ```
   The browser on this computer can then log in at `http://127.0.0.1:5090` over plain http. Then
   `sudo systemctl enable --now claushh`.
10. The account. It asks for the name, the password and a TOTP code, so it needs a terminal:
    ```bash
    sudo systemd-run --pty --wait --collect --uid=workspace -p EnvironmentFile=/etc/claushh/claushh.env \
      -E ASPNETCORE_ENVIRONMENT=Production -E DOTNET_EnableDiagnostics=0 --working-directory=/opt/claushh/api \
      /opt/claushh/api/Claushh.Api create-user
    ```
    `create-user --reset-totp` and `--reset-password` run the same way. If `systemd-run` refuses `EnvironmentFile=`:
    ```bash
    sudo env ASPNETCORE_ENVIRONMENT=Production DOTNET_EnableDiagnostics=0 bash -c 'set -a; . /etc/claushh/claushh.env; set +a; cd /opt/claushh/api && exec runuser -u workspace -- ./Claushh.Api create-user'
    ```
11. Phase A below. It must pass before step 17.
12. Backups: `sudo systemctl enable --now claushh-backup.timer`, then the backup and restore of phase A.
13. The firewall. Read `sudo firewall-cmd --list-all` first, then:
    ```bash
    sudo firewall-cmd --permanent --zone=public --remove-service=ssh
    sudo firewall-cmd --permanent --zone=public --add-rich-rule='rule family=ipv4 source address=<LAN>/24 service name=ssh accept'
    sudo firewall-cmd --reload
    ```
14. Power: in the BIOS, power on after a power loss; then
    `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` (this also turns off suspend
    from the desktop).
15. The end of the loopback phase:
    ```bash
    sudo rm /etc/systemd/system/claushh.service.d/local-test.conf
    sudo systemctl daemon-reload
    sudo systemctl restart claushh
    ```
16. In the Cloudflare dashboard, in this order: the Access application for `<domain>` with a policy that allows only
    your e-mail and the one-time PIN as the login method; the tunnel (remotely managed; copy its token); its public
    hostname `<domain>` with the service `http://127.0.0.1:5090`; the settings in `docs/PLAN.md`, "Deployment on
    EndeavourOS".
17. Only after steps 1-15 and phase A have passed, the token and the tunnel:
    ```bash
    sudo sh -c 'umask 077; cat > /etc/cloudflared/tunnel-token'    # paste the token, Enter, Ctrl-D
    sudo systemctl enable --now cloudflared
    ```
18. Phase B below.

### The console

Once the console hub is part of the API: as `workspace` (`sudo -iu workspace`), install the CLI with Anthropic's
installer, then log in once in the console's own configuration directory, with updates off:
```bash
curl -fsSL https://claude.ai/install.sh | bash    # the launcher: /home/workspace/.local/bin/claude
install -d -m 0700 ~/.local/state/claushh/claude
CLAUDE_CONFIG_DIR=$HOME/.local/state/claushh/claude DISABLE_UPDATES=1 DISABLE_AUTOUPDATER=1 ~/.local/bin/claude
```
and `/login` in it. The login is kept in `.credentials.json` there; renew it the same way when the CLI warns. The
console's settings come with it (`deploy/claushh.env.example`). To update the CLI on purpose, as `workspace`:
`~/.local/bin/claude update`, or the installer again (`curl -fsSL https://claude.ai/install.sh | bash -s <version>`
for a given version); then `sudo systemctl restart claushh`, which ends the open terminals and console processes.

### Phase A: on loopback, before the tunnel

- **Service.** `systemctl is-active claushh` gives `active`; `curl -s http://127.0.0.1:5090/api/health` gives
  `{"status":"ok"}`; `journalctl -u claushh` has no warning about Data Protection keys kept only in memory; and
  `sudo ls /home/workspace/.aspnet/DataProtection-Keys` lists `key-*.xml`.
- **Login** at `http://127.0.0.1:5090` in the browser of this computer; the ntfy notification arrives.
- **Terminal.** In a portal terminal:
  - `id` shows only the group `workspace`; `grep NoNewPrivs /proc/self/status` gives `1`; `cat /proc/self/cgroup`
    ends in `claushh.service`; `sudo true` fails;
  - `touch /usr/x /etc/x /opt/claushh/x` fails ("Read-only file system"); `touch ~/x /srv/projects/x` works (remove
    both files again);
  - `ls /home` shows only `workspace`, and `ls /run/user` nothing;
  - `env` shows no connection string, ntfy URL, `ASPNETCORE_*` or `DOTNET_*` (your dotfiles may set their own);
    `ls /tmp/dotnet-diagnostic-*` finds nothing;
  - `docker -H unix:///run/docker.sock ps` is refused;
  - the protocol check of step 8 prints nothing, and a push of a branch through the token works;
  - after `sudo systemctl restart claushh` (as you), saving in the editor tab that stayed open works.
- **Containers.** In a portal terminal:
  - `docker info` shows Podman's server, rootless;
  - `docker run --rm docker.io/library/alpine echo ok` prints `ok`;
  - `docker run -d --name web-check -p 127.0.0.1:18080:80 docker.io/library/nginx`, then `curl 127.0.0.1:18080`
    answers, then `docker rm -f web-check`;
  - in a clone of Claushh under `/srv/projects`, `dotnet test` passes (Testcontainers on Podman).

  If a short image name fails (`docker run alpine`), add `unqualified-search-registries = ["docker.io"]` to
  `~/.config/containers/registries.conf`. If Testcontainers cannot start its Ryuk container, run the tests with
  `TESTCONTAINERS_RYUK_DISABLED=true` (then `docker container prune` after a crashed run).
- **Backup and restore:**
  ```bash
  sudo systemctl start claushh-backup.service
  sudo ls -l /var/backups/claushh    # claushh-<time>.dump, mode 600
  sudo /opt/claushh/deploy/backup.sh restore /var/backups/claushh/<that file> claushh_restore_check
  ```
  The row counts of `"Sessions"` and `"LoginAttempts"` agree in both databases, e.g.
  `sudo docker compose -p claushh-prod -f /opt/claushh/deploy/docker-compose.yml --env-file /etc/claushh/compose.env exec postgres psql -U claushh -d claushh_restore_check -c 'select count(*) from "Sessions"'`
  and the same with `-d claushh`; then the same command with `dropdb -U claushh claushh_restore_check` instead of
  `psql …`.
- **Trial options.** `sudo systemctl edit --drop-in=trial claushh`, with:
  ```ini
  [Service]
  SystemCallFilter=@system-service
  SystemCallErrorNumber=EPERM
  SystemCallArchitectures=native
  RestrictNamespaces=yes
  PrivateDevices=yes
  RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
  ```
  Then `sudo systemctl restart claushh`, repeat "Terminal" and "Containers", and run `npm test` and `npm run e2e` in
  the clone. Keep the lines whose work passes, remove the others from `trial.conf`, and note what failed and why. This
  does not hold up step 17.
- **Reboot.** After a restart of the computer the portal answers, `docker` works in a terminal, the database runs and
  `systemctl list-timers` lists `claushh-backup.timer`.

### Phase B: through the tunnel

- **Access.** A browser without an Access session gets Cloudflare's PIN page before any page of the portal; the PIN
  goes only to your e-mail.
- **Forged headers.** Try a login with a wrong password in the browser, copy that request from the developer tools
  (Network, `login`, "Copy as cURL"), and send it again with
  `-H 'CF-Connecting-IP: 203.0.113.7' -H 'X-Forwarded-For: 203.0.113.8'` added. After a real login, the history in
  "Bezpieczeństwo" shows that attempt with your public IP, not 203.0.113.x and not 127.0.0.1.
  `curl -sI -H 'X-Forwarded-Proto: https' http://<domain>/` answers with a redirect to `https://`. Logins from two
  networks (phone data, home Wi-Fi) show two different IPs.
- **Cookie.** The session cookie is `__Host-claushh-session` (developer tools, Application, Cookies), which also shows
  that `local-test.conf` is gone.
- **Host.** The portal loads. A `400` means `cloudflared` sends another Host: set the HTTP Host header of the public
  hostname to `<domain>` in the tunnel's settings.
- **WebSocket.** A terminal still answers after 10 idle minutes, and the output of `docker run` streams.
- **Headers.** On `/` the developer tools show `Content-Security-Policy` with `frame-ancestors 'none'`,
  `X-Frame-Options: DENY` and `Strict-Transport-Security`; the ntfy notification of this login arrives.

### Updates

On the commit to install, in your checkout:
```bash
deploy/install.sh build ~/claushh-build
sudo deploy/install.sh install ~/claushh-build
```
`install` takes a dump first (when the database runs), stops the API, keeps the installed files as
`/opt/claushh/*.previous`, installs the new ones and the units, starts the API again when it was running and waits up
to 60 s for `/api/health`. The restart ends the open terminals and console processes; conversations come back. Build
and install again also when .NET publishes a security patch: the API is a self-contained build, which `pacman -Syu`
does not update.

### Rollback

An older build does not undo database migrations, so a rollback also restores the dump that `install` took before the
update (the newest file in `/var/backups/claushh` from before it):
```bash
sudo systemctl stop claushh
sudo rm -rf /opt/claushh/api /opt/claushh/web /opt/claushh/deploy
sudo mv /opt/claushh/api.previous /opt/claushh/api
sudo mv /opt/claushh/web.previous /opt/claushh/web
sudo mv /opt/claushh/deploy.previous /opt/claushh/deploy
sudo install -m 0644 /opt/claushh/deploy/*.service /opt/claushh/deploy/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo /opt/claushh/deploy/backup.sh restore /var/backups/claushh/<the dump from before the update>
sudo systemctl start claushh
```
The database the restore replaced stays as `before_restore_<time>`; once the portal works, drop it:
```bash
sudo docker compose -p claushh-prod -f /opt/claushh/deploy/docker-compose.yml --env-file /etc/claushh/compose.env exec postgres dropdb -U claushh before_restore_<time>
```

### Restoring a dump

`sudo /opt/claushh/deploy/backup.sh restore <file>` loads a dump into a new database in one transaction and then
gives it the live database's name; the replaced database stays as `before_restore_<time>` (drop it as in "Rollback"
once the portal works), and a load that fails leaves only a new database `restore_<time>`, dropped the same way. It
refuses while the API runs (`sudo systemctl stop claushh` first, `start` after). With a database name as a second
argument it loads the dump into a new database of that name instead, as in phase A. The daily run:
`systemctl list-timers claushh-backup.timer` and `journalctl -u claushh-backup`.

## Frontend tests

```bash
cd web
npm test                          # integration (Vitest)
npx playwright install chromium   # once, browser for e2e
npm run e2e                       # build + e2e on the mock backend (e2e/mock-api)
```

Run the tests through npm: `web/.npmrc` starts Node with `--no-experimental-webstorage`, because from Node 25 on
Node's own `localStorage` hides jsdom's (the test environment's). For npm scripts in `web/` this setting replaces a
`NODE_OPTIONS` set in your shell.

## Backend tests

```bash
dotnet test    # integration tests; needs Docker (starts PostgreSQL 17 in a container)
```

Also needs the git CLI ≥ 2.45 (some test repositories use `--ref-format=reftable`).
