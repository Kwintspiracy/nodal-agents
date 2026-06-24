// system-prompt.test.ts — buildSystemPrompt tests

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import { agents, agentAssignments, agentSkillAssignments, agentSkills, eq } from '@nodal-agents/db';
import { buildSystemPrompt } from '../system-prompt';
import type { JobContext } from '../system-prompt';
import type { Agent, AgentId, EntityId } from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

// ─── Seed helpers ──────────────────────────────────────────────────────────────

async function seedContext(db: TestDb) {
  const [user] = await db
    .insert((await import('@nodal-agents/db')).users)
    .values({ email: `test-sp-${Date.now()}@ex.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodal-agents/db')).entities)
    .values({ userId: user!.id, name: 'T', slug: `e-sp-${Date.now()}` })
    .returning();
  return { userId: user!.id, entityId: entity!.id };
}

function makeAgent(
  id: string,
  entityId: string,
  personality: string,
  role: 'agent' | 'orchestrator' = 'agent',
  memoryTokenBudget = 0,
): Agent {
  return {
    id: id as AgentId,
    name: 'Test Agent',
    slug: 'test-agent-sp',
    role,
    personality,
    entityId: entityId as EntityId,
    model: 'claude-sonnet-4-6-20260217',
    active: true,
    orchestratorMode: null,
    memoryTokenBudget,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('includes personality verbatim (never modified)', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Agent',
        slug: `test-sp-agent-${Date.now()}`,
        personality: 'You are a precise data analyst. Never guess.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const prompt = await buildSystemPrompt(agent, db);

    expect(prompt).toContain('You are a precise data analyst. Never guess.');
  });

  it('injects the delegated sub-task discipline ONLY when the job is delegated', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Worker',
        slug: `test-sp-worker-${Date.now()}`,
        personality: 'You do tasks.',
        role: 'agent',
      })
      .returning();
    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);

    const delegated = await buildSystemPrompt(agent, db, { origin: 'telegram', isDelegated: true });
    expect(delegated).toContain('Delegated sub-task');
    expect(delegated).toContain('return_result');
    expect(delegated).toContain('Do NOT contact the user yourself');

    // A direct (non-delegated) job must NOT get the sub-agent discipline.
    const direct = await buildSystemPrompt(agent, db, { origin: 'telegram' });
    expect(direct).not.toContain('Delegated sub-task');
  });

  it('appends team block when orchestrator has children', async () => {
    const { entityId } = await seedContext(db);
    const [orchRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Orchestrator',
        slug: `test-sp-orch-${Date.now()}`,
        personality: 'You coordinate work.',
        role: 'orchestrator',
        orchestratorMode: 'planner',
      })
      .returning();

    const [workerRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Worker',
        slug: `test-sp-worker-${Date.now()}`,
        personality: 'p',
        role: 'agent',
      })
      .returning();

    await db.insert(agentAssignments).values({
      orchestratorId: orchRow!.id,
      subAgentId: workerRow!.id,
      entityId,
    });

    const agent = makeAgent(orchRow!.id, entityId, orchRow!.personality, 'orchestrator');
    agent.orchestratorMode = 'planner';
    const prompt = await buildSystemPrompt(agent, db);

    expect(prompt).toContain('You coordinate work.'); // personality preserved
    expect(prompt).toContain('Your team'); // team block appended
    expect(prompt).toContain('SP Worker'); // from DB
  });

  it('honours {{team}} placeholder in personality', async () => {
    const { entityId } = await seedContext(db);
    const [orchRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Orch Placeholder',
        slug: `test-sp-orch-ph-${Date.now()}`,
        personality: 'You coordinate.\n\n{{team}}\n\nEnd of personality.',
        role: 'orchestrator',
        orchestratorMode: 'planner',
      })
      .returning();

    const [workerRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Worker PH',
        slug: `test-sp-worker-ph-${Date.now()}`,
        personality: 'p',
        role: 'agent',
      })
      .returning();

    await db.insert(agentAssignments).values({
      orchestratorId: orchRow!.id,
      subAgentId: workerRow!.id,
      entityId,
    });

    const agent = makeAgent(orchRow!.id, entityId, orchRow!.personality, 'orchestrator');
    agent.orchestratorMode = 'planner';
    const prompt = await buildSystemPrompt(agent, db);

    // {{team}} replaced, not appended at end
    expect(prompt).not.toContain('{{team}}');
    expect(prompt).toContain('Your team');
    expect(prompt).toContain('End of personality.');
    // The team block should appear BEFORE "End of personality." (inline replacement)
    const teamIdx = prompt.indexOf('Your team');
    const endIdx = prompt.indexOf('End of personality.');
    expect(teamIdx).toBeLessThan(endIdx);
  });

  it('includes skills metadata block when agent has skills', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Skills Agent',
        slug: `test-sp-skills-${Date.now()}`,
        personality: 'You use tools.',
        role: 'agent',
      })
      .returning();

    const skillContent =
      'When asked to read or write a Google Sheet, use the gsheets_read or gsheets_write tool with the spreadsheet ID from the request.';
    const skillDescription = 'Read and write Google Sheets by spreadsheet ID.';
    const slug = `google-sheets-sp-${Date.now()}`;
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId,
        name: 'Google Sheets',
        slug,
        description: skillDescription,
        content: skillContent,
      })
      .returning();

    await db.insert(agentSkillAssignments).values({
      entityId,
      agentId: agentRow!.id,
      skillId: skill!.id,
    });

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const prompt = await buildSystemPrompt(agent, db);

    // Progressive disclosure: the prompt carries a COMPACT INDEX (slug + the
    // one-line description + a skill_view call), NOT the full SKILL.md body.
    // The full content loads on demand via skill_view — it must NOT be dumped here.
    expect(prompt).toContain('## Skills (load before acting)');
    expect(prompt).toContain(`skill_view('${slug}')`);
    expect(prompt).toContain(skillDescription);
    // Anti-reimplement steering is present.
    expect(prompt).toMatch(/NEVER reimplement/i);
    // The FULL body is NOT front-loaded anymore (the whole point of the change).
    expect(prompt).not.toContain(skillContent);
    // The legacy "Your available adapters" header is gone.
    expect(prompt).not.toContain('Your available adapters');
  });

  it('no team block for worker agent', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Pure Worker',
        slug: `test-sp-pure-worker-${Date.now()}`,
        personality: 'You execute tasks.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const prompt = await buildSystemPrompt(agent, db);

    // No team block for a pure worker
    expect(prompt).not.toContain('Your team');
    expect(prompt).toContain('You execute tasks.'); // personality preserved
  });

  // ─── Brique 31: jobContext block tests ─────────────────────────────────────

  it('appends ## Job context block with telegramChatId when jobContext is provided', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP JC Agent',
        slug: `test-sp-jc-${Date.now()}`,
        personality: 'You use context.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const jobContext: JobContext = { origin: 'telegram', telegramChatId: '99887766' };
    const prompt = await buildSystemPrompt(agent, db, jobContext);

    expect(prompt).toContain('## Job context');
    expect(prompt).toContain('- origin: telegram');
    expect(prompt).toContain('- telegram_chat_id: 99887766');
  });

  it('appends ## Job context with origin only when telegramChatId is absent', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP JC No Chat Agent',
        slug: `test-sp-jc-nochat-${Date.now()}`,
        personality: 'You use context.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const jobContext: JobContext = { origin: 'api' };
    const prompt = await buildSystemPrompt(agent, db, jobContext);

    expect(prompt).toContain('## Job context');
    expect(prompt).toContain('- origin: api');
    expect(prompt).not.toContain('telegram_chat_id');
  });

  it('surfaces a notify_on_success directive when the schedule opted into a confirmation', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Notify Agent',
        slug: `test-sp-notify-${Date.now()}`,
        personality: 'You run scheduled tasks.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const jobContext: JobContext = {
      origin: 'cron',
      telegramChatId: '12345',
      notifyOnSuccess: true,
    };
    const prompt = await buildSystemPrompt(agent, db, jobContext);

    expect(prompt).toContain('## Job context');
    expect(prompt).toContain('- notify_on_success: true');
    // It instructs delivery before finishing — the agent writes the text itself.
    expect(prompt).toContain('return_result');
  });

  it('omits the notify_on_success directive when the flag is absent', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP No Notify Agent',
        slug: `test-sp-nonotify-${Date.now()}`,
        personality: 'You run scheduled tasks.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const prompt = await buildSystemPrompt(agent, db, { origin: 'cron' });
    expect(prompt).not.toContain('notify_on_success');
  });

  it('does NOT include ## Job context when jobContext is not provided', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP No JC Agent',
        slug: `test-sp-nojc-${Date.now()}`,
        personality: 'You are standalone.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const prompt = await buildSystemPrompt(agent, db);

    expect(prompt).not.toContain('## Job context');
  });
});

// ─── Sprint 2 — Persistent memory auto-injection ──────────────────────────────

describe('buildSystemPrompt — persistent memory auto-injection', () => {
  it('does NOT include ## Persistent memory when budget is 0', async () => {
    const { entityId } = await seedContext(db);
    const { agentMemory } = await import('@nodal-agents/db');
    await db.insert(agentMemory).values({
      entityId,
      fact: 'fact-not-injected',
      category: 'context',
      importance: 5,
      source: 'agent',
    });
    const [row] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Mem Off Agent',
        slug: `test-sp-memoff-${Date.now()}`,
        personality: 'You are silent on memory.',
        role: 'agent',
      })
      .returning();
    const agent = makeAgent(row!.id, entityId, row!.personality, 'agent', 0);
    const prompt = await buildSystemPrompt(agent, db);
    expect(prompt).not.toContain('## Persistent memory');
  });

  it('injects ## Persistent memory block when budget > 0 and memories exist', async () => {
    const { entityId } = await seedContext(db);
    const { agentMemory } = await import('@nodal-agents/db');
    await db.insert(agentMemory).values([
      {
        entityId,
        fact: 'user prefers TypeScript strict mode',
        category: 'preference',
        importance: 5,
        source: 'agent',
      },
      {
        entityId,
        fact: 'project uses pnpm workspaces',
        category: 'context',
        importance: 4,
        source: 'agent',
      },
    ]);
    const [row] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Mem On Agent',
        slug: `test-sp-memon-${Date.now()}`,
        personality: 'You answer briefly.',
        role: 'agent',
      })
      .returning();
    const agent = makeAgent(row!.id, entityId, row!.personality, 'agent', 1500);
    const prompt = await buildSystemPrompt(agent, db);
    expect(prompt).toContain('## Persistent memory');
    expect(prompt).toContain('user prefers TypeScript strict mode');
    expect(prompt).toContain('project uses pnpm workspaces');
    // Higher-importance fact appears first
    const idxA = prompt.indexOf('user prefers TypeScript strict mode');
    const idxB = prompt.indexOf('project uses pnpm workspaces');
    expect(idxA).toBeLessThan(idxB);
  });

  it('respects the budget — high-cost memories are skipped when they overflow', async () => {
    const { entityId } = await seedContext(db);
    const { agentMemory } = await import('@nodal-agents/db');
    // 1000-char fact is too big for a 100-char budget; the small one fits.
    await db.insert(agentMemory).values([
      {
        entityId,
        fact: 'X'.repeat(1000),
        category: 'context',
        importance: 5,
        source: 'agent',
      },
      {
        entityId,
        fact: 'tiny',
        category: 'context',
        importance: 4,
        source: 'agent',
      },
    ]);
    const [row] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Mem Budget Agent',
        slug: `test-sp-membudget-${Date.now()}`,
        personality: 'You answer briefly.',
        role: 'agent',
      })
      .returning();
    const agent = makeAgent(row!.id, entityId, row!.personality, 'agent', 100);
    const prompt = await buildSystemPrompt(agent, db);
    expect(prompt).toContain('## Persistent memory');
    expect(prompt).toContain('tiny');
    expect(prompt).not.toContain('XXXXXXXX'); // big fact skipped
  });

  it('skips archived and expired memories', async () => {
    const { entityId } = await seedContext(db);
    const { agentMemory } = await import('@nodal-agents/db');
    await db.insert(agentMemory).values([
      {
        entityId,
        fact: 'archived-secret-never-shown',
        category: 'context',
        importance: 5,
        source: 'agent',
        archived: true,
      },
      {
        entityId,
        fact: 'expired-secret-never-shown',
        category: 'context',
        importance: 5,
        source: 'agent',
        validTo: new Date(Date.now() - 24 * 60 * 60 * 1000), // yesterday
      },
      {
        entityId,
        fact: 'live-fact-always-shown',
        category: 'context',
        importance: 3,
        source: 'agent',
      },
    ]);
    const [row] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Mem Live Agent',
        slug: `test-sp-memlive-${Date.now()}`,
        personality: 'P',
        role: 'agent',
      })
      .returning();
    const agent = makeAgent(row!.id, entityId, row!.personality, 'agent', 1500);
    const prompt = await buildSystemPrompt(agent, db);
    expect(prompt).toContain('live-fact-always-shown');
    expect(prompt).not.toContain('archived-secret-never-shown');
    expect(prompt).not.toContain('expired-secret-never-shown');
  });
});

// ─── Learning-loop Phase A — last_used_at touch ───────────────────────────────

describe('buildSystemPrompt — last_used_at learning loop', () => {
  it('bumps last_used_at on all injected skills after buildSystemPrompt resolves', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP LastUsed Agent',
        slug: `test-sp-lastused-${Date.now()}`,
        personality: 'You track skill usage.',
        role: 'agent',
      })
      .returning();

    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId,
        name: `LastUsed Skill ${Date.now()}`,
        slug: `lastused-skill-${Date.now()}`,
        content: 'Use this skill to track usage.',
      })
      .returning();

    await db.insert(agentSkillAssignments).values({
      entityId,
      agentId: agentRow!.id,
      skillId: skill!.id,
    });

    // Confirm last_used_at starts NULL
    const [before] = await db
      .select({ lastUsedAt: agentSkills.lastUsedAt })
      .from(agentSkills)
      .where(eq(agentSkills.id, skill!.id));
    expect(before!.lastUsedAt).toBeNull();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    await buildSystemPrompt(agent, db);

    // The fire-and-forget promise is already in the microtask queue after await
    // buildSystemPrompt(). Yield once to let it settle before reading back.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [after] = await db
      .select({ lastUsedAt: agentSkills.lastUsedAt })
      .from(agentSkills)
      .where(eq(agentSkills.id, skill!.id));

    // last_used_at must be a real Date now — not null
    expect(after!.lastUsedAt).not.toBeNull();
    expect(after!.lastUsedAt).toBeInstanceOf(Date);
  });

  it('does NOT touch last_used_at when the agent has no assigned skills', async () => {
    const { entityId } = await seedContext(db);

    // A free-standing skill with no assignment
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId,
        name: `Unassigned Skill ${Date.now()}`,
        slug: `unassigned-skill-${Date.now()}`,
        content: 'Never used by this agent.',
      })
      .returning();

    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP NoSkills Agent',
        slug: `test-sp-noskills-${Date.now()}`,
        personality: 'You have no skills.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    await buildSystemPrompt(agent, db);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The unassigned skill should remain untouched
    const [after] = await db
      .select({ lastUsedAt: agentSkills.lastUsedAt })
      .from(agentSkills)
      .where(eq(agentSkills.id, skill!.id));

    expect(after!.lastUsedAt).toBeNull();
  });
});
