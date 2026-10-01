// mcp-attach-namespace.test.ts — the Connectors tab never gives an agent two
// MCP servers whose tool names collide (#661), against real rows.
//
// setAgentMcpServerAssignmentAction goes through attachMcpServerToAgent
// (packages/db), the one attach path of every surface. Assertions are on the
// action's answer AND on the agent_mcp_servers rows it left.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  agents,
  agentJobs,
  agentMcpServers,
  approvalRequests,
  mcpServers,
} from '@nodal-agents/db';
import { MCP_SERVER_SLUG_RULE } from '@nodal-agents/shared';

let testDb: TestDb;
let session: { userId: string; entityId: string };

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-auth' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (s: { userId: string; entityId?: string }) => ({
    ...s,
    entityId: session.entityId,
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
    requireAuth: async () => ({ userId: session.userId, entityId: session.entityId }),
  };
});

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  const s = await seedMinimal(testDb);
  session = { userId: s.userId, entityId: s.entityId };
});

let n = 0;
async function agent(): Promise<string> {
  n += 1;
  const [row] = await testDb
    .insert(agents)
    .values({
      entityId: session.entityId,
      name: `Agent ${n}`,
      slug: `ns-agent-${n}`,
      personality: 'x',
      role: 'agent',
    })
    .returning({ id: agents.id });
  return row!.id;
}

async function server(slug: string, name: string): Promise<string> {
  const [row] = await testDb
    .insert(mcpServers)
    .values({ entityId: session.entityId, name, slug, transport: 'stdio', command: 'node' })
    .returning({ id: mcpServers.id });
  return row!.id;
}

async function heldBy(agentId: string) {
  const rows = await testDb
    .select({
      mcpServerId: agentMcpServers.mcpServerId,
      enabledTools: agentMcpServers.enabledTools,
    })
    .from(agentMcpServers)
    .where(eq(agentMcpServers.agentId, agentId));
  return rows;
}

describe('setAgentMcpServerAssignmentAction — one tool name, one server @cap:connecter-un-service/moteur', () => {
  it('refuses a second instance of a server the agent holds, names both, writes nothing', async () => {
    const { setAgentMcpServerAssignmentAction } = await import('../actions.ts');
    const a = await agent();
    const perso = await server('cogni-cortex', 'Cortex perso');
    const boulot = await server('cogni-cortex', 'Cortex boulot');

    expect((await setAgentMcpServerAssignmentAction(a, perso, true, null)).ok).toBe(true);
    const r = await setAgentMcpServerAssignmentAction(a, boulot, true, null);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('mcp_namespace_overlap');
    expect(r.message).toContain('"Cortex perso" (cogni-cortex)');
    expect(r.message).toContain('"Cortex boulot" (cogni-cortex)');
    expect(await heldBy(a)).toEqual([{ mcpServerId: perso, enabledTools: null }]);
  });

  it('refuses slugs that fold onto one prefix, and a namespace extending another', async () => {
    const { setAgentMcpServerAssignmentAction } = await import('../actions.ts');
    for (const [held, next] of [
      ['guide-srv', 'guide--srv'],
      ['a', 'a-'],
    ] as const) {
      const a = await agent();
      const first = await server(held, `S ${held}`);
      const second = await server(next, `S ${next}`);
      expect((await setAgentMcpServerAssignmentAction(a, first, true, [])).ok).toBe(true);
      const r = await setAgentMcpServerAssignmentAction(a, second, true, null);
      expect(r.ok, `${held} then ${next}`).toBe(false);
      expect((await heldBy(a)).map((h) => h.mcpServerId)).toEqual([first]);
    }
  });

  it('the same instance on two agents, distinct servers on one, and re-saving a tool list all pass', async () => {
    const { setAgentMcpServerAssignmentAction } = await import('../actions.ts');
    const a = await agent();
    const b = await agent();
    const fetch = await server('mcp-fetch', 'Fetch');
    const git = await server('mcp-git', 'Git');
    const first = await server('acme', 'Acme one');
    const second = await server('acme', 'Acme two');

    expect((await setAgentMcpServerAssignmentAction(a, fetch, true, null)).ok).toBe(true);
    expect((await setAgentMcpServerAssignmentAction(a, git, true, null)).ok).toBe(true);
    // Re-saving the tool list of a server the agent holds is not a collision with itself.
    expect((await setAgentMcpServerAssignmentAction(a, git, true, ['status'])).ok).toBe(true);
    // Two instances of one server, one per agent.
    expect((await setAgentMcpServerAssignmentAction(a, first, true, null)).ok).toBe(true);
    expect((await setAgentMcpServerAssignmentAction(b, second, true, null)).ok).toBe(true);

    const held = await heldBy(a);
    expect(held).toHaveLength(3);
    expect(held.find((h) => h.mcpServerId === git)?.enabledTools).toEqual(['status']);
    expect((await heldBy(b)).map((h) => h.mcpServerId)).toEqual([second]);
  });
});

describe('createMcpServerFromCatalogAction — the canonical slug grammar @cap:connecter-un-service/moteur', () => {
  it('refuses a custom slug with a doubled, leading or trailing hyphen, before anything connects', async () => {
    const { createMcpServerFromCatalogAction } = await import('../actions.ts');
    for (const customSlug of ['guide--srv', '-guide', 'guide-']) {
      const r = await createMcpServerFromCatalogAction({
        slug: 'custom-stdio-mcp',
        name: 'Custom',
        customSlug,
        customCommand: 'node',
      });
      expect(r.ok, customSlug).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('validation_failed');
      expect(r.message).toBe(MCP_SERVER_SLUG_RULE);
      const rows = await testDb
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.name, 'Custom'));
      expect(rows).toHaveLength(0);
    }
  });
});

describe('listApprovalsAction — the card names the instance the requesting agent holds @cap:approuver-une-action/moteur', () => {
  it('two instances of one server, one per agent: each approval names its own', async () => {
    const { setAgentMcpServerAssignmentAction, listApprovalsAction } =
      await import('../actions.ts');
    const a = await agent();
    const b = await agent();
    const perso = await server('cortex-x', 'Cortex perso');
    const boulot = await server('cortex-x', 'Cortex boulot');
    expect((await setAgentMcpServerAssignmentAction(a, perso, true, null)).ok).toBe(true);
    expect((await setAgentMcpServerAssignmentAction(b, boulot, true, null)).ok).toBe(true);

    const jobIds: string[] = [];
    for (const agentId of [a, b]) {
      const [job] = await testDb
        .insert(agentJobs)
        .values({
          entityId: session.entityId,
          agentId,
          channel: 'api',
          task: 'Ping.',
          status: 'awaiting_approval',
          messages: [],
          chainCount: 0,
        })
        .returning({ id: agentJobs.id });
      jobIds.push(job!.id);
      await testDb.insert(approvalRequests).values({
        entityId: session.entityId,
        jobId: job!.id,
        agentId,
        toolName: 'cortex_x__ping',
        toolInput: { purpose: 'p' },
        status: 'pending',
      });
    }

    const res = await listApprovalsAction({ status: 'pending', jobIds });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const what = (agentId: string) =>
      JSON.stringify(res.data.find((r) => r.agentId === agentId)?.explanation ?? null);
    expect(what(a)).toContain('Cortex perso');
    expect(what(a)).not.toContain('Cortex boulot');
    expect(what(b)).toContain('Cortex boulot');
    expect(what(b)).not.toContain('Cortex perso');
    expect(what(a)).not.toContain('several servers');
  });
});
