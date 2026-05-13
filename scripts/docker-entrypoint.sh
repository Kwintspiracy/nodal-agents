#!/bin/sh
# docker-entrypoint.sh — boot script for the slim Nodal-Agents container.
#
# Postgres refuses to run as root; embedded-postgres creates a dedicated
# `postgres` system user for that subprocess. We chmod /data so both the
# root-owned CLI and the postgres user can read/write it.

set -e

mkdir -p /data
chmod 755 /root
chmod -R 777 /data

# First boot: write a default config. /data/config.json is the symlink
# target via /root/.nodalai → /data, so creating the file here surfaces
# at the path the CLI expects.
if [ ! -f /data/config.json ]; then
  echo ">>> First boot — writing default config"
  node /app/cli.js init --non-interactive
fi

exec node /app/cli.js up
