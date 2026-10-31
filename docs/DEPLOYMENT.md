# Deployment

The portal runs on a Linux server of your own: the API as `claushh.service` under the user `workspace` on
`127.0.0.1:5090`, PostgreSQL as the compose project `claushh-prod` on `127.0.0.1:5435`, and in front of them Cloudflare
Access (a one-time PIN by e-mail) and a remotely managed Cloudflare Tunnel (`cloudflared.service`). The steps were
written for EndeavourOS on a desktop, so step 1 (the packages), step 13 (the firewall) and step 14 (power) depend on
the distribution and the machine. Decisions: `docs/PLAN.md`, "Deployment decisions"; the files: `deploy/`
(`docs/ARCHITECTURE.md`, "Repository map"). You run every step yourself, from the repository root; `<domain>` is the
portal's public host name and `<LAN>` the address of the network SSH stays open to (e.g. `192.168.1.0`).

## First install

1. Packages: Docker with its compose plugin (the database and the backup run `docker compose`, and `claushh.service`
   waits for `docker.service`), then `sudo pacman -S --needed podman cloudflared`. Choose `netavark` when pacman asks
   for the network stack. Do not install `podman-docker`: the `docker` CLI already talks to Podman's Docker-compatible
   API.
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
   `compose.env`: the password and `POSTGRES_PORT=5435`. `claushh.env`: the same password, `<domain>` (three times)
   and the ntfy topic URL (`docs/PLAN.md`, "Deployment on EndeavourOS").
6. Build as you, install as root. `install` checks steps 2, 4 and 5 and copies the files and the units; the first time
   it starts nothing:
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
    sudo systemd-run --pty --wait --collect --uid=workspace -p EnvironmentFile=/etc/claushh/claushh.env -p LimitCORE=0 \
      -E ASPNETCORE_ENVIRONMENT=Production -E DOTNET_EnableDiagnostics=0 --working-directory=/opt/claushh/api \
      /opt/claushh/api/Claushh.Api create-user
    ```
    `create-user --reset-totp` and `--reset-password` run the same way. If `systemd-run` refuses `EnvironmentFile=`:
    ```bash
    sudo env ASPNETCORE_ENVIRONMENT=Production DOTNET_EnableDiagnostics=0 bash -c 'ulimit -c 0; set -a; . /etc/claushh/claushh.env; set +a; cd /opt/claushh/api && exec runuser -u workspace -- ./Claushh.Api create-user'
    ```
11. Phase A below (its "Backup and restore" and "Reboot" items after step 12). It must pass before step 17.
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

## The console

As `workspace` (`sudo -iu workspace`), install the CLI with Anthropic's installer, then log in once in the console's
own configuration directory, with updates off:
```bash
curl -fsSL https://claude.ai/install.sh | bash    # the launcher: /home/workspace/.local/bin/claude
install -d -m 0700 ~/.local/state/claushh/claude
CLAUDE_CONFIG_DIR=$HOME/.local/state/claushh/claude DISABLE_UPDATES=1 DISABLE_AUTOUPDATER=1 ~/.local/bin/claude
```
and `/login` in it. The login is kept in `.credentials.json` there; renew it the same way when the CLI warns. The unit
points `Console__ClaudePath` at that launcher, and the API uses that directory by default (`Console:ConfigDirectory`).
The API checks the CLI before the first console prompt, so the CLI can be installed while the API runs. To use an
Anthropic API key instead of the login, see `Console__ApiKeyFile` in `deploy/claushh.env.example`. To update the CLI
on purpose, as `workspace`: `~/.local/bin/claude update`, or the installer again
(`curl -fsSL https://claude.ai/install.sh | bash -s <version>` for a given version); then
`sudo systemctl restart claushh`, which ends the open terminals and console processes.

