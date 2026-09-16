// e2e-credential-cleanup.test.ts — proves the e2e credential cleanup guard
// tells a journey-created credential apart from an account a human connected
// by hand, AND that the DELETE it produces hits exactly those rows.
//
// The bug this locks down (nightly 2026-09-15, run 34948237666): the guard
// only counted rows, so a credential left behind by `credentials-reuse.spec.ts`
// blocked the two Google journeys that ran after it. Order-dependent journeys,
// red on a healthy product.
//
// The review of PR #118 found the first fix half-done, and the tests half-
// placed: only the pure decider was locked, so three mutations of the wiring
// left the suite green. Each one now has a test that goes red on it:
//   1. `=== '1'` → `!== '1'` on NODALAI_E2E_WIPE_CREDENTIALS
//      (→ "reads the wipe hatch only on an exact 1");
//   2. dropping the marker filter in the end-of-journey cleanup
//      (→ "erases only this run's rows, never a human's nor another run's");
//   3. deleting by owner+type instead of by the planned ids
//      (→ "leaves another run's credential alone", the sweep and owner tests).
//
// The wiring runs against a real Postgres (pglite), so an assertion is a row
// read back from the table, never a call count.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { credentials, users, eq } from '@nodal-agents/db';
import {
  E2E_CREDENTIAL_MARKER_OPEN,
  E2E_RUN_ID,
  e2eCredentialMarker,
  e2eCredentialName,
  e2eRunIdOf,
  isE2ECredentialName,
  isCredentialOfRun,
  planCredentialCleanup,
  blockedCredentialsMessage,
  cleanupOptionsFromEnv,
  cleanCredentialsOfType,
  dropRunCredentials,
} from './e2e/credential-cleanup.ts';

const THIS_RUN = 'run0000001';
const OTHER_RUN = 'run0000002';
const mine = (label: string) => e2eCredentialName(label, THIS_RUN);
const theirs = (label: string) => e2eCredentialName(label, OTHER_RUN);

describe('planCredentialCleanup', () => {
  it("deletes a credential this run's earlier journey left behind", () => {
    const row = { id: 'c1', name: mine('My Google (reuse test)') };
    const plan = planCredentialCleanup([row], { runId: THIS_RUN, allowWipe: false });
    expect(plan.deleteIds).toEqual(['c1']);
    expect(plan.blocked).toEqual([]);
    expect(plan.foreign).toEqual([]);
  });

  it('never deletes an account connected by hand, and names it', () => {
    const human = { id: 'h1', name: 'My Google' };
    const plan = planCredentialCleanup([human], { runId: THIS_RUN, allowWipe: false });
    expect(plan.deleteIds).toEqual([]);
    expect(plan.blocked).toEqual([human]);
    expect(blockedCredentialsMessage('google-oauth', plan.blocked)).toContain('My Google');
  });

  it("leaves another run's credential alone instead of deleting it", () => {
    const other = { id: 'o1', name: theirs('My Google (other machine)') };
    const plan = planCredentialCleanup([other], { runId: THIS_RUN, allowWipe: false });
    expect(plan.deleteIds).toEqual([]);
    expect(plan.blocked).toEqual([]);
    expect(plan.foreign).toEqual([other]);
  });

  it("sweeps another run's credential only when asked explicitly", () => {
    const other = { id: 'o1', name: theirs('My Google (interrupted run)') };
    const plan = planCredentialCleanup([other], {
      runId: THIS_RUN,
      allowWipe: false,
      sweepStaleRuns: true,
    });
    expect(plan.deleteIds).toEqual(['o1']);
    expect(plan.foreign).toEqual([]);
  });

  it('separates the three families when all are present', () => {
    const rows = [
      { id: 'h1', name: 'My Google' },
      { id: 'c1', name: mine('My Google Drive (e2e)') },
      { id: 'h2', name: 'Work Google (reuse test)' },
      { id: 'o1', name: theirs('My Google (other run)') },
    ];
    const plan = planCredentialCleanup(rows, { runId: THIS_RUN, allowWipe: false });
    expect(plan.deleteIds).toEqual(['c1']);
    expect(plan.blocked.map((r) => r.id)).toEqual(['h1', 'h2']);
    expect(plan.foreign.map((r) => r.id)).toEqual(['o1']);
  });

  it('wipes everything only when the operator asked for it', () => {
    const rows = [
      { id: 'h1', name: 'My Google' },
      { id: 'c1', name: mine('My Google Drive (e2e)') },
      { id: 'o1', name: theirs('My Google (other run)') },
    ];
    const plan = planCredentialCleanup(rows, { runId: THIS_RUN, allowWipe: true });
    expect(plan.deleteIds).toEqual(['h1', 'c1', 'o1']);
    expect(plan.blocked).toEqual([]);
    expect(plan.foreign).toEqual([]);
  });

  it('blocks a hand-typed name that carries the marker out of position', () => {
    // Someone read the marker in the repo and pasted it into "Display name".
    const rows = [
      { id: 'h1', name: `${e2eCredentialMarker(THIS_RUN)} my google` },
      { id: 'h2', name: `my ${e2eCredentialMarker(THIS_RUN)} google` },
      { id: 'h3', name: `${e2eCredentialMarker(OTHER_RUN)} ${mine('two markers')}` },
      { id: 'h4', name: `google ${E2E_CREDENTIAL_MARKER_OPEN}]` },
    ];
    const plan = planCredentialCleanup(rows, { runId: THIS_RUN, allowWipe: false });
    expect(plan.deleteIds).toEqual([]);
    expect(plan.blocked.map((r) => r.id)).toEqual(['h1', 'h2', 'h3', 'h4']);
  });
});

