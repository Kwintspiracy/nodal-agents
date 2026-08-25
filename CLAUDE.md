# Nodal-Agents — instructions for Claude Code

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

## Non-negotiable invariants

**How each is actually enforced** (CODE-001, audit 2026-08-07 — the audit first
claimed #1 and #2 were unenforced, having looked only for ESLint rules; they are
enforced, by tests. Stating the mechanism here so the next reader does not have
to rediscover it):

| Invariant | Enforced by |
|---|---|
| #1, #2, #6 | `architecture.test.ts` in **28 packages**, all calling the shared scanners in `@nodal-agents/test-kit`. `pnpm bench --section architecture` reports the counts and the number of packages covered |
| #10 (no native dialogs) | ESLint `no-restricted-globals` in `apps/web/eslint.config.mjs` |
| Layering (adapters, db driver) | dependency-cruiser, `pnpm deps:check` |
| #5 (tests assert real results) | review discipline — no mechanical check |
| #3, #4, #7, #8, #9 | review discipline, plus the targeted suites named in each rule |

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

- When Fable orchestrates the session, it delegates coding to Opus 5 and Sonnet 5 depending on task complexity.
- Never use Haiku.
- A brique or PR is merged only once PR review and the applicable test gates pass (unit + arch + regression always; integration/smoke when an external service is touched).

### Reviewing a PR — `codex review`, never a Claude subagent

**This rule exists because it was broken on 2026-08-25.** The review plan said
"external Codex for the P0s"; four Claude subagents were launched instead, over
several hours, silently burning the session's own quota. The findings were real,
but the argument for reviewing them — an outside pair of eyes — was not: two
instances of the same model share the same blind spots. The plan was written and
then forgotten by its own author, which is why the rule now lives here.

- **Reviewing a PR means running `codex review`.** Not the Agent tool. Not a
  subagent named after Codex. The command must appear in the tool calls.
- **Launching a Claude subagent to review a PR is FORBIDDEN.** No exception for
  "just a second opinion", "a quick pass", or "the diff is small".
- **The trigger is an OPEN PR, not the end of a session.** A review is due as
  soon as the PR exists, including mid-session and including a PR that is still
  being amended.
- **Loop** review → fix → review until Codex asks for no further change. A
  finding is closed by a test that fails first, and the fix is verified BY
  MUTATION (disable it, the test must go red).
- **If `codex` is missing or fails: say so and stop.** Never fall back to a
  Claude reviewer — that is a silent smart fallback (invariant #4), and it hides
  the fact that no independent review happened.

Claude subagents remain fine for anything that is NOT reviewing a PR: searching
the codebase, mapping an area, drafting, running suites.

## Commands

```bash
pnpm install      # one-time setup
pnpm --filter nodal-agents exec tsx src/index.ts --dev   # dev stack (embedded Postgres + runner + web HMR)
pnpm dev          # turbo dev — raw per-package watchers only, does NOT boot the full stack
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
