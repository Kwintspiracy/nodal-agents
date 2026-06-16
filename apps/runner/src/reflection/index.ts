// reflection/index.ts — public entry point for the Tier-1 reflection pass.
//
// maybeRunReflection is the fire-and-forget hook wired into the job-completion
// paths in execute.ts. It applies ALL gates (fail-closed: any gate that does
// not pass returns silently without an LLM call) and, when every gate passes,
// reserves a per-entity throttle slot and runs the reflection pass.
//
// This pass is OFF by default because entities.reflection_enabled defaults false
// (enable per entity via the dashboard, not via env). REFLECTION_ENABLED='false'
// is the global kill-switch that disables ALL entities regardless of their flag.
// Must NEVER block or delay the job response — caller invokes with `void … .catch`.

import type { AnyDrizzleDb, AgentJobRow } from '@nodal-agents/db';
import { eq, entities } from '@nodal-agents/db';
import { env as globalEnv, type RunnerEnv } from '../env.ts';
import type { RunnerDeps } from '../deps.ts';
import { tryReserveReflectionSlot } from './throttle.ts';
import { runReflection } from './run-reflection.ts';

// `deps` is part of the public hook contract (execute.ts passes the runner's
// RunnerDeps) and reserved for future use — the reflection pass currently
// resolves everything it needs from `db`. Kept in the signature so the call site
// is stable if a later tier needs deps (e.g. the embedding client).

// Channels/surfaces that must NOT trigger reflection: 'chat' (interactive, not a
// task run) and 'reflection' (recursion guard — a reflection-originated job must
// never reflect on itself, even though no current code path creates one).
const EXCLUDED_CHANNELS: ReadonlySet<string> = new Set(['chat', 'reflection']);

// Fallbacks for the optional REFLECTION_MIN_TOOL_ITERS / REFLECTION_MAX_NEW_SKILLS_PER_PASS
// env knobs (kept optional so RunnerEnv test fixtures need no change).
const DEFAULT_MIN_TOOL_ITERS = 10;
const DEFAULT_MAX_NEW_SKILLS_PER_PASS = 2;

/**
 * Count tool-call iterations in a job transcript — the complexity signal that
 * gates reflection. A heartbeat/cron run with only a couple of tool calls is not
 * worth reflecting on, even if it spanned several LLM turns. Counts every
 * tool-call part across the persisted ModelMessage[] transcript.
 */
function countToolIterations(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if ((part as { type?: unknown }).type === 'tool-call') n += 1;
    }
  }
  return n;
}

/**
 * Run a reflection pass for a just-completed job IF it qualifies. All gates are
 * fail-closed: a job that does not pass every gate returns silently (no LLM
 * call, no DB write). Gates:
 *   - REFLECTION_ENABLED !== 'false'              (global kill-switch; OFF by default
 *                                                 because entities.reflection_enabled
 *                                                 defaults false — enable per entity
 *                                                 via the dashboard)
 *   - job.status === 'completed'                 (only successful runs)
 *   - job.channel ∉ {chat, reflection}           (no interactive / no recursion)
 *   - ≥ REFLECTION_MIN_TOOL_ITERS tool calls     (substantial job — complexity gate)
 *   - per-entity throttle slot available         (≤ REFLECTION_MAX_PER_HOUR/h)
 *
 * Reads config from `runnerEnv` when provided (used by tests and recursive job
 * calls that already have a validated env), or falls back to the module-level
 * `env` proxy (process.env) for production use.
 */
export async function maybeRunReflection(
  _deps: RunnerDeps,
  db: AnyDrizzleDb,
  job: AgentJobRow,
  runnerEnv?: RunnerEnv,
): Promise<void> {
  // Resolve env: prefer the caller-provided instance (avoids a fresh parseEnv()
  // call in tests that supply a testEnv but haven't set process.env).
  const e = runnerEnv ?? globalEnv;

  // Gate 1a — global kill-switch: explicit 'false' disables every entity regardless of per-entity flag.
  if (e.REFLECTION_ENABLED === 'false') return;

  // Gate 2 — only completed jobs.
  if (job.status !== 'completed') return;

  // Gate 3 — no recursion, no interactive chat.
  const channel = job.channel ?? '';
  if (EXCLUDED_CHANNELS.has(channel)) return;

  // Gate 4 — substantial job: the agent did real tool work. We count tool-call
  // iterations in the transcript (a complexity gate, like Hermes' ≥N tool-iters)
  // rather than LLM turns — a short cron/heartbeat run with few tool calls is not
  // a learning opportunity, even if it took several turns.
  if (countToolIterations(job.messages) < (e.REFLECTION_MIN_TOOL_ITERS ?? DEFAULT_MIN_TOOL_ITERS))
    return;

  // Gate 5 — must have a valid owner to scope the pass to.
  if (!job.entityId || !job.agentId) return;

  // Gate 5b — per-entity opt-in flag: skip if the entity hasn't enabled reflection.
  const [entityRow] = await db
    .select({ reflectionEnabled: entities.reflectionEnabled })
    .from(entities)
    .where(eq(entities.id, job.entityId))
    .limit(1);
  if (!entityRow?.reflectionEnabled) return;

  // Gate 6 — per-entity rolling-hour throttle. Check-and-reserve in one step so
  // back-to-back completions can't slip past the cap.
  if (!tryReserveReflectionSlot(job.entityId, e.REFLECTION_MAX_PER_HOUR)) return;

  // Observability: all gates passed AND a throttle slot was reserved — the pass
  // is eligible and about to run. Visible even if runReflection later no-ops or
  // errors (gate-blocked jobs stay silent by design).
  console.warn('[reflection] eligible', { jobId: job.id, entityId: job.entityId });

  await runReflection(
    db,
    job,
    e.REFLECTION_MAX_TURNS,
    e.REFLECTION_MAX_NEW_SKILLS_PER_PASS ?? DEFAULT_MAX_NEW_SKILLS_PER_PASS,
    e.REFLECTION_MODEL,
  );
}
