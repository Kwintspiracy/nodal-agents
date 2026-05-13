#!/bin/sh
# docker-entrypoint.sh — boot script for the Nodal-Agents container.
#
# Responsibilities:
#   1. Ensure /data exists with the right structure
#   2. Run a non-interactive init on first boot (no config.json yet)
#   3. Hand off to `nodal-agents up`
#
# Volume mount at /data persists config + postgres data + logs across
# container restarts. ~/.nodalai symlinks to /data via the Dockerfile,
# so the CLI reads/writes through the volume transparently.

set -e

mkdir -p /data

# Postgres refuses to run as root, so embedded-postgres spins up a
# dedicated `postgres` system user. That user needs to traverse /root
# (where ~/.nodalai is symlinked) and write inside /data — neither is
# guaranteed under the default 0700 perms. Make both world-readable
# and the data dir world-writable so the postgres subprocess can
# initdb/start.
chmod 755 /root
chmod -R 777 /data

# tsx runs the CLI from TypeScript source. We could ship the tsup-bundled
# `dist/index.js`, but the workspace packages it imports use extension-less
# relative imports (Turbopack/Bundler resolution, not Node ESM resolution),
# so Node can't load them directly. tsx handles this transparently via
# its loader, and it's already installed via pnpm so no extra cost.
TSX=/app/apps/cli/node_modules/.bin/tsx
CLI=/app/apps/cli/src/index.ts

# First-boot guard: write a default config so the CLI doesn't try to
# prompt for LLM settings on stdin (no TTY in a container).
if [ ! -f /data/config.json ]; then
  echo ">>> First boot — writing default config"
  "$TSX" "$CLI" init --non-interactive
fi

exec "$TSX" "$CLI" up
