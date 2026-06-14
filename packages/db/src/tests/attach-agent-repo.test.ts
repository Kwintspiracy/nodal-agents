// attach-agent-repo.test.ts — tests for attachAgentToOrchestrator().
// Asserts on real DB rows — never call counts. (CLAUDE.md invariant 5)

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { createAgentRepo, attachAgentToOrchestrator } from '../repos/agents.ts';
import * as schema from '../schema/index.ts';

let db: TestDb;
let entityId: string;
let orchestratorId: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const seed = await seedMinimal(db);
  entityId = seed.entityId;

  // Create an orchestrator to act as the ROOT caller
  const orch = await createAgentRepo(db, entityId, {
    slug: 'attach-test-orch',
    name: 'Attach Test Orchestrator',
    personality: 'p',
    model: 'm',
    llmKeyId: null,
    role: 'orchestrator',
    orchestratorMode: 'router',
    avatarUrl: null,
    subAgentIds: [],
  });
  if (!('id' in orch)) throw new Error('orch creation failed');
  orchestratorId = orch.id;
});

describe('attachAgentToOrchestrator', () => {
  it('creates a real agent_assignments row when resolved by slug', async () => {
    // Create the target agent
    const worker = await createAgentRepo(db, entityId, {
      slug: 'attach-worker-slug',
      name: 'Attach Worker Slug',
      personality: 'p',
      model: 'm',
      llmKeyId: null,
      role: 'agent',
      orchestratorMode: null,
      avatarUrl: null,
      subAgentIds: [],
    });
    if (!('id' in worker)) throw new Error('worker creation failed');
    const workerId = worker.id;

    const result = await attachAgentToOrchestrator(db, entityId, orchestratorId, 'attach-worker-slug');

    expect('ok' in result).toBe(true);
    if (!('ok' in result)) throw new Error('expected ok result');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.subAgentId).toBe(workerId);
    expect(result.subAgentName).toBe('Attach Worker Slug');

    // Assert real DB row
    const assignments = await db
      .select()
      .from(schema.agentAssignments)
      .where(
        and(
          eq(schema.agentAssignments.orchestratorId, orchestratorId),
          eq(schema.agentAssignments.subAgentId, workerId),
        ),
      );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.entityId).toBe(entityId);
  });

  it('resolves the target by NAME (ilike), not just slug', async () => {
    const worker = await createAgentRepo(db, entityId, {
      slug: 'attach-worker-byname',
      name: 'Findable By Display Name',
      personality: 'p',
      model: 'm',
      llmKeyId: null,
      role: 'agent',
      orchestratorMode: null,
      avatarUrl: null,
      subAgentIds: [],
    });
    if (!('id' in worker)) throw new Error('worker creation failed');
    const workerId = worker.id;

    // Pass the name (case-mixed) instead of the slug
    const result = await attachAgentToOrchestrator(db, entityId, orchestratorId, 'findable by display name');

    expect('ok' in result && result.ok).toBe(true);
    if (!('ok' in result) || !result.ok) throw new Error('expected ok:true');
    expect(result.subAgentId).toBe(workerId);

    // Assert real DB row
    const assignments = await db
      .select()
      .from(schema.agentAssignments)
      .where(
        and(
          eq(schema.agentAssignments.orchestratorId, orchestratorId),
          eq(schema.agentAssignments.subAgentId, workerId),
        ),
      );
    expect(assignments.length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent: calling twice produces exactly one assignment row', async () => {
    const worker = await createAgentRepo(db, entityId, {
      slug: 'attach-worker-idem',
      name: 'Attach Worker Idempotent',
      personality: 'p',
      model: 'm',
      llmKeyId: null,
      role: 'agent',
      orchestratorMode: null,
      avatarUrl: null,
      subAgentIds: [],
    });
    if (!('id' in worker)) throw new Error('worker creation failed');
    const workerId = worker.id;

    const first = await attachAgentToOrchestrator(db, entityId, orchestratorId, 'attach-worker-idem');
    expect('ok' in first && first.ok).toBe(true);

    const second = await attachAgentToOrchestrator(db, entityId, orchestratorId, 'attach-worker-idem');
    expect('ok' in second && second.ok).toBe(true);

    // Still exactly one row
    const assignments = await db
      .select()
      .from(schema.agentAssignments)
      .where(
        and(
          eq(schema.agentAssignments.orchestratorId, orchestratorId),
          eq(schema.agentAssignments.subAgentId, workerId),
        ),
      );
    expect(assignments).toHaveLength(1);
  });

  it('returns error:agent_not_found for a missing slug', async () => {
    const result = await attachAgentToOrchestrator(db, entityId, orchestratorId, 'no-such-agent-xyz');
    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('expected error result');
    expect(result.error).toBe('agent_not_found');
  });

  it('returns error:cannot_attach_self when target resolves to the orchestrator itself', async () => {
    // The orchestrator tries to attach itself using its own slug
    const [orchRow] = await db
      .select({ slug: schema.agents.slug })
      .from(schema.agents)
      .where(eq(schema.agents.id, orchestratorId));
    expect(orchRow).toBeDefined();

    const result = await attachAgentToOrchestrator(db, entityId, orchestratorId, orchRow!.slug);
    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('expected error result');
    expect(result.error).toBe('cannot_attach_self');
  });
});
