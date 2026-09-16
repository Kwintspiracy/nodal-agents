/**
 * Which memory rows an e2e journey is allowed to delete.
 *
 * Why this file exists (review of PR #113, second pass): `memory-kept.spec.ts`
 * wrote rows carrying a marker and deleted them in `afterAll`. A run killed
 * before `afterAll` — Ctrl+C, a timeout, a runner that dies — left them in the
 * database forever, and the next run had no guard: nothing looked, nothing
 * said, and the Memory page slowly filled with facts about a clarinet.
 *
 * The convention is the one PR #118 introduced for credentials, deliberately
 * not a second one: a marker that names THIS run, read only as an exact suffix,
 * and `NODALAI_E2E_SWEEP_STALE=1` to claim what another run left behind. What
 * follows applies it to `agent_memory`. The day #118 lands, the run id and the
 * marker shape belong in one shared module; the two files already agree on
 * both, so that merge is a move, not a decision.
 *
 * Three things it refuses to do, each for a reason:
 *
 *  - delete a row with NO marker. That is a fact a human taught an agent, and
 *    an e2e journey has no business touching it;
 *  - delete a row belonging to ANOTHER run. It may be running right now, on
 *    the same database, and deleting its rows would cut the ground from under
 *    it. It is named, and left alone, unless sweeping is asked for;
 *  - delete across entities. Every query here is scoped to one entity, so a
 *    marker collision on a shared stack still cannot reach another tenant.
 *
 * The functions take the `db` they act on, so they are unit-testable:
 * `helpers.ts` imports `@playwright/test` at load time and nothing in it can
 * be. `apps/web/tests/e2e-memory-cleanup.test.ts` runs them against a real
 * Postgres (pglite) — the decision AND the DELETE it produces.
 */

import { randomBytes } from 'node:crypto';
import { agentMemory, eq, and, inArray, type AnyDrizzleDb } from '@nodal-agents/db';

/** Opens the marker that makes an e2e-created memory recognisable. */
export const E2E_MEMORY_MARKER_OPEN = '[nodalai-e2e-memory:';
/** Closes it — and must be the last character of the fact. */
export const E2E_MEMORY_MARKER_CLOSE = ']';

/** A run id is short, lowercase and alphanumeric — nothing else parses as one. */
const RUN_ID_SHAPE = /^[a-z0-9]{6,32}$/;

function resolveRunId(fromEnv: string | undefined): string {
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!RUN_ID_SHAPE.test(fromEnv)) {
      throw new Error(
        `e2e: NODALAI_E2E_RUN_ID="${fromEnv}" is not a run id (expected 6-32 chars, a-z0-9). ` +
          'Cleanup matches this value literally in memory facts — refusing to guess.',
      );
    }
    return fromEnv;
  }
  return randomBytes(6).toString('hex');
}

/**
 * The id of THIS run. Random per process, so two runs sharing a database never
 * claim each other's rows. `NODALAI_E2E_RUN_ID` overrides it — the same
 * variable credential cleanup reads, on purpose: one run, one identity.
 */
export const E2E_MEMORY_RUN_ID: string = resolveRunId(process.env['NODALAI_E2E_RUN_ID']);

/** The marker a given run writes at the very end of the facts it creates. */
export function e2eMemoryMarker(runId: string = E2E_MEMORY_RUN_ID): string {
  return `${E2E_MEMORY_MARKER_OPEN}${runId}${E2E_MEMORY_MARKER_CLOSE}`;
}

/** The fact to type in the New Memory modal so cleanup can recognise the row. */
export function e2eMemoryFact(text: string, runId: string = E2E_MEMORY_RUN_ID): string {
  return `${text} ${e2eMemoryMarker(runId)}`;
}

/**
 * The run that created this fact, or `null` when no run did.
 *
 * The marker is read in ONE position only: closing the fact, opened once. A
 * fact carrying it anywhere else — a human pasting it in, a fact built by
 * concatenating two marked ones — reads as `null`, i.e. as something a human
 * taught. Refusing to delete is the safe side of that doubt.
 */
