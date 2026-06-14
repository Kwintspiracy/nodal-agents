// Brique F — "ROOT = origin orchestrator".
// createAgentRepo auto-designates the FIRST orchestrator of an entity as its
// ROOT (grants all-off / opt-in), and forces every subsequent orchestrator
// under that ROOT as a sub-agent — so there is never a second top-level
// orchestrator. Workers never trigger any of this.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { createAgentRepo } from '../repos/agents.ts';
import * as schema from '../schema/index.ts';

let db: TestDb;
let entityId: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const seed = await seedMinimal(db);
  entityId = seed.entityId;
  // Start from a clean slate: no ROOT designated for this entity.
  await db
    .update(schema.entities)
    .set({ rootAgentId: null })
    .where(eq(schema.entities.id, entityId));
});

function orch(slug: string, name: string) {
  return {
    slug,
    name,
    personality: 'p',
    model: 'm',
    llmKeyId: null,
    role: 'orchestrator' as const,
    orchestratorMode: 'router' as const,
    avatarUrl: null,
    subAgentIds: [] as string[],
  };
}
function worker(slug: string, name: string) {
  return {
    slug,
    name,
    personality: 'p',
    model: 'm',
    llmKeyId: null,
    role: 'agent' as const,
    orchestratorMode: null,
    avatarUrl: null,
    subAgentIds: [] as string[],
  };
}

async function rootOf(): Promise<string | null> {
  const [ent] = await db
    .select({ rootAgentId: schema.entities.rootAgentId })
    .from(schema.entities)
    .where(eq(schema.entities.id, entityId));
  return ent?.rootAgentId ?? null;
}

describe('createAgentRepo — ROOT = origin orchestrator', () => {
  it('creating a worker does NOT designate a ROOT', async () => {
    const r = await createAgentRepo(db, entityId, worker('w1', 'Worker 1'));
    expect('id' in r).toBe(true);
    expect(await rootOf()).toBeNull();
  });

  it('the first orchestrator becomes ROOT, with grants all-off (opt-in powers)', async () => {
    const r = await createAgentRepo(db, entityId, orch('root-orch', 'Root Orch'));
    const rootId = 'id' in r ? r.id : '';
    expect(rootId).toBeTruthy();
    expect(await rootOf()).toBe(rootId);

    const [ent] = await db
      .select({ rootGrants: schema.entities.rootGrants })
      .from(schema.entities)
      .where(eq(schema.entities.id, entityId));
    // All meta-tool grants start OFF — the ROOT holds no powers until the user
    // enables them in Settings. (A null/empty rootGrants would parse to all-on.)
    expect(ent?.rootGrants).toMatchObject({
      createAgent: false,
      createSkill: false,
      updateSkill: false,
      assignSkill: false,
      autonomy: 'propose_confirm',
    });
  });

  it('a second orchestrator is forced under the ROOT (never a 2nd top-level)', async () => {
    const rootId = (await rootOf())!;
    const r = await createAgentRepo(db, entityId, orch('second-orch', 'Second Orch'));
    const secondId = 'id' in r ? r.id : '';
    expect(secondId).toBeTruthy();

    // ROOT is unchanged — the first orchestrator stays the origin.
    expect(await rootOf()).toBe(rootId);

    // The second orchestrator is wired as a sub-agent of the ROOT.
    const assignments = await db
      .select()
      .from(schema.agentAssignments)
      .where(
        and(
          eq(schema.agentAssignments.orchestratorId, rootId),
          eq(schema.agentAssignments.subAgentId, secondId),
        ),
      );
    expect(assignments.length).toBe(1);
  });

  // ─── assignToOrchestratorId ────────────────────────────────────────────────

  it('worker created with assignToOrchestratorId gets an assignment row under that orchestrator', async () => {
    const rootId = (await rootOf())!;
    expect(rootId).toBeTruthy();

    const r = await createAgentRepo(db, entityId, {
      ...worker('assigned-worker', 'Assigned Worker'),
      assignToOrchestratorId: rootId,
    });
    const workerId = 'id' in r ? r.id : '';
    expect(workerId).toBeTruthy();

    // A real agent_assignments row must exist linking ROOT → worker.
    const assignments = await db
      .select()
      .from(schema.agentAssignments)
      .where(
        and(
          eq(schema.agentAssignments.orchestratorId, rootId),
          eq(schema.agentAssignments.subAgentId, workerId),
        ),
      );
    expect(assignments.length).toBe(1);
    expect(assignments[0]!.entityId).toBe(entityId);
  });

  it('worker created WITHOUT assignToOrchestratorId has no assignment row (current behaviour preserved)', async () => {
    const r = await createAgentRepo(db, entityId, worker('unassigned-worker', 'Unassigned Worker'));
    const workerId = 'id' in r ? r.id : '';
    expect(workerId).toBeTruthy();

    // No assignment row should exist for this worker under any orchestrator.
    const assignments = await db
      .select()
      .from(schema.agentAssignments)
      .where(eq(schema.agentAssignments.subAgentId, workerId));
    expect(assignments.length).toBe(0);
  });

  it('assignToOrchestratorId is idempotent: orchestrator created with same ROOT id yields exactly ONE assignment row', async () => {
    const rootId = (await rootOf())!;
    expect(rootId).toBeTruthy();

    // Create a new orchestrator passing assignToOrchestratorId = ROOT id.
    // Brique F ALSO inserts a ROOT→new-orch assignment, so two paths converge.
    const r = await createAgentRepo(db, entityId, {
      ...orch('orch-idempotent', 'Orch Idempotent'),
      assignToOrchestratorId: rootId,
    });
    const orchId = 'id' in r ? r.id : '';
    expect(orchId).toBeTruthy();

    // Must be exactly ONE assignment row, not two.
    const assignments = await db
      .select()
      .from(schema.agentAssignments)
      .where(
        and(
          eq(schema.agentAssignments.orchestratorId, rootId),
          eq(schema.agentAssignments.subAgentId, orchId),
        ),
      );
    expect(assignments.length).toBe(1);
  });
});
