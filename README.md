# NodalAI

Local-first agent platform. Self-host with `npx nodalai`.

> **Migration en cours.** Ce repo remplace le legacy KwintAgents (Python+Next dual stack) par un monorepo all-Node. Plan de migration vivant : `~/.claude/plans/nodalai-migration-plan.md`.

## Quickstart (developer setup)

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

## Monorepo structure

- `apps/web` — Next.js dashboard (UI)
- `apps/runner` — Agent runtime (HTTP API, job execution, cron ticker)
- `apps/cli` — `npx nodalai` install + ops command
- `packages/db` — Drizzle schema + migrations + client (only place that imports postgres)
- `packages/shared` — Zod types and constants shared across web + runner
- `packages/llm` — Vercel AI SDK wrapper, multi-provider abstraction
- `packages/tools` — Tool registration + execution + approval gates
- `packages/memory` — Agent memory CRUD + embeddings
- `packages/orchestration` — Router + Planner patterns (delegation, task board)
- `packages/adapters/*` — Connectors: notion, drive, gmail, sheets, etc.
- `packages/delivery` — Telegram, email, future Slack/Discord
- `packages/auth` — Pluggable auth provider (local-trust default, better-auth opt-in, bearer-token for LAN)

## Architecture rules (enforced by `dependency-cruiser`)

- `apps/*` may import `packages/*`, never the reverse
- `apps/web` and `apps/runner` cannot import each other (DB or HTTP only)
- Only `packages/db` may import postgres clients (`pg`, `postgres`, `drizzle-orm`)
- `packages/adapters/*` may only import from `packages/tools` and `packages/shared`
- No circular dependencies

Run `pnpm deps:check` locally before pushing.

## Local install (end users)

> Not yet shipped — see migration plan.

When ready, `npx nodalai` will spin up the full platform locally with embedded Postgres and your local LLM (Ollama, LM Studio, llama.cpp, vLLM, custom OpenAI-compatible endpoint, or remote provider).

## Stack

- **Runtime:** Node 20+, TypeScript strict
- **Monorepo:** pnpm workspaces + Turborepo
- **DB:** embedded-postgres (local) / Neon or Render (cloud), Drizzle ORM, pgvector
- **Validation:** Zod
- **HTTP server:** Hono (runner)
- **LLM:** Vercel AI SDK
- **Auth:** none (local default) / better-auth (opt-in) / bearer token (LAN)
- **Tests:** Vitest (unit), Playwright (e2e), dependency-cruiser (architecture)

## License

TBD.
