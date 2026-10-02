#!/usr/bin/env sh
set -eu
# Intentionally requires an explicitly named, empty restore target.
: "${PGDATABASE:?Set PGDATABASE to an empty restore database}"
: "${1:?Usage: scripts/restore.sh /path/to/dolphino.dump}"
restore_confirmation="${DOLPHINO_RESTORE_CONFIRM:-}"
if [ "$restore_confirmation" != "$PGDATABASE" ]; then
  printf 'Set DOLPHINO_RESTORE_CONFIRM to the target PGDATABASE (%s). Restore into a NEW empty database.\n' "$PGDATABASE" >&2
  exit 1
fi
pg_restore --single-transaction --exit-on-error --no-owner --no-acl --dbname="$PGDATABASE" "$1"
printf 'Restored to %s. Verify totals and settings before switching the app.\n' "$PGDATABASE"
