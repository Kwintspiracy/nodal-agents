# Nodal-Agents — instructions for Codex

This is the all-Node monorepo replacing the legacy KwintAgents (Python+Next dual-stack).

## Architecture

- pnpm workspaces + Turborepo
- TypeScript strict (no `any`, no `// @ts-ignore` without comment)
- Drizzle ORM (only `packages/db` imports `pg` / `postgres` / `drizzle-orm`)
- Zod for validation everywhere
- Vercel AI SDK for LLM (multi-provider abstraction)
- Hono for HTTP server (runner)
- Vitest for unit tests, Playwright for e2e, dependency-cruiser for architecture
- Better-auth for opt-in dashboard auth (local mode = no auth by default)

## Non-negotiable invariants (enforced by CI)

1. **No hardcoded agent metadata.** Skills, routing, team blocks, sub-agent descriptions: 100% from DB.
2. **No hardcoded user-facing text in runner.** LLM speaks or runner stays silent.
3. **No agent-specific band-aids in runner.** Fix at agent layer (DB), never patch the runtime.
4. **No silent smart fallbacks.** Fail loud with clear error.
5. **Tests assert real results** — body of LLM request, DB row, tool_result content. Never just call counts.
6. **No per-user hardcoded values** — IDs / URLs / tokens via memory or user config.
7. **Always use official SDKs** when available (`@anthropic-ai/sdk`, `googleapis`, `@notionhq/client`, etc.).
8. **Anti-loop guards baked in** (max 15 chains, max 50 tool calls/turn, max 3 delegation depth). Raised from the original 5 on 2026-05-19 (`packages/orchestration/src/chain-counters.ts`) once sequential-delegation workflows needed more resumes than a runaway-detection cap calibrated without empirical data allowed; the `failed_delegations_count` cap and `maxDelegationDepth` guards absorbed the actual runaway risk, so `chain_count` could safely become a resume budget instead.
9. **Tool whitelist explicit per agent** — no defaults, list calculated from DB per job.
10. **No native browser dialogs** — `window.confirm` / `window.alert` / `window.prompt` are banned. Use `<ConfirmDialog />` (`apps/web/src/components/ConfirmDialog.tsx`) for confirmations and the Sonner toaster for notifications. Enforced by ESLint `no-restricted-globals` in `apps/web/eslint.config.mjs`.

## Workflow rules

- Opus 4.8 orchestrates and reviews; Sonnet 5 codes/tests; Haiku banned.
- Max 5 concurrent agents.
- Each brique merged only when its applicable test gates pass (unit + arch + regression always; integration/smoke when external service touched).
- Plan file at `~/.Codex/plans/nodalai-migration-plan.md` is the source of truth — update `[ ]` checkboxes as work progresses.

## Commands

```bash
pnpm install      # one-time setup
pnpm dev          # dev mode (turbo)
pnpm build        # production build
pnpm test         # vitest across all packages
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint flat config
pnpm format       # prettier --write
pnpm format:check # prettier --check
pnpm deps:check   # dependency-cruiser
```

## Tests gates per brique

1. **Unit** — fonctions pures, mocks aux frontières. Assertions sur le résultat réel, pas sur les call counts.
2. **Architecture** — dep-cruiser + ESLint custom rules (invariants 1-2 enforced).
3. **Regression** — un test par comportement legacy préservé. Écrit AVANT le port.
4. **Integration / smoke** — uniquement pour briques touchant un service externe (LLM, DB, API tierce).

## Legacy reference

The KwintAgents legacy code lives at `D:\APPS\KwintAgents/` — read-only reference during migration. Each brique in the plan file lists which legacy files to port from.
