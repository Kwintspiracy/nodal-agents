/**
 * Which credentials an e2e journey is allowed to delete.
 *
 * Why this file exists (nightly of 2026-09-15, run 34948237666): two Google
 * journeys — `help-guides.spec.ts` and `oauth-flow.spec.ts` — went red while
 * the product was fine. `credentials-reuse.spec.ts` had run first and left a
 * `google-oauth` credential behind; the `beforeAll` guard then refused to wipe
 * it, because nothing in the database told a journey-created credential apart
 * from an account a human connected by hand. The journeys were not independent
 * of their order.
 *
 * The fix is a marker, not a guess. Every credential an e2e journey creates is
 * named through `e2eCredentialName()`, which appends `[nodalai-e2e:<runId>]`.
 * Cleanup deletes rows carrying THIS run's marker and NEVER touches a row
 * without a marker: a developer's real Google account keeps the same
 * protection it had, and the journeys stop tripping over each other.
 *
 * Two things the first version got wrong (review of PR #118, 2026-09-16):
 *
 *  - the marker said "made by an e2e journey", not "made by THIS run". Two
 *    runs sharing one database (`NODALAI_E2E_DB_URL` from two machines, or
 *    `workers > 1`) deleted each other's rows mid-journey. The marker now
 *    carries a per-process run id, and rows of ANOTHER run are left alone.
 *    Sweeping what an interrupted run left behind is still possible, but it is
 *    asked for explicitly (`sweepStaleRuns`, from `NODALAI_E2E_SWEEP_STALE=1`)
 *    — never implied;
 *  - the marker was matched with `includes()`, so a human who typed
 *    `[nodalai-e2e:...]` anywhere in "Display name" got their credential
 *    deleted. The marker is now only read as an EXACT SUFFIX, appearing once;
 *    a name carrying it anywhere else is `blocked`, like any hand-typed name.
 *
 * The database wiring lives here too, and not in `helpers.ts`, for one reason:
 * `helpers.ts` imports `@playwright/test` at load time, so nothing in it can
 * be unit-tested. These functions take the `db` they act on, and the tests in
 * `apps/web/tests/e2e-credential-cleanup.test.ts` run them against a real
 * Postgres (pglite) — the decision AND the DELETE it produces.
 */

import { randomBytes } from 'node:crypto';
import { credentials, eq, and, inArray, type AnyDrizzleDb } from '@nodal-agents/db';
import type { CredentialType } from '@nodal-agents/shared';

/** Opens the marker that makes an e2e-created credential recognisable. */
export const E2E_CREDENTIAL_MARKER_OPEN = '[nodalai-e2e:';
/** Closes it — and must be the last character of the credential's name. */
export const E2E_CREDENTIAL_MARKER_CLOSE = ']';

/** A run id is short, lowercase and alphanumeric — nothing else parses as one. */
const RUN_ID_SHAPE = /^[a-z0-9]{6,32}$/;

function resolveRunId(fromEnv: string | undefined): string {
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!RUN_ID_SHAPE.test(fromEnv)) {
      throw new Error(
        `e2e: NODALAI_E2E_RUN_ID="${fromEnv}" is not a run id (expected 6-32 chars, a-z0-9). ` +
          'Cleanup matches this value literally in credential names — refusing to guess.',
      );
    }
    return fromEnv;
  }
  return randomBytes(6).toString('hex');
}

/**
 * The id of THIS run. Random per process, so two runs sharing a database never
 * claim each other's rows. `NODALAI_E2E_RUN_ID` overrides it when an operator
 * wants several Playwright workers to share one identity on purpose.
 */
export const E2E_RUN_ID: string = resolveRunId(process.env['NODALAI_E2E_RUN_ID']);

/** The marker a given run writes at the very end of the names it creates. */
export function e2eCredentialMarker(runId: string = E2E_RUN_ID): string {
  return `${E2E_CREDENTIAL_MARKER_OPEN}${runId}${E2E_CREDENTIAL_MARKER_CLOSE}`;
}

