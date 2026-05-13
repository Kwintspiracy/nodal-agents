# syntax=docker/dockerfile:1.7
# ─── Builder stage ────────────────────────────────────────────────────────────
# Installs the full monorepo deps, runs the build orchestrator
# (scripts/build-pack.mjs), and exposes /src/pack as the assembled
# distributable. Only /src/pack/ leaves this stage — the runtime image
# never sees the workspace source, devDeps, .next/cache, or test fixtures.
FROM node:22-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_OPTIONS=--max-old-space-size=4096

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /src

COPY . .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

RUN node scripts/build-pack.mjs

# ─── Runtime stage ────────────────────────────────────────────────────────────
# Receives only /src/pack/ from the builder, then installs the pack's
# `dependencies` (the same set npm publishes to consumers). End result is
# a minimal image: node:22-slim base + npm install of runtime externals +
# 30 MB of bundled code. embedded-postgres downloads the postgres binary
# via its optionalDependency for the current arch during `npm install`.
FROM node:22-slim AS runtime

# tini handles PID 1 signal forwarding so `docker stop` reaches children.
# ca-certificates is needed for TLS to LLM providers, GitHub, etc.
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /src/pack /app
# docker-entrypoint.sh is Docker-only (not part of the npm package).
# Copy directly from the build context so it lives next to cli.js.
COPY --from=builder /src/scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Install the pack's runtime dependencies, then immediately purge the
# npm download cache and the bundled yarn install — neither is used at
# runtime and together they would otherwise leave ~800 MB of dead weight
# in the image. --omit=dev skips devDependencies, --no-audit / --no-fund
# silence noise during the non-interactive build.
RUN npm install --omit=dev --no-audit --no-fund && \
    npm cache clean --force && \
    rm -rf /root/.npm /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Persist data at /data. CONFIG_DIR resolves to $HOME/.nodalai;
# symlink to /data so a docker volume mount captures config + pg-data +
# logs + pids transparently.
ENV HOME=/root
RUN mkdir -p /data && ln -sf /data /root/.nodalai

ENV NODALAI_NO_BROWSER=1
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
