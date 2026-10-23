#!/bin/sh
set -eu

/usr/local/bin/sync-static.sh
exec /docker-entrypoint.sh "$@"
