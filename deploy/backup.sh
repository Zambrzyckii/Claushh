#!/usr/bin/env bash
# Dumps the production database and restores a dump (docs/PLAN.md, "Deployment decisions"). Runs as root: daily from
# claushh-backup.service (its timer) and by hand.
#   backup.sh                         a dump into /var/backups/claushh; dumps 14 or more days old are deleted
#   backup.sh restore <file>          the dump in place of the live database, which stays as before_restore_<time>
#                                     (the API must be stopped)
#   backup.sh restore <file> <name>   the dump into a new database <name>, to check that it loads
set -euo pipefail
umask 077

readonly backups=/var/backups/claushh
readonly -a compose=(docker compose -p claushh-prod -f /opt/claushh/deploy/docker-compose.yml
  --env-file /etc/claushh/compose.env)
part=""

die() {
  printf 'backup.sh: %s\n' "$*" >&2
  exit 1
}

# A dump that failed leaves no file behind.
remove_part() {
  if [[ -n $part ]]; then
    rm -f -- "$part"
  fi
}

dump() {
  local name
  install -d -m 0700 -- "$backups"
  name="$backups/claushh-$(date -u +%Y%m%dT%H%M%SZ).dump"
  part="$name.part"
  trap remove_part EXIT
  # POSTGRES_USER and POSTGRES_DB are expanded by the container's shell, from the container's environment.
  # shellcheck disable=SC2016
  "${compose[@]}" exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' >"$part"
  mv -- "$part" "$name"
  part=""
  # -mtime +13: modified 14 or more days ago; a .part that a killed dump left is deleted once it is a day old.
  find "$backups" -maxdepth 1 -type f \( -name 'claushh-*.dump' -mtime +13 -o -name 'claushh-*.dump.part' -mtime +0 \) -delete
  printf 'backup.sh: %s\n' "$name"
}

# Loads a dump into a new database, in one transaction.
load() {
  local file=$1 database=$2
  # The name goes to the container's shell as $1, never inside the command text.
  # shellcheck disable=SC2016
  "${compose[@]}" exec -T postgres sh -c 'exec createdb -U "$POSTGRES_USER" "$1"' sh "$database"
  # shellcheck disable=SC2016
  "${compose[@]}" exec -T postgres sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$1" --single-transaction' \
    sh "$database" <"$file"
}

restore() {
  local file=$1 database=$2 stamp
  [[ -f $file ]] || die "no such dump: $file"
  if [[ -n $database ]]; then
    [[ $database =~ ^[a-z_][a-z0-9_]*$ ]] || die "a database name has lower-case letters, digits and _ only"
    load "$file" "$database"
    printf 'backup.sh: restored %s into the database %s\n' "$file" "$database"
    return
  fi
  # Only with the API stopped: not while it runs, and not while systemd is about to start it again (activating).
  case $(systemctl show --property=ActiveState --value claushh.service) in
    inactive | failed) ;;
    *) die "the API is not stopped: sudo systemctl stop claushh first" ;;
  esac
  # The dump loads into a new database, which only then takes the live database's name; the live database stays as
  # before_restore_<time>. So the tables of a newer migration can neither block the restore nor survive it.
  stamp=$(date -u +%Y%m%d%H%M%S)
  load "$file" "restore_$stamp"
  # psql variables: live is the container's POSTGRES_DB; both renames happen in one transaction, or neither.
  # shellcheck disable=SC2016
  "${compose[@]}" exec -T postgres sh -c \
    'exec psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -v live="$POSTGRES_DB" -v new="$1" -v old="$2"' \
    sh "restore_$stamp" "before_restore_$stamp" <<'SQL'
BEGIN;
ALTER DATABASE :"live" RENAME TO :"old";
ALTER DATABASE :"new" RENAME TO :"live";
COMMIT;
SQL
  printf 'backup.sh: restored %s; the replaced database stays as before_restore_%s\n' "$file" "$stamp"
}

[[ $EUID -eq 0 ]] || die "run as root"
case "${1:-dump}" in
  dump)
    [[ $# -le 1 ]] || die "usage: backup.sh [dump] | backup.sh restore <file> [database]"
    dump
    ;;
  restore)
    [[ $# -eq 2 || $# -eq 3 ]] || die "usage: backup.sh restore <file> [database]"
    restore "$2" "${3:-}"
    ;;
  *) die "usage: backup.sh [dump] | backup.sh restore <file> [database]" ;;
esac