/** Name to type in the credential wizard so cleanup can recognise the row. */
export function e2eCredentialName(label: string, runId: string = E2E_RUN_ID): string {
  return `${label} ${e2eCredentialMarker(runId)}`;
}

/**
 * The run that created this credential, or `null` when no run did.
 *
 * The marker is only read in ONE position: closing the name, opened once. A
 * name that carries it anywhere else — a human pasting it into "Display name",
 * a name built by concatenating two marked names — reads as `null`, i.e. as a
 * credential a human owns. Refusing to delete is the safe side of that doubt.
 */
export function e2eRunIdOf(name: string): string | null {
  if (!name.endsWith(E2E_CREDENTIAL_MARKER_CLOSE)) return null;
  // The FIRST opening on purpose: a name carrying the marker twice, or carrying
  // it before its end, then reads as a run id full of junk and is refused.
  const open = name.indexOf(E2E_CREDENTIAL_MARKER_OPEN);
  if (open < 0) return null;
  const runId = name.slice(
    open + E2E_CREDENTIAL_MARKER_OPEN.length,
    name.length - E2E_CREDENTIAL_MARKER_CLOSE.length,
  );
  return RUN_ID_SHAPE.test(runId) ? runId : null;
}

/** True when SOME e2e run created this credential. */
export function isE2ECredentialName(name: string): boolean {
  return e2eRunIdOf(name) !== null;
}

/** True when THIS run created this credential. */
export function isCredentialOfRun(name: string, runId: string = E2E_RUN_ID): boolean {
  return e2eRunIdOf(name) === runId;
}

export type CredentialForCleanup = { id: string; name: string };

export type CleanupPlan = {
  /** Rows to delete: this run's rows — plus every row, under `allowWipe`. */
  deleteIds: string[];
  /**
   * Rows the journey refuses to delete on its own: credentials with no e2e
   * marker, i.e. accounts someone connected by hand. Empty when `allowWipe`.
   */
  blocked: CredentialForCleanup[];
  /**
   * Rows another e2e run owns. Left alone — deleting them would cut the ground
   * from under a journey running right now on the same database. Swept only
   * when `sweepStaleRuns` says so.
   */
  foreign: CredentialForCleanup[];
};

export type CleanupOptions = {
  /** The run claiming its rows. Defaults to this process's id. */
  runId?: string;
  /** NODALAI_E2E_WIPE_CREDENTIALS=1 — delete everything, hand-made included. */
  allowWipe: boolean;
  /** NODALAI_E2E_SWEEP_STALE=1 — also delete what other e2e runs left behind. */
  sweepStaleRuns?: boolean;
};

/** Reads the two escape hatches from the environment, and nothing else. */
export function cleanupOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  allowWipe: boolean;
  sweepStaleRuns: boolean;
} {
  return {
    allowWipe: env['NODALAI_E2E_WIPE_CREDENTIALS'] === '1',
    sweepStaleRuns: env['NODALAI_E2E_SWEEP_STALE'] === '1',
  };
}

/**
 * Decide what a cleanup may delete.
 *
 * - this run's rows are always deletable — it made them itself;
 * - another run's rows are `foreign`: left alone unless `sweepStaleRuns`;
 * - unmarked rows are `blocked`, and the caller fails loudly with the escape
 *   hatch, unless `allowWipe` (NODALAI_E2E_WIPE_CREDENTIALS=1) says otherwise.
 */
export function planCredentialCleanup(
  rows: readonly CredentialForCleanup[],
  opts: CleanupOptions,
): CleanupPlan {
  if (opts.allowWipe) {
    return { deleteIds: rows.map((r) => r.id), blocked: [], foreign: [] };
  }
  const runId = opts.runId ?? E2E_RUN_ID;
  const deleteIds: string[] = [];
  const blocked: CredentialForCleanup[] = [];
  const foreign: CredentialForCleanup[] = [];
  for (const row of rows) {
    const owner = e2eRunIdOf(row.name);
    if (owner === runId) deleteIds.push(row.id);
    else if (owner === null) blocked.push(row);
    else if (opts.sweepStaleRuns === true) deleteIds.push(row.id);
    else foreign.push(row);
  }
  return { deleteIds, blocked, foreign };
}

