// autonomy-rows-actions.test.ts — the dashboard's actions keep one autonomy row
// per agent and tool (#917), read back from the database.
//
// - opening the Autonomy tab (`listAgentApprovalRulesAction`) writes the rows
//   the agent is missing BEFORE returning them: the screen never shows a tool
//   without its row;
// - attaching an MCP server writes a row per tool it lends;
// - saving the workspace level changes no existing row; "Apply to all agents"
//   rewrites them;
// - turning the read-only preset off gives each tool back the level's value,
//   it never deletes the row.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  and,
  agents,
  approvalRules,
  entities,
  entityMembers,
  mcpServers,
} from '@nodal-agents/db';
import {
  DEFAULT_ROOT_GRANTS,
  READONLY_PRESET_TOOLS,
  REPLACE_SHARED_FILE_SETTING,
} from '@nodal-agents/shared';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
});

async function anAgent(): Promise<string> {
  const [a] = await testDb
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'A',
      slug: `a-${Date.now()}-${Math.random()}`,
      personality: 'p',
      active: true,
    })
    .returning();
  return a!.id;
}

async function rowsOf(agentId: string): Promise<Map<string, string>> {
  const rows = await testDb
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.agentId, agentId), eq(approvalRules.conditionFolder, '')));
  return new Map(rows.map((r) => [r.toolName, r.action]));
}

describe('the Autonomy tab reads rows the agent holds, written first (#917) @cap:regler-autonomie/moteur', () => {
  it('an agent without rows: the tab writes them all, then returns exactly those', async () => {
    const { listAgentApprovalRulesAction, listAgentAutonomyToolsAction } =
      await import('../actions.ts');
    const a = await anAgent();
    expect((await rowsOf(a)).size).toBe(0);

    const listed = await listAgentApprovalRulesAction(a);
    if (!listed.ok) throw new Error(listed.message);
    const held = await rowsOf(a);
    expect(held.size).toBeGreaterThan(10);
    expect(listed.data.map((r) => r.toolName).sort()).toEqual([...held.keys()].sort());

    // Every tool the tab lists has its row, the shared-file setting included.
    const tools = await listAgentAutonomyToolsAction(a);
    if (!tools.ok) throw new Error(tools.message);
    expect(tools.data.tools.filter((t) => !held.has(t.name))).toEqual([]);
    expect(tools.data.sharedFileSetting).toBe(true);
    expect(held.has(REPLACE_SHARED_FILE_SETTING)).toBe(true);
  });

  it('attaching an MCP server writes a row for each tool it lends', async () => {
    const { setAgentMcpServerAssignmentAction } = await import('../actions.ts');
    const a = await anAgent();
    const [server] = await testDb
      .insert(mcpServers)
      .values({
        entityId: seed.entityId,
        name: 'Docs',
        slug: `docs-${Date.now()}`,
        transport: 'http',
        url: 'https://mcp.example.test',
        availableTools: [
          { name: 'search_docs', description: 'Search', inputSchema: { type: 'object' } },
        ],
        active: true,
      })
      .returning();
    const res = await setAgentMcpServerAssignmentAction(a, server!.id, true, null);
    expect(res.ok).toBe(true);
    const held = await rowsOf(a);
    const name = [...held.keys()].find((k) => k.endsWith('__search_docs'));
    expect(name).toBeDefined();
    // The shipped level (propose_confirm): a third-party tool asks first.
    expect(held.get(name!)).toBe('require_approval');
  });
});

describe('the workspace level is a template; Apply to all rewrites (#917) @cap:regler-autonomie/moteur', () => {
  it('saving a new level changes no row; Apply to all agents does', async () => {
    const { listAgentApprovalRulesAction, setRootAgentAction, applyAutonomyLevelToAllAction } =
      await import('../actions.ts');
    const a = await anAgent();
    await listAgentApprovalRulesAction(a);
    const before = await rowsOf(a);
    expect(before.get(REPLACE_SHARED_FILE_SETTING)).toBe('require_approval');

    // setRootAgentAction needs a ROOT and a member: the seed stands in.
    await testDb
      .update(entities)
      .set({ rootAgentId: seed.agentId })
      .where(eq(entities.id, seed.entityId));
    await testDb
      .insert(entityMembers)
      .values({ entityId: seed.entityId, userId: seed.userId, role: 'owner' })
      .onConflictDoNothing();
    const saved = await setRootAgentAction({
      grants: { ...DEFAULT_ROOT_GRANTS, autonomy: 'fully_autonomous' },
    });
    expect(saved.ok).toBe(true);
    expect(await rowsOf(a)).toEqual(before);

    const applied = await applyAutonomyLevelToAllAction();
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.data.changed).toBeGreaterThan(0);
    expect((await rowsOf(a)).get(REPLACE_SHARED_FILE_SETTING)).toBe('auto_approve');
  });
});

describe('the read-only preset turned off gives the rows back, never deletes them (#917) @cap:regler-autonomie/moteur', () => {
  it('on: each preset tool blocked; off: each tool back to the level’s value, still a row', async () => {
    const { setReviewerReadOnlyPresetAction, listAgentApprovalRulesAction } =
      await import('../actions.ts');
    await testDb
      .update(entities)
      .set({ rootGrants: { ...DEFAULT_ROOT_GRANTS, autonomy: 'propose_confirm' } })
      .where(eq(entities.id, seed.entityId));
    const a = await anAgent();
    await listAgentApprovalRulesAction(a);

    expect((await setReviewerReadOnlyPresetAction({ agentId: a, enabled: true })).ok).toBe(true);
    let held = await rowsOf(a);
    for (const t of READONLY_PRESET_TOOLS) expect(held.get(t), t).toBe('block');

    expect((await setReviewerReadOnlyPresetAction({ agentId: a, enabled: false })).ok).toBe(true);
    held = await rowsOf(a);
    // file_write runs by itself; run_command and run_skill_script ask under
    // propose_confirm: what the level writes for each.
    expect(held.get('file_write')).toBe('auto_approve');
    expect(held.get('run_command')).toBe('require_approval');
    expect(held.get('run_skill_script')).toBe('require_approval');
    for (const t of READONLY_PRESET_TOOLS) expect(held.has(t), t).toBe(true);
  });
});
