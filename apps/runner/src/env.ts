// env.ts — Zod-validated environment for the runner
// All required and optional env vars are declared here.
// Import `env` from this file to get a fully-typed, validated env object.

import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),

  // LLM Provider — all optional since Brique 25.
  // The seeder uses these on first boot to populate entity_llm_keys; the runner
  // loop reads LLM config from DB at runtime (via agent.llmKeyId). Installs that
  // have removed the `llm` section from config.json omit these env vars entirely.
  LLM_PROVIDER: z
    .enum([
      'anthropic',
      'openai',
      'ollama',
      'openai-compatible',
      'google',
      'mistral',
      'groq',
      'openrouter',
      'deepseek',
      'minimax',
      'moonshot',
    ])
    .optional(),
  LLM_MODEL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),

  // Embeddings (optional — falls back to keyword search)
  EMBEDDING_PROVIDER: z.enum(['ollama', 'openai', 'keyword']).default('keyword'),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().optional(),

  // Auth
  AUTH_MODE: z.enum(['local-trust', 'local-auth', 'bearer-token']).default('local-trust'),
  WORKER_SECRET: z.string().default(''),

  // Bearer token mode (required when AUTH_MODE=bearer-token)
  BEARER_TOKEN: z.string().optional(),

  // Server
  PORT: z.coerce.number().default(3001),
  BIND: z.string().default('127.0.0.1'),
  APP_URL: z.string().default('http://localhost:3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Learning-loop — Tier-1 "reflection" pass (Phase B). After a substantial
  // completed job, a cheap LLM call reads the transcript and may create/patch
  // the agent's own skills.
  //
  // Kill-switch semantics (this env var is a GLOBAL kill, not an opt-in):
  //   REFLECTION_ENABLED='false'  → global kill: disables ALL reflection AND
  //                                  curator-consolidation for every entity.
  //   REFLECTION_ENABLED=''       → per-entity decides (production default when
  //       (unset)                    the var is absent from the environment).
  //   REFLECTION_ENABLED='true'   → per-entity decides (same as unset; accepted
  //                                  so existing test/docs that set 'true' pass).
  //
  // The feature ships OFF because entities.reflection_enabled defaults false.
  // Enable reflection per entity via the dashboard toggle — NOT via this env var.
  // The other knobs gate WHICH jobs qualify and bound the pass.
  REFLECTION_ENABLED: z.string().default(''),
  // Per-entity rolling-hour cap on reflection passes (rate limit / cost guard).
  REFLECTION_MAX_PER_HOUR: z.coerce.number().default(6),
  // Max LLM turns inside a single reflection pass (the reflection loop itself).
  REFLECTION_MAX_TURNS: z.coerce.number().default(3),
  // Complexity gate: min tool-call iterations in a completed job before it is
  // "substantial" enough to reflect on (replaces the old turn-count gate — a
  // cron/heartbeat run with few tool calls is not a learning opportunity).
  // Optional so existing RunnerEnv test fixtures need no change; the reflection
  // gate falls back to a constant when unset. ~10 (Hermes-like).
  REFLECTION_MIN_TOOL_ITERS: z.coerce.number().optional(),
  // Hard cap on NEW skills the reflection pass may create in a single run; excess
  // lessons are steered into patches of existing skills. Optional → constant fallback.
  REFLECTION_MAX_NEW_SKILLS_PER_PASS: z.coerce.number().optional(),

  // ─── Learning-loop — Tier-2 "curator" pass (Phase C). ────────────────────────
  // The deterministic lifecycle transitions (active→stale→archived) ALWAYS run
  // per cron tick (they are cheap SQL, no LLM). The LLM consolidation pass is
  // gated by the global kill-switch (REFLECTION_ENABLED !== 'false') AND by the
  // per-entity reflection_enabled=true flag (enforced via the candidate query join).
  // Ships OFF by default because entities.reflection_enabled defaults false.
  //
  // CURATOR_STALE_DAYS:      days before an agent skill transitions active→stale.
  // CURATOR_ARCHIVE_DAYS:    days before a stale agent skill transitions→archived.
  // CURATOR_MIN_SKILLS:      min agent-created ACTIVE skills per entity to trigger
  //                          LLM consolidation (consolidation is pointless below 5).
  // CURATOR_INTERVAL_DAYS:   min days between LLM consolidation passes per entity.
  // CURATOR_MAX_TURNS:       max LLM turns inside a single consolidation pass.
  CURATOR_STALE_DAYS: z.coerce.number().default(30),
  CURATOR_ARCHIVE_DAYS: z.coerce.number().default(90),
  CURATOR_MIN_SKILLS: z.coerce.number().default(5),
  CURATOR_INTERVAL_DAYS: z.coerce.number().default(7),
  CURATOR_MAX_TURNS: z.coerce.number().default(4),
  // ─── Memory curator (Tier-2, Brick 4) — same cadence/gating as skills ─────────
  // CURATOR_MEMORY_STALE_DAYS:     days before an agent-authored, NEVER-accessed,
  //   low-importance fact is auto-archived (Phase 1, deterministic, reversible).
  // CURATOR_MEMORY_IMPORTANCE_MAX: only facts at/below this importance are eligible
  //   for the usage-based Phase-1 archival (high-importance facts are kept).
  // CURATOR_MEMORY_MIN:            min non-archived facts per entity to trigger the
  //   LLM curation pass (Phase 2: distill blobs, merge duplicates).
  CURATOR_MEMORY_STALE_DAYS: z.coerce.number().default(60),
  CURATOR_MEMORY_IMPORTANCE_MAX: z.coerce.number().default(2),
  CURATOR_MEMORY_MIN: z.coerce.number().default(8),
  // Kill-switch semantics mirror REFLECTION_ENABLED but gate the MEMORY curator
  // (Phase 2 LLM pass) specifically — decoupled from the skill-learning loop:
  //   MEMORY_CURATION_ENABLED='false'  → global kill: disables memory curation
  //                                       for every entity.
  //   MEMORY_CURATION_ENABLED=''       → per-entity decides (production default
  //       (unset)                         when the var is absent). Since
  //                                       entities.memory_curation_enabled
  //                                       defaults TRUE, memory curation runs
  //                                       out of the box — unlike reflection.
  //   MEMORY_CURATION_ENABLED='true'   → per-entity decides (same as unset).
  MEMORY_CURATION_ENABLED: z.string().default(''),
  // Optional. When set, the reflection + curator passes use THIS model id instead of
  // the agent's model — resolved against the agent's existing LLM key (ideal for an
  // OpenRouter key where one key serves many models; point the cheap/reliable
  // housekeeping passes at a known-good model). Unset ⇒ inherit the agent's model
  // (current behavior).
  REFLECTION_MODEL: z.string().optional(),

  // ─── DB retention (OFF by default — opt-in, never surprise data loss) ─────────
  // RETENTION_DAYS controls how many days of terminal job history to keep.
  //   0 (default) = disabled — nothing is ever deleted automatically.
  //   N > 0       = agent_jobs rows with status ∈ {completed, failed, cancelled}
  //                 AND completed_at < now() - N days are pruned each cron tick.
  //                 tool_calls and approval_requests are deleted via ON DELETE CASCADE.
  //
  // Set this ONLY if you explicitly want to cap DB growth. Deleting job history is
  // irreversible. Start with a large value (e.g. 90) and reduce over time.
  RETENTION_DAYS: z.coerce.number().default(0),

  // ─── Approval grace window (Lot A1) ───────────────────────────────────────────
  // A gated tool normally suspends the job to `awaiting_approval` the instant it
  // fires — resuming later pays a full executeJob restart (~80-105s measured:
  // agent/skill/tool reload, thread history, system prompt). A human watching
  // the screen typically approves in 5-30s, so that whole restart is wasted. This
  // caps an in-process wait (poll approval_requests) BEFORE actually suspending:
  // if the decision lands inside the window, the runner executes it inline and
  // keeps looping — no suspend, no restart. 0 = disabled (suspend immediately,
  // the pre-existing behavior).
  NODALAI_APPROVAL_GRACE_MS: z.coerce.number().min(0).default(120_000),
});

export type RunnerEnv = z.infer<typeof envSchema>;

let _env: RunnerEnv | undefined;

/**
 * Parse and validate the environment.
 * Throws a descriptive error on first call if any required var is missing.
 * Results are cached after first parse.
 */
export function parseEnv(raw: Record<string, string | undefined> = process.env): RunnerEnv {
  if (_env) return _env;
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Runner env validation failed:\n${issues}`);
  }
  _env = result.data;
  return _env;
}

/** Reset cached env — only for tests. */
export function _resetEnvCache(): void {
  _env = undefined;
}

export const env = new Proxy({} as RunnerEnv, {
  get(_target, prop) {
    return parseEnv()[prop as keyof RunnerEnv];
  },
});
