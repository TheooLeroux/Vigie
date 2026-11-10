#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  17|18) version=$1 ;;
  *) printf '%s\n' 'Version du client PostgreSQL de sauvegarde invalide.' >&2; exit 1 ;;
esac

package="postgresql-client-$version"
bin="/usr/lib/postgresql/$version/bin"
if [[ ! -x "$bin/pg_dump" || ! -x "$bin/pg_restore" ]]; then
  if ! apt-cache show "$package" >/dev/null 2>&1; then
    sudo install -d /usr/share/postgresql-common/pgdg
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo tee /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc >/dev/null
    printf '%s\n' 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' | sudo tee /etc/apt/sources.list.d/vigie-pgdg.list >/dev/null
    sudo apt-get update -qq
  fi
  sudo apt-get install -y --no-install-recommends "$package"
fi
printf '%s\n' "$bin" >> "$GITHUB_PATH"
