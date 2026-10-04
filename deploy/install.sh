#!/usr/bin/env bash
# Builds Claushh and installs it on the server (README.md, "Deployment"; decisions: docs/PLAN.md, "Deployment
# decisions").
#   install.sh build <dir>     as you: the self-contained API, the frontend build and deploy/ into <dir>
#   install.sh install <dir>   as root: checks, a dump before an update, /opt/claushh/{api,web,deploy} replaced (the
#                              old copy kept as *.previous), the units installed, the API started again if it is enabled
# It never enables claushh.service and never enables or starts cloudflared.service.
set -euo pipefail

repo=$(realpath -- "$(dirname -- "${BASH_SOURCE[0]}")/..")
readonly repo
readonly prefix=/opt/claushh
readonly -a units=(claushh.service cloudflared.service claushh-backup.service claushh-backup.timer)

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'usage: install.sh build <dir> | install.sh install <dir>\n' >&2
  exit 2
}

build() {
  # npm ci runs the dependencies' scripts: never as root, and never leaving root-owned files in the checkout.
  [[ $EUID -ne 0 ]] || die "build runs as you, not as root"
  local out
  out=$(realpath -m -- "$1")
  [[ $out != / && $out != "$repo" && $out != "$repo"/* ]] || die "build into a directory outside the checkout"
  if [[ -e $out && -n $(find "$out" -mindepth 1 -maxdepth 1 -print -quit) && ! -e $out/api/Claushh.Api ]]; then
    die "$out is neither empty nor an earlier build"
  fi
  mkdir -p -- "$out"
  rm -rf -- "${out:?}/api" "${out:?}/web" "${out:?}/deploy"
  dotnet publish "$repo/src/Claushh.Api" -c Release -r linux-x64 --self-contained true -o "$out/api"
  npm --prefix "$repo/web" ci
  npm --prefix "$repo/web" run build
  cp -a -- "$repo/web/dist/web/browser" "$out/web"
  mkdir -- "$out/deploy"
  install -m 0644 -- "$repo"/deploy/*.service "$repo"/deploy/*.timer "$repo/deploy/docker-compose.yml" \
    "$repo/deploy/podman-socket.conf" "$out/deploy/"
  install -m 0755 -- "$repo/deploy/backup.sh" "$out/deploy/"
  printf '\ninstall.sh: built into %s. Install it with:\n  sudo %s install %s\n' "$out" "$repo/deploy/install.sh" "$out"
}

# A protocol.<name>.allow in the git config of workspace would win over the API's -c protocol.allow=never. Read as the
# API's git reads it under systemd: HOME set, no XDG_CONFIG_HOME, outside any repository.
check_git_protocols() {
  local found status=0
  found=$(runuser -u workspace -- env -i HOME=/home/workspace PATH=/usr/bin \
    git -C / config --show-origin --get-regexp '^protocol\.') || status=$?
  case $status in
    0) die "the git config of workspace sets protocol rules (README.md, \"Deployment\", step 8):"$'\n'"$found" ;;
    1) ;;
    *) die "reading the git config of workspace failed (exit status $status)" ;;
  esac
}

# Whether the production database's container runs (compose labels its containers with the project).
database_runs() {
  [[ -n $(docker ps --quiet --filter label=com.docker.compose.project=claushh-prod --filter status=running 2>/dev/null) ]]
}

# The first AllowedHosts entry of the environment file: the Host header a local request must carry.
allowed_host() {
  local host
  # The file is root's and written for systemd and sh alike; AllowedHosts comes from it.
  # shellcheck source=/dev/null disable=SC2154
  host=$(. /etc/claushh/claushh.env && printf '%s' "${AllowedHosts:-}")
  host=${host%%;*}
  [[ -n $host && $host != *'<'* ]] \
    || die "set AllowedHosts in /etc/claushh/claushh.env (README.md, \"Deployment\", step 5)"
  printf '%s' "$host"
}

wait_for_health() {
  local host
  host=$(allowed_host)
  for _ in {1..60}; do
    if curl -fsS --max-time 2 -H "Host: $host" http://127.0.0.1:5090/api/health >/dev/null 2>&1; then
      printf 'install.sh: the API answers on 127.0.0.1:5090\n'
      return
    fi
    sleep 1
  done
  die "no answer from /api/health within 60 s: journalctl -u claushh; rollback: README.md, \"Deployment\""
}

install_build() {
  [[ $EUID -eq 0 ]] || die "install runs as root: sudo $0 install <dir>"
  local src part file
  src=$(realpath -- "$1")
  [[ -x $src/api/Claushh.Api && -f $src/web/index.html && -f $src/deploy/claushh.service ]] \
    || die "$src is not a build of 'install.sh build'"
  for file in /etc/claushh/compose.env /etc/claushh/claushh.env; do
    [[ $(stat -c '%U %a' -- "$file" 2>/dev/null) == 'root 600' ]] \
      || die "$file must exist, owned by root, with mode 600 (README.md, \"Deployment\", step 5)"
  done
  allowed_host >/dev/null
  id -u workspace >/dev/null 2>&1 || die "the user workspace does not exist (README.md, \"Deployment\", step 2)"
  [[ $(stat -c '%U' -- /srv/projects 2>/dev/null) == workspace ]] \
    || die "/srv/projects must exist and belong to workspace (README.md, \"Deployment\", step 4)"
  check_git_protocols
  # The copies are made while the API still runs, so a failed copy (a full disk) leaves it running.
  install -d -o root -g root -m 0755 "$prefix"
  for part in api web deploy; do
    rm -rf -- "${prefix:?}/$part.new"
    cp -a --no-preserve=ownership -- "$src/$part" "$prefix/$part.new"
    chmod -R a+rX,go-w -- "$prefix/$part.new"
  done
  if [[ -f /etc/systemd/system/claushh-backup.service ]] && database_runs; then
    printf 'install.sh: a dump before the update\n'
    systemctl start claushh-backup.service
  fi
  # Stopped whatever its state, so that an automatic restart cannot start the API in the middle of the swap.
  if [[ -f /etc/systemd/system/claushh.service ]]; then
    systemctl stop claushh.service
  fi
  for part in api web deploy; do
    if [[ -e $prefix/$part ]]; then
      rm -rf -- "${prefix:?}/$part.previous"
      mv -- "$prefix/$part" "$prefix/$part.previous"
    fi
    mv -- "$prefix/$part.new" "$prefix/$part"
  done
  for file in "${units[@]}"; do
    install -m 0644 -o root -g root -- "$prefix/deploy/$file" /etc/systemd/system/
  done
  systemctl daemon-reload
  if systemctl is-enabled --quiet claushh.service; then
    systemctl start claushh.service
    wait_for_health
  else
    printf 'install.sh: installed into %s; the API is not enabled and stays stopped (first install: README.md, "Deployment", step 7)\n' "$prefix"
  fi
}

case "${1:-}" in
  build)
    [[ $# -eq 2 ]] || usage
    build "$2"
    ;;
  install)
    [[ $# -eq 2 ]] || usage
    install_build "$2"
    ;;
  *) usage ;;
esac
