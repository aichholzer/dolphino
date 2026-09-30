#!/usr/bin/env sh
set -eu
# Use PGHOST/PGPORT/PGUSER/PGDATABASE and .pgpass; do not put passwords in arguments.
# Requires PostgreSQL client tools. Use pg_dump >= the server major version.
: "${PGDATABASE:?Set PGDATABASE}"
backup_dir="${1:-./backups}"
umask 077
mkdir -p "$backup_dir"
backup_file="$backup_dir/profe-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-acl --file="$backup_file"
printf 'Backup written to %s\n' "$backup_file"