/** The message shown when a hand-connected account stands in the way. */
export function blockedCredentialsMessage(
  type: string,
  blocked: readonly CredentialForCleanup[],
): string {
  return (
    `Ce parcours part d'une base sans identifiant « ${type} », et cette pile en a ` +
    `${blocked.length} qu'aucun parcours e2e n'a créé (${blocked.map((r) => r.name).join(', ')}). ` +
    "Les supprimer effacerait un compte que quelqu'un a connecté à la main. Relancer avec " +
    'NODALAI_E2E_WIPE_CREDENTIALS=1 pour autoriser la suppression, ou viser une pile ' +
    'isolée (NODALAI_E2E_DB_URL).'
  );
}

/** The warning shown when another run's leftovers stay in the way. */
export function foreignCredentialsMessage(
  type: string,
  foreign: readonly CredentialForCleanup[],
): string {
  return (
    `e2e : ${foreign.length} identifiant(s) « ${type} » appartiennent à un autre run e2e ` +
    `(${foreign.map((r) => r.name).join(', ')}) et sont laissés en place. Si ce run est ` +
    'terminé ou interrompu, relancer avec NODALAI_E2E_SWEEP_STALE=1 pour les effacer.'
  );
}

/** Every credential of one type owned by one user, id and name only. */
export async function selectOwnedCredentials(
  db: AnyDrizzleDb,
  ownerUserId: string,
  type: CredentialType,
): Promise<CredentialForCleanup[]> {
  return db
    .select({ id: credentials.id, name: credentials.name })
    .from(credentials)
    .where(and(eq(credentials.ownerUserId, ownerUserId), eq(credentials.type, type)));
}

/**
 * Delete exactly the rows the plan named — never "everything owned by this
 * user of this type", which is what the `where` degrades into the day someone
 * drops the `inArray`. The owner and type stay in the clause as a second lock.
 */
export async function applyCredentialCleanup(
  db: AnyDrizzleDb,
  ownerUserId: string,
  type: CredentialType,
  plan: CleanupPlan,
): Promise<number> {
  if (plan.deleteIds.length === 0) return 0;
  await db
    .delete(credentials)
    .where(
      and(
        eq(credentials.ownerUserId, ownerUserId),
        eq(credentials.type, type),
        inArray(credentials.id, plan.deleteIds),
      ),
    );
  return plan.deleteIds.length;
}

/**
 * Start-of-journey cleanup: this run's leftovers go, a hand-connected account
 * makes the journey fail loudly, another run's rows are reported and kept.
 */
export async function cleanCredentialsOfType(
  db: AnyDrizzleDb,
  ownerUserId: string,
  type: CredentialType,
  opts: CleanupOptions,
  warn: (message: string) => void = (m) => console.warn(m),
): Promise<CleanupPlan> {
  const existing = await selectOwnedCredentials(db, ownerUserId, type);
  if (existing.length === 0) return { deleteIds: [], blocked: [], foreign: [] };
  const plan = planCredentialCleanup(existing, opts);
  if (plan.blocked.length > 0) throw new Error(blockedCredentialsMessage(type, plan.blocked));
  if (plan.foreign.length > 0) warn(foreignCredentialsMessage(type, plan.foreign));
  await applyCredentialCleanup(db, ownerUserId, type, plan);
  return plan;
}

/**
 * End-of-journey cleanup: erase what THIS run created, and nothing else. No
 * escape hatch here — a journey ending never decides to wipe a human's account
 * nor another run's rows.
 */
export async function dropRunCredentials(
  db: AnyDrizzleDb,
  ownerUserId: string,
  type: CredentialType,
  runId: string = E2E_RUN_ID,
): Promise<number> {
  const existing = await selectOwnedCredentials(db, ownerUserId, type);
  const plan = planCredentialCleanup(existing, { runId, allowWipe: false });
  return applyCredentialCleanup(db, ownerUserId, type, plan);
}