A "yes, always" rule is removed on the server as in development ([DEVELOPMENT.md](DEVELOPMENT.md), "Running in
development"), in the production database:
```bash
sudo docker compose -p claushh-prod -f /opt/claushh/deploy/docker-compose.yml --env-file /etc/claushh/compose.env \
  exec postgres psql -U claushh -d claushh -c "DELETE FROM \"ConsoleRules\" WHERE \"ProjectPath\" = '<project>' AND \"Rule\" = '<rule>'"
```

## The terminal's colours (pywal)

Optional, when your desktop terminal takes its colours from pywal: the portal's terminal then has the same palette,
also after a reload (`docs/ARCHITECTURE.md`, "Terminal theme API contract"). `claushh-wal-sync@<you>.path` watches
your `~/.cache/wal/colors.json`; on every change `claushh-wal-sync@<you>.service` copies it and pywal's `sequences`
into `/home/workspace/.cache/wal`, where the API reads the colours (`Terminal:ThemeFile`, set in the unit) and the
dotfiles of `workspace` can print the sequences. The units expect your home at `/home/<you>`. As you:
```bash
sudo install -d -o workspace -g workspace -m 0755 /home/workspace/.cache /home/workspace/.cache/wal
sudo systemctl enable --now "claushh-wal-sync@$USER.path"
sudo systemctl start "claushh-wal-sync@$USER.service"    # the first copy
```
A terminal takes the colours when it is created; one that is open while the wallpaper changes keeps its colours until
the page is reloaded. A failed copy shows in `journalctl -u "claushh-wal-sync@$USER"`.

## Phase A: on loopback, before the tunnel

- **Service.** `systemctl is-active claushh` gives `active`; `curl -s http://127.0.0.1:5090/api/health` gives
  `{"status":"ok"}`; `journalctl -u claushh` has no warning about Data Protection keys kept only in memory; and
  `sudo ls /home/workspace/.aspnet/DataProtection-Keys` lists `key-*.xml`.
- **Not dumpable** (as you, outside the portal):
  ```bash
  pid=$(systemctl show -p MainPID --value claushh)
  sudo stat -c %U:%G /proc/$pid/environ    # root:root
  sudo -u workspace cat /proc/$pid/environ    # Permission denied
  ```
  In a portal terminal the same `cat` gives "Permission denied" or "No such file or directory".
- **Login** at `http://127.0.0.1:5090` in the browser of this computer; the ntfy notification arrives. Passkeys cannot
  be tried here: `127.0.0.1` is not a domain, so they come in phase B.
- **Terminal.** In a portal terminal:
  - `id` shows only the group `workspace`; `grep NoNewPrivs /proc/self/status` gives `1`; `cat /proc/self/cgroup`
    ends in `claushh.service`; `sudo true` fails;
  - `touch /usr/x /etc/x /opt/claushh/x` fails ("Read-only file system"); `touch ~/x /srv/projects/x` works (remove
    both files again);
  - `ls /home` shows only `workspace`, and `ls /run/user` nothing;
  - `env` shows no connection string, ntfy URL, `ASPNETCORE_*` or `DOTNET_*` (your dotfiles may set their own);
    `ls /tmp/dotnet-diagnostic-*` finds nothing;
  - `docker -H unix:///run/docker.sock ps` is refused;
  - a push of a branch through the token works;
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
- **Console** (once "The console" above is done). In the Console panel, a prompt that runs `pwd` and `env` (answer
  "yes") shows the repository's directory and no `ConnectionStrings__*` or `Notifications__*` variable;
  `journalctl -u claushh` then shows `The console runs claude <version>`. This does not hold up step 17.
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
  Then the live restore, as a rollback runs it:
  ```bash
  sudo systemctl stop claushh
  sudo /opt/claushh/deploy/backup.sh restore /var/backups/claushh/<that file>
  sudo systemctl start claushh
  ```
  A login works afterwards; then drop the replaced database `before_restore_<time>` as in "Rollback".
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
  Then `sudo systemctl restart claushh`, repeat "Terminal", "Containers" and "Console", and run `npm test` and
  `npm run e2e` in the clone. Keep the lines whose work passes, remove the others from `trial.conf`, and note what
  failed and why. This does not hold up step 17.
- **Reboot.** After a restart of the computer the portal answers, `docker` works in a terminal, the database runs,
  `systemctl list-timers` lists `claushh-backup.timer`, and `sudo coredumpctl list /opt/claushh/api/Claushh.Api` shows
  no entry, or only entries whose COREFILE is `none` (the API may fail a start or two while the database comes up).

## Phase B: through the tunnel

- **Access.** A browser without an Access session gets Cloudflare's PIN page before any page of the portal; the PIN
  goes only to your e-mail.
- **Forged headers.** Try a login with a wrong password in the browser, copy that request from the developer tools
  (Network, `login`, "Copy as cURL"), and send it again with
  `-H 'CF-Connecting-IP: 203.0.113.7' -H 'X-Forwarded-For: 203.0.113.8'` added. After a real login, the history in
  "Security" shows that attempt with your public IP, not 203.0.113.x and not 127.0.0.1.
  `curl -sI -H 'X-Forwarded-Proto: https' http://<domain>/` answers with a redirect to `https://`. Logins from two
  networks (phone data, home Wi-Fi) show two different IPs.
- **Cookie.** The session cookie is `__Host-claushh-session` (developer tools, Application, Cookies), which also shows
  that `local-test.conf` is gone.
- **Host.** The portal loads. A `400` means `cloudflared` sends another Host: set the HTTP Host header of the public
  hostname to `<domain>` in the tunnel's settings.
- **WebSocket.** A terminal still answers after 10 idle minutes, and the output of `docker run` streams.
- **Headers.** On `/` the developer tools show `Content-Security-Policy` with `frame-ancestors 'none'`,
  `X-Frame-Options: DENY` and `Strict-Transport-Security`; the ntfy notification of this login arrives.
- **Passkey.** Add one in "Security": the password and a code are asked first, and the "passkey added" notification
  arrives. Log out and log in with it ("Log in with a passkey"): the history shows `passkey`, and the notification
  names it. Do the same on the phone (iOS 18.4 or later: the Security sheet, then the login button). Remove them: the
  "passkey removed" notifications arrive.

## Updates

On the commit to install, in your checkout:
```bash
deploy/install.sh build ~/claushh-build
sudo deploy/install.sh install ~/claushh-build
```
`install` copies the new build next to the installed one while the API still runs, takes a dump (when the database
runs), stops the API, swaps the directories (the installed files stay as `/opt/claushh/*.previous`), installs the
units, starts the API again when it is enabled and waits up to 60 s for `/api/health`. The restart ends the open
terminals and console processes; conversations come back. Build and install again also when .NET publishes a security
patch: the API is a self-contained build, which `pacman -Syu` does not update.

Each release on GitHub also carries this build as `claushh-<tag>-linux-x64.tar.gz`, made by
`.github/workflows/release.yml` with `install.sh build`. To use it instead of building, extract it into an empty
directory and run `sudo deploy/install.sh install <that directory>` from a checkout of the same tag.

The same workflow publishes these files as the package `ghcr.io/zambrzyckii/claushh`, tagged with the release's
version without the `v` and with `latest`. The image only holds the files under `/claushh` and runs nothing. For
v1.0.0 these commands copy them into a new directory for `install`:
```bash
docker create --name claushh-build ghcr.io/zambrzyckii/claushh:1.0.0 none
docker cp claushh-build:/claushh/. ~/claushh-1.0.0
docker rm claushh-build
```

## Rollback

An older build does not undo database migrations, so a rollback also restores the dump that `install` took before the
update (the newest file in `/var/backups/claushh` from before it). First check that the three earlier copies exist;
if one is missing (after the first install, or after a rollback), there is nothing to go back to: build and install
the commit you want instead.
```bash
sudo ls -d /opt/claushh/api.previous /opt/claushh/web.previous /opt/claushh/deploy.previous
sudo systemctl stop claushh
sudo rm -rf /opt/claushh/api.failed /opt/claushh/web.failed /opt/claushh/deploy.failed
sudo mv /opt/claushh/api /opt/claushh/api.failed
sudo mv /opt/claushh/web /opt/claushh/web.failed
sudo mv /opt/claushh/deploy /opt/claushh/deploy.failed
sudo mv /opt/claushh/api.previous /opt/claushh/api
sudo mv /opt/claushh/web.previous /opt/claushh/web
sudo mv /opt/claushh/deploy.previous /opt/claushh/deploy
sudo install -m 0644 /opt/claushh/deploy/*.service /opt/claushh/deploy/*.timer /opt/claushh/deploy/*.path /etc/systemd/system/
sudo systemctl daemon-reload
sudo /opt/claushh/deploy/backup.sh restore /var/backups/claushh/<the dump from before the update>
sudo systemctl start claushh
```
The build you left stays as `/opt/claushh/*.failed` until the next rollback.
The database the restore replaced stays as `before_restore_<time>`; once the portal works, drop it:
```bash
sudo docker compose -p claushh-prod -f /opt/claushh/deploy/docker-compose.yml --env-file /etc/claushh/compose.env exec postgres dropdb -U claushh before_restore_<time>
```

## Restoring a dump

`sudo /opt/claushh/deploy/backup.sh restore <file>` loads a dump into a new database in one transaction and then gives
it the live database's name; the replaced database stays as `before_restore_<time>` (drop it as in "Rollback" once the
portal works), and a load or a rename that fails leaves the live database as it was, plus a new database
`restore_<time>`, dropped the same way. It refuses unless the API is stopped (`inactive` or `failed`, also not while
systemd is about to start it again after a failure): `sudo systemctl stop claushh` first, `start` after. With a
database name as a second argument it loads the dump into a new database of that name instead, as in phase A. The
daily run: `systemctl list-timers claushh-backup.timer` and `journalctl -u claushh-backup`.
