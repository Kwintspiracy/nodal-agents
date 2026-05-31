// meta-ops.test.ts — unit tests for create_skill, attach_skill, create_agent tools.
// Uses a real pglite in-memory DB via @nodal-agents/db/test-utils.
// Asserts on real DB rows — never call counts. (CLAUDE.md invariant 5)

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentSkills, agentSkillAssignments, agents, mcpServers, eq, and } from '@nodal-agents/db';
import type { TestDb } from '@nodal-agents/db/test-utils';
import type { ToolContext } from '../../types';
import { createSkillTool } from './create-skill';
import { updateSkillTool } from './update-skill';
import { assignSkillTool } from './assign-skill';
import { createAgentTool } from './create-agent';

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
});
