# ADR-0001: Migration foundations

**Status:** Accepted
**Date:** 2026-04-26

## Context

KwintAgents (legacy at `D:\APPS\KwintAgents/`) is a Python (AgentOne) + Next.js (dashboard) dual-stack platform deployed across Fly + Vercel + Supabase. We're migrating to a single all-Node monorepo (NodalAI) with embedded Postgres and a local-first install model — see `~/.claude/plans/nodalai-migration-plan.md` for the full plan.

## Decision

Adopt the following foundation stack for the new monorepo:

| Concern | Choice |
|---|---|
| Runtime | Node 20+ / TypeScript strict |
| Monorepo | pnpm workspaces + Turborepo |
| ORM | Drizzle |
| Validation | Zod |
| Test runner | Vitest |
| E2E | Playwright |
| Architecture tests | dependency-cruiser + custom ESLint rules |
| HTTP server (runner) | Hono |
| LLM client | Vercel AI SDK (multi-provider) |
| Auth | none in local mode (default), better-auth opt-in for dashboard, bearer token for LAN |
| DB local | embedded-postgres + pgvector |
| DB cloud (future) | Neon or Render Postgres |
| Storage | filesystem local, S3-compatible cloud |

## Rationale

Key drivers:
- **Portability** — drop Supabase lock-in (auth + DB + PostgREST). Drizzle works with any Postgres.
- **Simplicity** — one runtime (Node) instead of two. Types shared end-to-end.
- **Local-first** — match Hermes / Paperclip install simplicity (`npx nodalai`). Zero external dependency required at boot.
- **Provider-agnostic LLM** — Vercel AI SDK abstracts Anthropic / OpenAI / Ollama / LM Studio / etc. so users can run fully local.

## Consequences

- Schema must be portable (works on `embedded-postgres` locally and managed Postgres in cloud).
- LLM features must work across providers — orchestration depends only on the universal subset (tool use). Optimizations like prompt caching are opportunistic per-provider.
- No PostgREST: direct Drizzle queries from both `apps/web` (Server Actions) and `apps/runner` (Hono handlers).
- Auth complexity isolated to `packages/auth` with three pluggable providers (`local-trust`, `local-auth` via better-auth, `bearer-token`).

## Out of scope (this ADR)

- Specific implementation patterns per brique — see plan file and per-brique ADRs (ADR-0002+).
- Cloud auth provider choice — deferred until cloud SaaS ships.