export function e2eMemoryRunIdOf(fact: string): string | null {
  if (!fact.endsWith(E2E_MEMORY_MARKER_CLOSE)) return null;
  const open = fact.indexOf(E2E_MEMORY_MARKER_OPEN);
  if (open < 0) return null;
  const runId = fact.slice(
    open + E2E_MEMORY_MARKER_OPEN.length,
    fact.length - E2E_MEMORY_MARKER_CLOSE.length,
  );
  return RUN_ID_SHAPE.test(runId) ? runId : null;
}

export type MemoryForCleanup = { id: string; fact: string };

export type MemoryCleanupPlan = {
  /** Rows to delete: this run's rows, plus other runs' under `sweepStaleRuns`. */
  deleteIds: string[];
  /** Rows no e2e run made. Never deleted here, whatever the options. */
  blocked: MemoryForCleanup[];
  /** Rows another e2e run owns. Left alone unless `sweepStaleRuns`. */
  foreign: MemoryForCleanup[];
};

export type MemoryCleanupOptions = {
  /** The run claiming its rows. Defaults to this process's id. */
  runId?: string;
  /** NODALAI_E2E_SWEEP_STALE=1 — also delete what other e2e runs left behind. */
  sweepStaleRuns?: boolean;
};

/** Reads the one escape hatch from the environment, and nothing else. */
export function memoryCleanupOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  sweepStaleRuns: boolean;
} {
  return { sweepStaleRuns: env['NODALAI_E2E_SWEEP_STALE'] === '1' };
}

/**
 * Decide what a memory cleanup may delete.
 *
 * There is no `allowWipe` counterpart to the credential version, and that is
 * deliberate: a credential cleanup sometimes has to start from an empty slate,
 * a memory journey never does. An unmarked fact is simply never deletable from
 * here.
 */
export function planMemoryCleanup(
  rows: readonly MemoryForCleanup[],
  opts: MemoryCleanupOptions = {},
): MemoryCleanupPlan {
  const runId = opts.runId ?? E2E_MEMORY_RUN_ID;
  const deleteIds: string[] = [];
  const blocked: MemoryForCleanup[] = [];
  const foreign: MemoryForCleanup[] = [];
  for (const row of rows) {
    const owner = e2eMemoryRunIdOf(row.fact);
    if (owner === runId) deleteIds.push(row.id);
    else if (owner === null) blocked.push(row);
    else if (opts.sweepStaleRuns === true) deleteIds.push(row.id);
    else foreign.push(row);
  }
  return { deleteIds, blocked, foreign };
}

/** The warning shown when another run's leftovers stay in the way. */
export function staleMemoriesMessage(foreign: readonly MemoryForCleanup[]): string {
  return (
    `e2e : ${foreign.length} souvenir(s) appartiennent à un autre run e2e ` +
    `(${foreign.map((r) => r.fact).join(' · ')}) et sont laissés en place. Si ce run est ` +
    'terminé ou interrompu, relancer avec NODALAI_E2E_SWEEP_STALE=1 pour les effacer.'
  );
}

/** Every memory of one entity that carries SOME e2e marker, id and fact only. */
export async function selectE2EMemories(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<MemoryForCleanup[]> {
  const rows = (await db
    .select({ id: agentMemory.id, fact: agentMemory.fact })
    .from(agentMemory)
    .where(eq(agentMemory.entityId, entityId))) as MemoryForCleanup[];
  return rows.filter((r) => e2eMemoryRunIdOf(r.fact) !== null);
}

/**
 * Delete exactly the rows the plan named — never "every marked row of this
 * entity", which is what the `where` degrades into the day someone drops the
 * `inArray`. The entity stays in the clause as a second lock.
 */
export async function applyMemoryCleanup(
  db: AnyDrizzleDb,
  entityId: string,
  plan: MemoryCleanupPlan,
): Promise<number> {
  if (plan.deleteIds.length === 0) return 0;
  await db
    .delete(agentMemory)
    .where(and(eq(agentMemory.entityId, entityId), inArray(agentMemory.id, plan.deleteIds)));
  return plan.deleteIds.length;
}
