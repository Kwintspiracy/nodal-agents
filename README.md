# Nodal-Agents

Local-first AI agent platform. Self-host on Mac, PC, Linux, VPS, or NAS in 3 commands.

## Install in 30 seconds (Docker)

Works on any host with Docker — Mac, PC, Linux, VPS, Synology / Unraid / TrueNAS NAS, Raspberry Pi.

```bash
curl -O https://raw.githubusercontent.com/Kwintspiracy/nodal-agents/main/docker-compose.yml
docker compose up -d
```

Open <http://localhost:3000> — Nodal-Agents is running. Configure your LLM provider from **Settings → LLM keys** in the dashboard.

Data (config, postgres, logs) lives in the `nodal-data` Docker volume. To wipe everything: `docker compose down -v`.

The image is published to `ghcr.io/kwintspiracy/nodal-agents:latest` (multi-arch: amd64 + arm64). To pin a version, replace `latest` with a release tag (e.g. `v0.1.0`).

### Build the image locally

If you'd rather build from source instead of pulling the published image:

```bash
git clone https://github.com/Kwintspiracy/nodal-agents.git
cd nodal-agents
docker compose build
docker compose up -d
```

(Comment the `image:` line and uncomment `build: .` in `docker-compose.yml`.)

## Developer setup (monorepo)

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter nodal-agents dev   # CLI in tsx watch mode
```

## Monorepo structure

- `apps/web` — Next.js dashboard (UI)
- `apps/runner` — Agent runtime (HTTP API, job execution, cron ticker)
- `apps/cli` — `nodal-agents` install + ops command
- `packages/db` — Drizzle schema + migrations + client (only place that imports postgres)
- `packages/shared` — Zod types and constants shared across web + runner
- `packages/llm` — Vercel AI SDK wrapper, multi-provider abstraction
- `packages/tools` — Tool registration + execution + approval gates
- `packages/memory` — Agent memory CRUD + embeddings
- `packages/orchestration` — Router + Planner patterns (delegation, task board)
- `packages/runner-adapters` — Connectors: notion, drive, gmail, sheets, etc.
- `packages/delivery` — Telegram, email, future Slack/Discord
- `packages/auth` — Pluggable auth provider (local-trust default, better-auth opt-in, bearer-token for LAN)

## Architecture rules (enforced by `dependency-cruiser`)

- `apps/*` may import `packages/*`, never the reverse
- `apps/web` and `apps/runner` cannot import each other (DB or HTTP only)
- Only `packages/db` may import postgres clients (`pg`, `postgres`, `drizzle-orm`)
- `packages/runner-adapters/*` may only import from `packages/tools` and `packages/shared`
- No circular dependencies

Run `pnpm deps:check` locally before pushing.

## Stack

- **Runtime:** Node 22+, TypeScript strict
- **Monorepo:** pnpm workspaces + Turborepo
- **DB:** embedded-postgres (local + Docker), Drizzle ORM, pgvector
- **Validation:** Zod
- **HTTP server:** Hono (runner)
- **LLM:** Vercel AI SDK
- **Auth:** local-trust (single-user loopback) / local-auth (better-auth, multi-user LAN) / bearer-token
- **Tests:** Vitest (unit), Playwright (e2e), dependency-cruiser (architecture)

## License

TBD.
