// meta-ops.test.ts — unit tests for create_skill, attach_skill, create_agent tools.
// Uses a real pglite in-memory DB via @nodal-agents/db/test-utils.
// Asserts on real DB rows — never call counts. (CLAUDE.md invariant 5)

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import {
  agentSkills,
  agentSkillAssignments,
  agentAssignments,
  agents,
  mcpServers,
  agentMcpServers,
  connectors,
  entities,
  eq,
  and,
} from '@nodal-agents/db';
import type { TestDb } from '@nodal-agents/db/test-utils';
import type { ToolContext, ToolProvisioning, ProvisionedMcpTool } from '../../types';
import { createSkillTool } from './create-skill';
import { updateSkillTool } from './update-skill';
import { assignSkillTool } from './assign-skill';
import { createAgentTool } from './create-agent';
import { attachAgentTool } from './attach-agent';
import { createMcpTool } from './create-mcp';
import { createConnectorTool } from './create-connector';
import { attachMcpTool } from './attach-mcp';
import { createAgentRepo } from '@nodal-agents/db';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

function makeCtx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

// ─── create_skill ─────────────────────────────────────────────────────────────

describe('create_skill', () => {
  it('inserts a real agent_skills row with the correct slug + entityId', async () => {
    const ctx = makeCtx();
    const result = await createSkillTool.execute(
      {
        slug: 'test-skill-create',
        name: 'Test Skill Create',
        content: 'You are a test skill.',
        description: 'Used in unit tests.',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.message).toContain('test-skill-create');
    expect(result.message).toContain('Test Skill Create');

    // Assert on the real DB row
    const rows = await db
      .select()
      .from(agentSkills)
      .where(
        and(eq(agentSkills.slug, 'test-skill-create'), eq(agentSkills.entityId, seed.entityId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Test Skill Create');
    expect(rows[0]!.content).toBe('You are a test skill.');
    expect(rows[0]!.entityId).toBe(seed.entityId);
  });

  it('returns ok:false with a clear error when the slug is already taken', async () => {
    const ctx = makeCtx();
    // First insert
    await createSkillTool.execute(
      { slug: 'slug-dupe-test', name: 'Dupe Skill One', content: 'Content A' },
      ctx,
    );

    // Second insert with same slug
    const result = await createSkillTool.execute(
      { slug: 'slug-dupe-test', name: 'Dupe Skill Two', content: 'Content B' },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toContain('slug-dupe-test');
    expect(result.error.toLowerCase()).toContain('taken');

    // Only one row exists
    const rows = await db.select().from(agentSkills).where(eq(agentSkills.slug, 'slug-dupe-test'));
    expect(rows).toHaveLength(1);
  });

  it('message contains id on success', async () => {
    const result = await createSkillTool.execute(
      { slug: 'skill-with-id-check', name: 'Skill ID Check', content: 'Content' },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // Message must contain a UUID-like id
    expect(result.message).toMatch(/id [0-9a-f-]{36}/);
  });
});

// ─── update_skill ─────────────────────────────────────────────────────────────

describe('update_skill', () => {
  it('updates content + name of an existing skill and flips contentOverridden', async () => {
    const ctx = makeCtx();
    await createSkillTool.execute(
      { slug: 'upd-skill-1', name: 'Upd One', content: 'original content' },
      ctx,
    );

    const result = await updateSkillTool.execute(
      { skillSlug: 'upd-skill-1', name: 'Upd One Renamed', content: 'new content body' },
      ctx,
    );
    expect(result.ok).toBe(true);

    const [row] = await db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.slug, 'upd-skill-1'), eq(agentSkills.entityId, seed.entityId)));
    expect(row!.name).toBe('Upd One Renamed');
    expect(row!.content).toBe('new content body');
    expect(row!.contentOverridden).toBe(true);
    // slug is immutable
    expect(row!.slug).toBe('upd-skill-1');
  });

  it('resolves the target by NAME (ilike), not just slug', async () => {
    const ctx = makeCtx();
    await createSkillTool.execute(
      { slug: 'upd-skill-byname', name: 'Findable By Name', content: 'x' },
      ctx,
    );
    const result = await updateSkillTool.execute(
      { skillSlug: 'findable by name', content: 'updated via name' },
      ctx,
    );
    expect(result.ok).toBe(true);
    const [row] = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'upd-skill-byname'));
    expect(row!.content).toBe('updated via name');
  });

  it('returns ok:false for a skill that does not exist', async () => {
    const result = await updateSkillTool.execute(
      { skillSlug: 'no-such-skill', content: 'whatever' },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toContain('no-such-skill');
  });

  it('returns ok:false when no updatable field is provided', async () => {
    const ctx = makeCtx();
    await createSkillTool.execute({ slug: 'upd-skill-noop', name: 'Noop', content: 'x' }, ctx);
    const result = await updateSkillTool.execute({ skillSlug: 'upd-skill-noop' }, ctx);
    expect(result.ok).toBe(false);
    // The skill was not changed.
    const [row] = await db.select().from(agentSkills).where(eq(agentSkills.slug, 'upd-skill-noop'));
    expect(row!.content).toBe('x');
  });
});

// ─── skill content linter (agnostic allowlist) ──────────────────────────────────

describe('skill content linter', () => {
  beforeAll(async () => {
    // Fixture: one MCP server in this entity → its tools form the allowlist.
    // The linter only reads slug + availableTools + active, so keep it minimal
    // (stdio, no auth fields — avoids the auth_scheme check constraint).
    await db.insert(mcpServers).values({
      entityId: seed.entityId,
      name: 'Airtable',
      slug: 'airtable',
      transport: 'stdio',
      availableTools: [{ name: 'list_records_for_table' }, { name: 'create_records_for_table' }],
      active: true,
    });
  });

  it('rejects a foreign mcp__ tool reference and writes no row', async () => {
    const result = await createSkillTool.execute(
      {
        slug: 'lint-foreign-mcp',
        name: 'Lint Foreign',
        content:
          'Call `mcp__Apify__apify--rag-web-browser` then `mcp__Claude_in_Chrome__navigate`.',
      },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toContain('mcp__Apify__apify--rag-web-browser');
    const rows = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'lint-foreign-mcp'));
    expect(rows).toHaveLength(0);
  });

  it('rejects an "mcpServers" config block', async () => {
    const result = await createSkillTool.execute(
      {
        slug: 'lint-config-block',
        name: 'Lint Config',
        content: 'Use this config: { "mcpServers": { "airtable": { "command": "npx" } } }',
      },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    const rows = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'lint-config-block'));
    expect(rows).toHaveLength(0);
  });

  it('accepts a real NodalAI MCP tool reference', async () => {
    const result = await createSkillTool.execute(
      {
        slug: 'lint-real-tool',
        name: 'Lint Real',
        content: 'Call `airtable__list_records_for_table` with the baseId, then summarise.',
      },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    const rows = await db.select().from(agentSkills).where(eq(agentSkills.slug, 'lint-real-tool'));
    expect(rows).toHaveLength(1);
  });

  it('never blocks bare snake_case (builtins / connector tools / prose)', async () => {
    const result = await createSkillTool.execute(
      {
        slug: 'lint-bare-snake',
        name: 'Lint Bare',
        content: 'Use save_memory and gmail_send. The user_id and job_search terms are fine.',
      },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    const rows = await db.select().from(agentSkills).where(eq(agentSkills.slug, 'lint-bare-snake'));
    expect(rows).toHaveLength(1);
  });

  it('also lints content on update_skill (no row change on reject)', async () => {
    const ctx = makeCtx();
    await createSkillTool.execute(
      { slug: 'lint-on-update', name: 'Lint Update', content: 'clean original' },
      ctx,
    );
    const result = await updateSkillTool.execute(
      { skillSlug: 'lint-on-update', content: 'now calls `mcp__Apify__apify--rag-web-browser`' },
      ctx,
    );
    expect(result.ok).toBe(false);
    const [row] = await db.select().from(agentSkills).where(eq(agentSkills.slug, 'lint-on-update'));
    expect(row!.content).toBe('clean original');
  });
});

// ─── attach_skill ─────────────────────────────────────────────────────────────

describe('attach_skill', () => {
  it('inserts a real agent_skill_assignments row', async () => {
    const ctx = makeCtx();

    // Create the skill first via the real flow
    const createResult = await createSkillTool.execute(
      { slug: 'assignable-skill', name: 'Assignable Skill', content: 'Assignable content' },
      ctx,
    );
    expect(createResult.ok).toBe(true);

    // Fetch the agent slug for the seeded agent
    const [agentRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, seed.agentId));
    expect(agentRow).toBeDefined();
    const agentSlug = agentRow!.slug;

    // Assign the skill
    const result = await assignSkillTool.execute({ skillSlug: 'assignable-skill', agentSlug }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.message).toContain('assignable-skill');
    expect(result.message).toContain(agentSlug);

    // Assert real DB row
    const [skillRow] = await db
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'assignable-skill'));
    expect(skillRow).toBeDefined();

    const assignments = await db
      .select()
      .from(agentSkillAssignments)
      .where(
        and(
          eq(agentSkillAssignments.skillId, skillRow!.id),
          eq(agentSkillAssignments.agentId, seed.agentId),
        ),
      );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.entityId).toBe(seed.entityId);
  });

  it('returns ok:true (idempotent) when the skill is already assigned', async () => {
    const ctx = makeCtx();

    await createSkillTool.execute(
      { slug: 'idempotent-skill', name: 'Idempotent Skill', content: 'Content' },
      ctx,
    );
    const [agentRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, seed.agentId));
    const agentSlug = agentRow!.slug;

    // First assignment
    const first = await assignSkillTool.execute({ skillSlug: 'idempotent-skill', agentSlug }, ctx);
    expect(first.ok).toBe(true);

    // Second assignment — idempotent
    const second = await assignSkillTool.execute({ skillSlug: 'idempotent-skill', agentSlug }, ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok');
    expect(second.message.toLowerCase()).toContain('already assigned');

    // Still exactly one assignment row
    const [skillRow] = await db
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'idempotent-skill'));
    const assignments = await db
      .select()
      .from(agentSkillAssignments)
      .where(
        and(
          eq(agentSkillAssignments.skillId, skillRow!.id),
          eq(agentSkillAssignments.agentId, seed.agentId),
        ),
      );
    expect(assignments).toHaveLength(1);
  });

  it('returns ok:false when the skill slug does not exist', async () => {
    const ctx = makeCtx();
    const [agentRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, seed.agentId));
    const agentSlug = agentRow!.slug;

    const result = await assignSkillTool.execute(
      { skillSlug: 'nonexistent-skill-xyz', agentSlug },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toContain('nonexistent-skill-xyz');
  });

  it('returns ok:false when the agent slug does not exist', async () => {
    const ctx = makeCtx();
    await createSkillTool.execute(
      { slug: 'skill-for-bad-agent', name: 'Skill For Bad Agent', content: 'Content' },
      ctx,
    );

    const result = await assignSkillTool.execute(
      { skillSlug: 'skill-for-bad-agent', agentSlug: 'agent-that-does-not-exist' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toContain('agent-that-does-not-exist');
  });
});

