# syntax=docker/dockerfile:1.7
# ─── Builder stage ────────────────────────────────────────────────────────────
# Single-stage with full install + build. Simpler than the lockfile-only
# pre-copy pattern and tolerant to new workspace packages being added.
FROM node:22-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

COPY . .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

RUN pnpm --filter @nodal-agents/web build && \
    pnpm --filter nodal-agents build

# ─── Runtime stage ────────────────────────────────────────────────────────────
# Slim image with full monorepo + node_modules (devDeps included — tsx runs
# the runner directly from source, no separate runner build step yet).
FROM node:22-slim AS runtime

# embedded-postgres extracts a Postgres binary at runtime; it needs the
# standard libc + a few utils for the wrapper scripts. node:22-slim has
# them out of the box. tini handles PID 1 signal forwarding so Ctrl+C /
# docker stop terminate children cleanly.
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

COPY --from=builder /app /app

# Persist data dir at /data so docker-compose can mount a named volume here.
# CLI's CONFIG_DIR resolves to $HOME/.nodalai; symlink to /data so volume
# mount captures everything (config, pg-data, logs, pids).
ENV HOME=/root
RUN mkdir -p /data && ln -sf /data /root/.nodalai

ENV NODALAI_NO_BROWSER=1
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