describe('e2e credential marker', () => {
  it('recognises only the literal marker, not a wording heuristic', () => {
    expect(isE2ECredentialName(mine('anything'))).toBe(true);
    expect(isE2ECredentialName('My Google (reuse test)')).toBe(false);
    expect(isE2ECredentialName('My Google Drive (e2e)')).toBe(false);
    expect(mine('X')).toContain(E2E_CREDENTIAL_MARKER_OPEN);
  });

  it('reads the run that created the credential, and only in the last position', () => {
    expect(e2eRunIdOf(mine('X'))).toBe(THIS_RUN);
    expect(e2eRunIdOf(theirs('X'))).toBe(OTHER_RUN);
    expect(e2eRunIdOf(`${mine('X')} renamed by hand`)).toBeNull();
    expect(e2eRunIdOf(`X ${E2E_CREDENTIAL_MARKER_OPEN}NOT A RUN ID]`)).toBeNull();
    // Opened and never closed: the marker does not end the name, so there is
    // no run id to read — dropping the closing check would read "abcdef" here.
    expect(e2eRunIdOf(`X ${E2E_CREDENTIAL_MARKER_OPEN}abcdefg`)).toBeNull();
  });

  it("tells this run's credential from another run's", () => {
    expect(isCredentialOfRun(mine('X'), THIS_RUN)).toBe(true);
    expect(isCredentialOfRun(theirs('X'), THIS_RUN)).toBe(false);
  });

  it('gives this process a run id of its own', () => {
    expect(E2E_RUN_ID).toMatch(/^[a-z0-9]{6,32}$/);
    expect(e2eCredentialName('X')).toContain(e2eCredentialMarker(E2E_RUN_ID));
  });
});

describe('cleanupOptionsFromEnv', () => {
  it('reads the wipe hatch only on an exact 1', () => {
    expect(cleanupOptionsFromEnv({ NODALAI_E2E_WIPE_CREDENTIALS: '1' }).allowWipe).toBe(true);
    expect(cleanupOptionsFromEnv({ NODALAI_E2E_WIPE_CREDENTIALS: '0' }).allowWipe).toBe(false);
    expect(cleanupOptionsFromEnv({ NODALAI_E2E_WIPE_CREDENTIALS: 'true' }).allowWipe).toBe(false);
    expect(cleanupOptionsFromEnv({}).allowWipe).toBe(false);
  });

  it('reads the stale-sweep hatch only on an exact 1', () => {
    expect(cleanupOptionsFromEnv({ NODALAI_E2E_SWEEP_STALE: '1' }).sweepStaleRuns).toBe(true);
    expect(cleanupOptionsFromEnv({ NODALAI_E2E_SWEEP_STALE: 'yes' }).sweepStaleRuns).toBe(false);
    expect(cleanupOptionsFromEnv({}).sweepStaleRuns).toBe(false);
  });
});

// ── The wiring, against a real database ──────────────────────────────────────

let testDb: TestDb;
let ownerId = '';
let strangerId = '';

/** Insert a credential and hand back its id. */
async function insertCredential(owner: string, name: string, type = 'google-oauth') {
  await testDb
    .insert(credentials)
    .values({ ownerUserId: owner, name, type, payload: 'enc:v1:test' });
}