// ─── create_agent ─────────────────────────────────────────────────────────────

describe('create_agent', () => {
  it('inserts a real agents row with role=agent, orchestratorMode=null for role:worker', async () => {
    const ctx = makeCtx();
    const result = await createAgentTool.execute(
      {
        slug: 'meta-worker-agent',
        name: 'Meta Worker Agent',
        personality: 'You are a worker.',
        model: 'claude-sonnet-4-6-20260217',
        role: 'worker',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.message).toContain('meta-worker-agent');
    expect(result.message).toContain('worker');

    // Assert real DB row
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.slug, 'meta-worker-agent'), eq(agents.entityId, seed.entityId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('agent');
    expect(rows[0]!.orchestratorMode).toBeNull();
    expect(rows[0]!.entityId).toBe(seed.entityId);
  });

  it('inserts a real agents row with role=orchestrator, orchestratorMode=router for role:router', async () => {
    const ctx = makeCtx();
    const result = await createAgentTool.execute(
      {
        slug: 'meta-router-agent',
        name: 'Meta Router Agent',
        personality: 'You are a router.',
        model: 'claude-sonnet-4-6-20260217',
        role: 'router',
      },
      ctx,
    );

    expect(result.ok).toBe(true);

    const rows = await db.select().from(agents).where(eq(agents.slug, 'meta-router-agent'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('orchestrator');
    expect(rows[0]!.orchestratorMode).toBe('router');
  });

  it('inserts a real agents row with role=orchestrator, orchestratorMode=planner for role:planner', async () => {
    const ctx = makeCtx();
    const result = await createAgentTool.execute(
      {
        slug: 'meta-planner-agent',
        name: 'Meta Planner Agent',
        personality: 'You are a planner.',
        model: 'claude-sonnet-4-6-20260217',
        role: 'planner',
      },
      ctx,
    );

    expect(result.ok).toBe(true);

    const rows = await db.select().from(agents).where(eq(agents.slug, 'meta-planner-agent'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('orchestrator');
    expect(rows[0]!.orchestratorMode).toBe('planner');
  });

  it('returns ok:false with a clear error when the slug is already taken', async () => {
    const ctx = makeCtx();
    await createAgentTool.execute(
      {
        slug: 'agent-dupe-slug',
        name: 'Agent Dupe One',
        personality: 'Dup agent 1.',
        model: 'claude-sonnet-4-6-20260217',
        role: 'worker',
      },
      ctx,
    );

    const result = await createAgentTool.execute(
      {
        slug: 'agent-dupe-slug',
        name: 'Agent Dupe Two',
        personality: 'Dup agent 2.',
        model: 'claude-sonnet-4-6-20260217',
        role: 'worker',
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toContain('agent-dupe-slug');
    expect(result.error.toLowerCase()).toContain('taken');

    // Only one row
    const rows = await db.select().from(agents).where(eq(agents.slug, 'agent-dupe-slug'));
    expect(rows).toHaveLength(1);
  });

  it('message contains id on success', async () => {
    const result = await createAgentTool.execute(
      {
        slug: 'agent-with-id-check',
        name: 'Agent ID Check',
        personality: 'Test.',
        model: 'claude-sonnet-4-6-20260217',
        role: 'worker',
      },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.message).toMatch(/id [0-9a-f-]{36}/);
  });

  it('creates ROOT→worker assignment row: ctx.agentId is the caller and must appear as orchestratorId', async () => {
    const ctx = makeCtx();
    const result = await createAgentTool.execute(
      {
        slug: 'meta-worker-assigned',
        name: 'Meta Worker Assigned',
        personality: 'A worker created by ROOT.',
        model: 'claude-sonnet-4-6-20260217',
        role: 'worker',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.message).toContain('assigned to your team');

    // Fetch the newly created agent's id from the DB
    const [agentRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.slug, 'meta-worker-assigned'), eq(agents.entityId, seed.entityId)));
    expect(agentRow).toBeDefined();
    const newAgentId = agentRow!.id;

    // Assert the real agent_assignments row exists: ROOT (ctx.agentId) → new worker
    const assignments = await db
      .select()
      .from(agentAssignments)
      .where(
        and(
          eq(agentAssignments.orchestratorId, ctx.agentId),
          eq(agentAssignments.subAgentId, newAgentId),
        ),
      );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.entityId).toBe(seed.entityId);
  });
});

// ─── create_mcp ───────────────────────────────────────────────────────────────
// Verify-then-write: the server is connected + tools listed BEFORE any row is
// written. provisioning is injected by the runner; absent → fail loud.

function fakeProvisioning(opts?: {
  fail?: boolean;
  tools?: ProvisionedMcpTool[];
}): ToolProvisioning {
  return {
    async connectMcp() {
      if (opts?.fail) throw new Error('connection refused');
      return {
        tools: opts?.tools ?? [
          { name: 'search', description: 'a search tool', inputSchema: { type: 'object' } },
        ],
        close: async () => {},
      };
    },
    encrypt: (plaintext) => `enc:${plaintext}`,
  };
}

function makeCtxWith(provisioning: ToolProvisioning | undefined): ToolContext {
  return { ...makeCtx(), provisioning };
}

describe('create_mcp', () => {
  it('http: verifies then inserts a real mcp_servers row with encrypted key + discovered tools', async () => {
    const result = await createMcpTool.execute(
      {
        name: 'My HTTP MCP',
        slug: 'test-mcp-http',
        transport: 'http',
        url: 'https://mcp.example.com/sse',
        apiKey: 'sk-secret-1234',
        authScheme: 'bearer',
      },
      makeCtxWith(
        fakeProvisioning({
          tools: [
            { name: 'do_thing', description: 'does a thing', inputSchema: { type: 'object' } },
          ],
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok: ${result.error}`);

    const [row] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.entityId, seed.entityId), eq(mcpServers.slug, 'test-mcp-http')));
    expect(row).toBeDefined();
    expect(row!.transport).toBe('http');
    expect(row!.url).toBe('https://mcp.example.com/sse');
    // API key passes through encrypt() before storage (fake prefixes 'enc:');
    // last4 kept in the clear for masked UI display.
    expect(row!.apiKey).toBe('enc:sk-secret-1234');
    expect(row!.apiKeyLast4).toBe('1234');
    expect(row!.authScheme).toBe('bearer');
    // Discovered tools from the live connection are persisted WITH inputSchema
    // (the "v2" cache shape — isUsableMcpToolCache requires it on every entry
    // for the runner to take the lazy-connect path instead of eagerly
    // reconnecting on every job).
    expect(row!.availableTools).toEqual([
      { name: 'do_thing', description: 'does a thing', inputSchema: { type: 'object' } },
    ]);
  });

  it('stdio: encrypts each env value and stores command + args', async () => {
    const result = await createMcpTool.execute(
      {
        name: 'My Stdio MCP',
        slug: 'test-mcp-stdio',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'some-mcp-server'],
        env: { TOKEN: 'ghp_abc', REGION: 'eu' },
      },
      makeCtxWith(fakeProvisioning()),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok: ${result.error}`);

    const [row] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.entityId, seed.entityId), eq(mcpServers.slug, 'test-mcp-stdio')));
    expect(row).toBeDefined();
    expect(row!.transport).toBe('stdio');
    expect(row!.command).toBe('npx');
    expect(row!.args).toEqual(['-y', 'some-mcp-server']);
    expect(row!.envVars).toEqual({ TOKEN: 'enc:ghp_abc', REGION: 'enc:eu' });
  });

  it('fail-loud: a connection failure writes NO row and returns a clear error', async () => {
    const result = await createMcpTool.execute(
      {
        name: 'Broken MCP',
        slug: 'test-mcp-broken',
        transport: 'http',
        url: 'https://down.example.com',
        apiKey: 'sk-x',
        authScheme: 'bearer',
      },
      makeCtxWith(fakeProvisioning({ fail: true })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('Could not connect');

    // Crucially: no row was written for the unverified server.
    const rows = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.entityId, seed.entityId), eq(mcpServers.slug, 'test-mcp-broken')));
    expect(rows).toHaveLength(0);
  });

  it('fails loud when provisioning is unavailable (no adapter injected)', async () => {
    const result = await createMcpTool.execute(
      {
        name: 'No Provisioning',
        slug: 'test-mcp-noprov',
        transport: 'http',
        url: 'https://x.example.com',
        apiKey: 'sk-x',
        authScheme: 'bearer',
      },
      makeCtxWith(undefined),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('provisioning is not available');

    const rows = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.entityId, seed.entityId), eq(mcpServers.slug, 'test-mcp-noprov')));
    expect(rows).toHaveLength(0);
  });
});

// ─── create_connector ─────────────────────────────────────────────────────────
// Catalog-gated, api_key-only. Validates the slug against the shared catalog,
// encrypts the key, inserts. OAuth slugs + unknown slugs fail loud with no row.

describe('create_connector', () => {
  it('registers a known api_key connector with the key encrypted at rest', async () => {
    const result = await createConnectorTool.execute(
      { slug: 'apify', name: 'My Apify', apiKey: 'apify_pat_123' },
      makeCtxWith(fakeProvisioning()),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok: ${result.error}`);

    const [row] = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.entityId, seed.entityId), eq(connectors.slug, 'apify')));
    expect(row).toBeDefined();
    expect(row!.name).toBe('My Apify');
    expect(row!.authType).toBe('api_key');
    expect(row!.apiKey).toBe('enc:apify_pat_123');
  });

  it('rejects an unknown slug and writes no row', async () => {
    const result = await createConnectorTool.execute(
      { slug: 'totally-made-up', name: 'X', apiKey: 'k' },
      makeCtxWith(fakeProvisioning()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('Unknown connector slug');
    const rows = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.entityId, seed.entityId), eq(connectors.slug, 'totally-made-up')));
    expect(rows).toHaveLength(0);
  });

  it('rejects an OAuth (non-api_key) slug and writes no row', async () => {
    const result = await createConnectorTool.execute(
      { slug: 'gmail', name: 'Gmail', apiKey: 'k' },
      makeCtxWith(fakeProvisioning()),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('not api_key');
    const rows = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.entityId, seed.entityId), eq(connectors.slug, 'gmail')));
    expect(rows).toHaveLength(0);
  });

  // P0-S1 (2026-07-22 incident): create_connector was called 8x with the same
  // slug AND the same name (agent stutter — slug='tavily', name='Tavily
  // Search' every time) and inserted 8 identical duplicate rows, always
  // ok:true. It must now be idempotent on the exact (entity, slug, name)
  // triple, while still allowing legitimate multi-instance (same slug,
  // different name).
  it('a fresh (entity, slug, name) call succeeds and inserts exactly one row', async () => {
    const result = await createConnectorTool.execute(
      { slug: 'firecrawl', name: 'My Firecrawl', apiKey: 'fc-key-1' },
      makeCtxWith(fakeProvisioning()),
    );
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.entityId, seed.entityId), eq(connectors.slug, 'firecrawl')));
    expect(rows).toHaveLength(1);
  });

  it('a repeat call with the same slug AND name fails loud and writes no second row', async () => {
    const first = await createConnectorTool.execute(
      { slug: 'tavily', name: 'Tavily Search', apiKey: 'tvly-key-1' },
      makeCtxWith(fakeProvisioning()),
    );
    expect(first.ok).toBe(true);

    // Simulate the stutter: same slug, same name, same entity, called again
    // (and again) — this is the exact shape of the 8x incident.
    const second = await createConnectorTool.execute(
      { slug: 'tavily', name: 'Tavily Search', apiKey: 'tvly-key-2' },
      makeCtxWith(fakeProvisioning()),
    );
    const third = await createConnectorTool.execute(
      { slug: 'tavily', name: 'Tavily Search', apiKey: 'tvly-key-3' },
      makeCtxWith(fakeProvisioning()),
    );

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected failure');
    expect(second.error).toContain('already exists');
    expect(third.ok).toBe(false);

    const rows = await db
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.entityId, seed.entityId),
          eq(connectors.slug, 'tavily'),
          eq(connectors.name, 'Tavily Search'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.apiKey).toBe('enc:tvly-key-1');
  });

  // Regression guard: migration 0016 intentionally allows multiple connector
  // instances of the same slug per entity (e.g. two Gmail accounts). The
  // P0-S1 idempotence fix must NOT break this — a second connector with the
  // same slug but a DIFFERENT name must still succeed.
  it('multi-instance is preserved: same slug + different name both succeed', async () => {
    // Use a slug untouched by other tests in this file so the row count
    // assertion below isn't polluted by unrelated fixtures.
    const first = await createConnectorTool.execute(
      { slug: 'notion', name: 'Notion Account A', apiKey: 'notion-key-a' },
      makeCtxWith(fakeProvisioning()),
    );
    expect(first.ok).toBe(true);

    const second = await createConnectorTool.execute(
      { slug: 'notion', name: 'Notion Account B', apiKey: 'notion-key-b' },
      makeCtxWith(fakeProvisioning()),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(`expected ok: ${second.error}`);

    const rows = await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.entityId, seed.entityId), eq(connectors.slug, 'notion')));
    expect(rows).toHaveLength(2);
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(['Notion Account A', 'Notion Account B']);
  });
});

// ─── attach_agent ─────────────────────────────────────────────────────────────
// All target workers are created via createAgentRepo (bypassing create_agent
// tool) so there is no pre-existing assignment row created by create_agent's
// assignToOrchestratorId path. This keeps the tests isolated.

describe('attach_agent', () => {
  it('inserts a real agent_assignments row when resolved by slug', async () => {
    const ctx = makeCtx();

    // Create a target agent directly (no auto-assignment)
    const worker = await createAgentRepo(
      db as unknown as Parameters<typeof createAgentRepo>[0],
      seed.entityId,
      {
        slug: 'attach-target-worker',
        name: 'Attach Target Worker',
        personality: 'p',
        model: 'm',
        llmKeyId: null,
        role: 'agent',
        orchestratorMode: null,
        avatarUrl: null,
        subAgentIds: [],
      },
    );
    if (!('id' in worker)) throw new Error('worker creation failed');
    const targetId = worker.id;

    const result = await attachAgentTool.execute({ agentSlug: 'attach-target-worker' }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.message).toContain('Attach Target Worker');
    expect(result.message).toContain('sub-agent');

    // Assert real agent_assignments row: ctx.agentId → targetId
    const assignments = await db
      .select()
      .from(agentAssignments)
      .where(
        and(
          eq(agentAssignments.orchestratorId, ctx.agentId),
          eq(agentAssignments.subAgentId, targetId),
        ),
      );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.entityId).toBe(seed.entityId);
  });

  it('resolves the target by NAME (ilike)', async () => {
    const ctx = makeCtx();

    const worker = await createAgentRepo(
      db as unknown as Parameters<typeof createAgentRepo>[0],
      seed.entityId,
      {
        slug: 'attach-byname-worker',
        name: 'Attach ByName Worker',
        personality: 'p',
        model: 'm',
        llmKeyId: null,
        role: 'agent',
        orchestratorMode: null,
        avatarUrl: null,
        subAgentIds: [],
      },
    );
    if (!('id' in worker)) throw new Error('worker creation failed');
    const targetId = worker.id;

    // Pass the name (lowercased) instead of slug
    const result = await attachAgentTool.execute({ agentSlug: 'attach byname worker' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const assignments = await db
      .select()
      .from(agentAssignments)
      .where(
        and(
          eq(agentAssignments.orchestratorId, ctx.agentId),
          eq(agentAssignments.subAgentId, targetId),
        ),
      );
    expect(assignments).toHaveLength(1);
  });

  it('is idempotent: calling twice yields exactly one assignment row', async () => {
    const ctx = makeCtx();

    const worker = await createAgentRepo(
      db as unknown as Parameters<typeof createAgentRepo>[0],
      seed.entityId,
      {
        slug: 'attach-idem-worker',
        name: 'Attach Idempotent Worker',
        personality: 'p',
        model: 'm',
        llmKeyId: null,
        role: 'agent',
        orchestratorMode: null,
        avatarUrl: null,
        subAgentIds: [],
      },
    );
    if (!('id' in worker)) throw new Error('worker creation failed');
    const targetId = worker.id;

    const first = await attachAgentTool.execute({ agentSlug: 'attach-idem-worker' }, ctx);
    expect(first.ok).toBe(true);

    const second = await attachAgentTool.execute({ agentSlug: 'attach-idem-worker' }, ctx);
    expect(second.ok).toBe(true);

    // Still exactly one row
    const assignments = await db
      .select()
      .from(agentAssignments)
      .where(
        and(
          eq(agentAssignments.orchestratorId, ctx.agentId),
          eq(agentAssignments.subAgentId, targetId),
        ),
      );
    expect(assignments).toHaveLength(1);
  });

  it('returns ok:false with actionable error when agent slug does not exist', async () => {
    const ctx = makeCtx();
    const result = await attachAgentTool.execute({ agentSlug: 'no-such-agent-xyz-attach' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toContain('no-such-agent-xyz-attach');
    expect(result.error.toLowerCase()).toContain('create_agent');
  });
});

// ─── attach_mcp ───────────────────────────────────────────────────────────────

describe('attach_mcp', () => {
  it('inserts a real agent_mcp_servers row when both mcpSlug and agentSlug resolve', async () => {
    const ctx = makeCtx();
    await db.insert(mcpServers).values({
      entityId: seed.entityId,
      name: 'Attach Target MCP',
      slug: 'attach-target-mcp',
      transport: 'stdio',
      command: 'npx',
      active: true,
    });
    const [agentRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, seed.agentId));

    const result = await attachMcpTool.execute(
      { mcpSlug: 'attach-target-mcp', agentSlug: agentRow!.slug },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok: ${result.error}`);
    expect(result.message).toContain('attach-target-mcp');

    const [mcpRow] = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.slug, 'attach-target-mcp'));
    const assignments = await db
      .select()
      .from(agentMcpServers)
      .where(
        and(eq(agentMcpServers.mcpServerId, mcpRow!.id), eq(agentMcpServers.agentId, seed.agentId)),
      );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.entityId).toBe(seed.entityId);
  });

  it('unknown mcpSlug: error lists the REAL available slugs so a guessed name self-corrects', async () => {
    const ctx = makeCtx();
    // A distinct, known-good slug that must show up in the error's availability list.
    await db.insert(mcpServers).values({
      entityId: seed.entityId,
      name: 'Fetch MCP',
      slug: 'mcp-fetch',
      transport: 'stdio',
      command: 'npx',
      active: true,
    });

    // A plausible hallucination: underscore instead of hyphen (the exact
    // failure mode from the diagnosed incident — guessed from a tool-name
    // prefix like `mcp_fetch__fetch_url`). agentSlug is irrelevant here: the
    // mcpSlug lookup fails first and returns before the agent is resolved.
    const result = await attachMcpTool.execute(
      { mcpSlug: 'mcp_fetch', agentSlug: 'irrelevant-agent' },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toContain('mcp_fetch');
    expect(result.error).toContain('not found');
    expect(result.error).toContain('Available');
    // The real slug must be named verbatim so the LLM can self-correct.
    expect(result.error).toContain('mcp-fetch');
  });

  it('no MCP servers in the workspace: error says so instead of an empty "Available:" list', async () => {
    const ctx = makeCtx();
    // Fresh entity with zero mcp_servers rows.
    const [freshEntity] = await db
      .insert(entities)
      .values({
        userId: seed.userId,
        name: 'Attach MCP Empty Entity',
        slug: `attach-mcp-empty-entity-${Date.now()}`,
      })
      .returning();
    if (!freshEntity) throw new Error('failed to create fresh entity');

    const result = await attachMcpTool.execute(
      { mcpSlug: 'anything', agentSlug: 'irrelevant-agent' },
      { ...ctx, entityId: freshEntity.id },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).not.toContain('Available:');
    expect(result.error.toLowerCase()).toContain('no mcp servers exist');
    expect(result.error).toContain('create_mcp');
  });
});