async function namesOf(owner: string): Promise<string[]> {
  const rows = await testDb
    .select({ name: credentials.name })
    .from(credentials)
    .where(eq(credentials.ownerUserId, owner));
  return rows.map((r) => r.name).sort();
}

beforeAll(async () => {
  const { db } = await spinUpTestDb();
  testDb = db;
  const seed = await seedMinimal(db);
  ownerId = seed.userId;
  const [stranger] = await db
    .insert(users)
    .values({ email: `stranger-${Date.now()}@example.com` })
    .returning({ id: users.id });
  strangerId = stranger!.id;
});

beforeEach(async () => {
  await testDb.delete(credentials);
});

describe('cleanCredentialsOfType (start of journey)', () => {
  it("erases this run's leftover and leaves another run's credential alone", async () => {
    await insertCredential(ownerId, mine('My Google (reuse test)'));
    await insertCredential(ownerId, theirs('My Google (other machine)'));

    const warnings: string[] = [];
    const plan = await cleanCredentialsOfType(
      testDb,
      ownerId,
      'google-oauth',
      { runId: THIS_RUN, allowWipe: false },
      (m) => warnings.push(m),
    );

    expect(plan.deleteIds).toHaveLength(1);
    expect(await namesOf(ownerId)).toEqual([theirs('My Google (other machine)')]);
    expect(warnings.join('\n')).toContain('NODALAI_E2E_SWEEP_STALE=1');
  });

  it('refuses to delete anything when a hand-connected account is in the way', async () => {
    await insertCredential(ownerId, 'My Google');
    await insertCredential(ownerId, mine('My Google Drive (e2e)'));

    await expect(
      cleanCredentialsOfType(testDb, ownerId, 'google-oauth', {
        runId: THIS_RUN,
        allowWipe: false,
      }),
    ).rejects.toThrow('My Google');

    expect(await namesOf(ownerId)).toHaveLength(2);
  });

  it('deletes the hand-connected account only under the wipe hatch', async () => {
    await insertCredential(ownerId, 'My Google');
    await insertCredential(ownerId, theirs('My Google (other run)'));

    await cleanCredentialsOfType(testDb, ownerId, 'google-oauth', {
      runId: THIS_RUN,
      allowWipe: true,
    });

    expect(await namesOf(ownerId)).toEqual([]);
  });

  it("sweeps another run's leftover only under the sweep hatch", async () => {
    await insertCredential(ownerId, theirs('My Google (interrupted)'));

    await cleanCredentialsOfType(testDb, ownerId, 'google-oauth', {
      runId: THIS_RUN,
      allowWipe: false,
      sweepStaleRuns: true,
    });

    expect(await namesOf(ownerId)).toEqual([]);
  });

  it('never reaches across owners or credential types', async () => {
    await insertCredential(strangerId, mine('Someone else Google'));
    await insertCredential(ownerId, mine('My Notion'), 'notion-oauth');
    await insertCredential(ownerId, mine('My Google'));

    await cleanCredentialsOfType(testDb, ownerId, 'google-oauth', {
      runId: THIS_RUN,
      allowWipe: false,
    });

    expect(await namesOf(ownerId)).toEqual([mine('My Notion')]);
    expect(await namesOf(strangerId)).toEqual([mine('Someone else Google')]);
  });
});

describe('dropRunCredentials (end of journey)', () => {
  it("erases only this run's rows, never a human's nor another run's", async () => {
    await insertCredential(ownerId, 'My Google');
    await insertCredential(ownerId, theirs('My Google (other run)'));
    await insertCredential(ownerId, mine('My Google Drive (e2e)'));

    const deleted = await dropRunCredentials(testDb, ownerId, 'google-oauth', THIS_RUN);

    expect(deleted).toBe(1);
    expect(await namesOf(ownerId)).toEqual(['My Google', theirs('My Google (other run)')].sort());
  });

  it('erases nothing, and says so, when this run created nothing', async () => {
    expect(await dropRunCredentials(testDb, ownerId, 'google-oauth', THIS_RUN)).toBe(0);
  });

  it('leaves another owner and another type untouched', async () => {
    await insertCredential(strangerId, mine('Someone else Google'));
    await insertCredential(ownerId, mine('My Notion'), 'notion-oauth');
    await insertCredential(ownerId, mine('My Google'));

    await dropRunCredentials(testDb, ownerId, 'google-oauth', THIS_RUN);

    expect(await namesOf(ownerId)).toEqual([mine('My Notion')]);
    expect(await namesOf(strangerId)).toEqual([mine('Someone else Google')]);
  });
});
