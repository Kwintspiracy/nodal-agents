// curator.test.ts — Tier-2 CURATOR (learning-loop Phase C).
//
// All assertions on real DB state (agent_skills rows, entities rows).
// The LLM consolidation model is mocked via the same createLlmClient interception
// pattern as reflection.test.ts.
//
// Coverage:
//   1. transitionSkillLifecycle: agent skill with old last_used_at → active→stale→archived
//   2. transitionSkillLifecycle: stale agent skill recently used → reactivated
//   3. transitionSkillLifecycle: USER skill with old timestamp → UNCHANGED
//   4. archiveAgentSkill: agent skill → archived (state + archived_at set)
//   5. archiveAgentSkill: user skill → refused (row unchanged)
//   6. runCuratorTick: deterministic transitions always run (REFLECTION_ENABLED=false)
//   7. runCuratorTick: LLM consolidation SKIPPED when REFLECTION_ENABLED=false
//   8. runCuratorTick: first-run-deferred (last_curator_run_at NULL → set to now, no LLM)
//   9. runCuratorTick: mock LLM archives two narrow + creates umbrella → assert state

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  and,
  agentSkills,
  entities,
  transitionSkillLifecycle,
  archiveAgentSkill,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import { _resetEnvCache } from '../../env.ts';
import { runCuratorTick } from '../../cron/run-curator.ts';

// ── createLlmClient interception (same as reflection.test) ────────────────────
const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _active,
    setActiveLlmClient: (c: RunnerDeps['llmClient'] | null) => { _active = c; },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('curator.test: no active LLM client set');
      return active;
    },
  };
});

// ── Scripted mock LLM ──────────────────────────────────────────────────────────
type ScriptedTurn = {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
};

function makeScriptedClient(turns: ScriptedTurn[]): RunnerDeps['llmClient'] {
  let i = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const t = turns[i] ?? turns[turns.length - 1] ?? {};
      i += 1;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (t.text) content.push({ type: 'text', text: t.text });
      for (const tc of t.toolCalls ?? [])
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      const isTools = (t.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: isTools
          ? { unified: 'tool-calls' as const, raw: 'tool-calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >,
    streamText: () => { throw new Error('streamText not supported in mock'); },
    generateObject: () => { throw new Error('generateObject not supported in mock'); },
  };
}

// ── Test fixtures ──────────────────────────────────────────────────────────────
let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

function makeDeps(llmClient: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(llmClient);
  return {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

function makeNoopDeps(): RunnerDeps {
  return makeDeps(makeScriptedClient([{}]));
}

/** Helper to set last_used_at to a past date on a skill (simulate age). */
async function ageSkill(skillId: string, daysAgo: number) {
  const past = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await db.update(agentSkills).set({ lastUsedAt: past, createdAt: past, updatedAt: past }).where(eq(agentSkills.id, skillId));
}

/** Build a minimal RunnerEnv for curator tick calls (all curator-relevant fields set). */
function makeCuratorEnv(overrides: {
  reflectionEnabled?: string;
  curatorMinSkills?: number;
  curatorIntervalDays?: number;
} = {}): Parameters<typeof runCuratorTick>[2] {
  return {
    DATABASE_URL: 'test://local',
    EMBEDDING_PROVIDER: 'keyword',
    AUTH_MODE: 'local-trust',
    WORKER_SECRET: '',
    PORT: 3001,
    BIND: '127.0.0.1',
    APP_URL: 'http://localhost:3001',
    NODE_ENV: 'test',
    REFLECTION_ENABLED: overrides.reflectionEnabled ?? 'false',
    REFLECTION_MIN_TURNS: 3,
    REFLECTION_MAX_PER_HOUR: 6,
    REFLECTION_MAX_TURNS: 3,
    CURATOR_STALE_DAYS: 30,
    CURATOR_ARCHIVE_DAYS: 90,
    CURATOR_MIN_SKILLS: overrides.curatorMinSkills ?? 5,
    CURATOR_INTERVAL_DAYS: overrides.curatorIntervalDays ?? 7,
    CURATOR_MAX_TURNS: 4,
  } as Parameters<typeof runCuratorTick>[2];
}

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

afterAll(() => {
  setActiveLlmClient(null);
  delete process.env['DATABASE_URL'];
  delete process.env['REFLECTION_ENABLED'];
  delete process.env['CURATOR_STALE_DAYS'];
  delete process.env['CURATOR_ARCHIVE_DAYS'];
  delete process.env['CURATOR_MIN_SKILLS'];
  delete process.env['CURATOR_INTERVAL_DAYS'];
  delete process.env['CURATOR_MAX_TURNS'];
  _resetEnvCache();
});

beforeEach(async () => {
  process.env['DATABASE_URL'] = 'test://local';
  process.env['REFLECTION_ENABLED'] = 'false';
  process.env['CURATOR_STALE_DAYS'] = '30';
  process.env['CURATOR_ARCHIVE_DAYS'] = '90';
  process.env['CURATOR_MIN_SKILLS'] = '5';
  process.env['CURATOR_INTERVAL_DAYS'] = '7';
  process.env['CURATOR_MAX_TURNS'] = '4';
  _resetEnvCache();

  // Phase D: runCuratorTick Phase 2 filters by entities.reflection_enabled=true.
  // Reset the test entity to enabled=true before each test so tests 8+9 (which
  // pass reflectionEnabled='true' in makeCuratorEnv) find a candidate entity.
  // Test 10 overrides this to false explicitly.
  await db.update(entities).set({ reflectionEnabled: true }).where(eq(entities.id, seed.entityId));
});

// ── 1. Lifecycle: active→stale→archived ────────────────────────────────────────
describe('curator — transitionSkillLifecycle: active→stale→archived', () => {
  it('transitions an agent skill: active→stale after staleDays, then stale→archived after archiveDays', async () => {
    const ts = Date.now();
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `lc-stale-${ts}`,
        name: `LC Stale ${ts}`,
        content: 'agent created skill',
        createdBy: 'agent',
        state: 'active',
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');

    // Simulate: last_used_at 40 days ago (> staleDays=30)
    await ageSkill(skill.id, 40);

    const r1 = await transitionSkillLifecycle(db, { staleDays: 30, archiveDays: 90 });
    expect(r1.staled).toBeGreaterThanOrEqual(1);

    const [after1] = await db.select().from(agentSkills).where(eq(agentSkills.id, skill.id));
    expect(after1!.state).toBe('stale');
    expect(after1!.archivedAt).toBeNull();

    // Simulate: last_used_at 100 days ago (> archiveDays=90)
    await ageSkill(skill.id, 100);

    const r2 = await transitionSkillLifecycle(db, { staleDays: 30, archiveDays: 90 });
    expect(r2.archived).toBeGreaterThanOrEqual(1);

    const [after2] = await db.select().from(agentSkills).where(eq(agentSkills.id, skill.id));
    expect(after2!.state).toBe('archived');
    expect(after2!.archivedAt).not.toBeNull();
  });
});

// ── 2. Lifecycle: reactivation ─────────────────────────────────────────────────
describe('curator — transitionSkillLifecycle: reactivation', () => {
  it('reactivates a stale agent skill that was recently used', async () => {
    const ts = Date.now();
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `lc-reactivate-${ts}`,
        name: `LC Reactivate ${ts}`,
        content: 'agent created skill',
        createdBy: 'agent',
        state: 'stale',
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');

    // Set last_used_at to YESTERDAY (within staleDays=30)
    const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await db.update(agentSkills).set({ lastUsedAt: yesterday }).where(eq(agentSkills.id, skill.id));

    const r = await transitionSkillLifecycle(db, { staleDays: 30, archiveDays: 90 });
    expect(r.reactivated).toBeGreaterThanOrEqual(1);

    const [after] = await db.select().from(agentSkills).where(eq(agentSkills.id, skill.id));
    expect(after!.state).toBe('active');
  });
});

// ── 3. Lifecycle: USER skills NEVER touched ────────────────────────────────────
describe('curator — transitionSkillLifecycle: user skills unchanged', () => {
  it('does NOT transition a user-owned skill even if it has an old timestamp', async () => {
    const ts = Date.now();
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `lc-user-${ts}`,
        name: `LC User ${ts}`,
        content: 'user created skill',
        createdBy: 'user',
        state: 'active',
      })
      .returning();
    if (!skill) throw new Error('failed to seed user skill');

    // Simulate: very old last_used_at
    await ageSkill(skill.id, 365);

    await transitionSkillLifecycle(db, { staleDays: 30, archiveDays: 90 });

    // State MUST be unchanged
    const [after] = await db.select().from(agentSkills).where(eq(agentSkills.id, skill.id));
    expect(after!.state).toBe('active');
    expect(after!.createdBy).toBe('user');
  });
});

// ── 4. archiveAgentSkill: agent skill → archived ───────────────────────────────
describe('curator — archiveAgentSkill: agent skill soft-archived', () => {
  it('sets state=archived and archived_at on an agent-authored skill', async () => {
    const ts = Date.now();
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `archive-agent-${ts}`,
        name: `Archive Agent ${ts}`,
        content: 'agent skill to archive',
        createdBy: 'agent',
        state: 'active',
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');

    const res = await archiveAgentSkill(db, seed.entityId, skill.id);
    expect(res).toEqual({ ok: true });

    const [after] = await db.select().from(agentSkills).where(eq(agentSkills.id, skill.id));
    expect(after!.state).toBe('archived');
    expect(after!.archivedAt).not.toBeNull();
  });
});

// ── 5. archiveAgentSkill: user skill → refused ────────────────────────────────
describe('curator — archiveAgentSkill: user skill refused', () => {
  it('returns { error: not_agent_skill } and leaves the row unchanged', async () => {
    const ts = Date.now();
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `archive-user-${ts}`,
        name: `Archive User ${ts}`,
        content: 'user skill, must not be archived',
        createdBy: 'user',
        state: 'active',
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');

    const res = await archiveAgentSkill(db, seed.entityId, skill.id);
    expect(res).toEqual({ error: 'not_agent_skill' });

    // Row unchanged
    const [after] = await db.select().from(agentSkills).where(eq(agentSkills.id, skill.id));
    expect(after!.state).toBe('active');
    expect(after!.archivedAt).toBeNull();
    expect(after!.createdBy).toBe('user');
  });
});

// ── 6+7. runCuratorTick: deterministic transitions always run; LLM skipped when disabled ──
describe('curator — runCuratorTick: deterministic transitions run, LLM skipped when disabled', () => {
  it('returns lifecycle counts even when REFLECTION_ENABLED=false (no LLM)', async () => {
    const ts = Date.now();
    // Seed an agent skill that should go stale
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `tick-stale-${ts}`,
        name: `Tick Stale ${ts}`,
        content: 'agent skill',
        createdBy: 'agent',
        state: 'active',
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');
    await ageSkill(skill.id, 40); // > CURATOR_STALE_DAYS=30

    const deps = makeNoopDeps();
    const result = await runCuratorTick(db, deps, makeCuratorEnv({ reflectionEnabled: 'false' }));

    expect(result.staled).toBeGreaterThanOrEqual(1);
    // LLM consolidation disabled → must be 0
    expect(result.consolidationRan).toBe(0);
    expect(result.consolidationDeferred).toBe(0);

    const [after] = await db.select().from(agentSkills).where(eq(agentSkills.id, skill.id));
    expect(after!.state).toBe('stale');
  });
});

// ── 8. First-run-deferred ──────────────────────────────────────────────────────
describe('curator — runCuratorTick: first-run-deferred', () => {
  it('when last_curator_run_at IS NULL, stamps now and skips LLM (no consolidation this tick)', async () => {
    const ts = Date.now();
    // Need >= CURATOR_MIN_SKILLS=2 (use 3 for test speed) agent active skills
    for (let i = 0; i < 3; i++) {
      await db.insert(agentSkills).values({
        entityId: seed.entityId,
        slug: `deferred-skill-${ts}-${i}`,
        name: `Deferred Skill ${ts} ${i}`,
        content: 'agent skill for deferred test',
        createdBy: 'agent',
        state: 'active',
      });
    }

    // Ensure last_curator_run_at IS NULL on the entity
    await db.update(entities).set({ lastCuratorRunAt: null }).where(eq(entities.id, seed.entityId));

    // Track whether LLM was called (it should NOT be on first run)
    let llmCallCount = 0;
    const baseClient = makeScriptedClient([
      {
        // If the LLM is called, it tries to create a skill (so we can detect it)
        toolCalls: [
          {
            toolCallId: 'x1',
            toolName: 'create_skill',
            args: { slug: `should-not-be-called-${ts}`, name: 'Should not exist', content: 'x' },
          },
        ],
      },
    ]);
    const wrappedClient: RunnerDeps['llmClient'] = {
      ...baseClient,
      generateText: (...args) => {
        llmCallCount += 1;
        return baseClient.generateText(...args);
      },
    };
    const deps = makeDeps(wrappedClient);

    const result = await runCuratorTick(
      db,
      deps,
      makeCuratorEnv({ reflectionEnabled: 'true', curatorMinSkills: 2, curatorIntervalDays: 7 }),
    );

    // First-run-deferred: LLM NOT called
    expect(llmCallCount).toBe(0);
    expect(result.consolidationDeferred).toBeGreaterThanOrEqual(1);
    expect(result.consolidationRan).toBe(0);

    // last_curator_run_at was stamped
    const [entityRow] = await db
      .select({ lastCuratorRunAt: entities.lastCuratorRunAt })
      .from(entities)
      .where(eq(entities.id, seed.entityId));
    expect(entityRow!.lastCuratorRunAt).not.toBeNull();
  });
});

// ── 9. Mock LLM consolidation ─────────────────────────────────────────────────
describe('curator — runCuratorTick: mock LLM consolidation', () => {
  it('mock LLM archives 2 narrow + creates 1 umbrella; user skill in set is untouched', async () => {
    const ts = Date.now();

    // Seed 2 narrow agent skills + 1 user skill
    const [narrow1] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `narrow-a-${ts}`,
        name: `Narrow A ${ts}`,
        content: 'narrow agent skill A',
        createdBy: 'agent',
        state: 'active',
      })
      .returning();
    const [narrow2] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `narrow-b-${ts}`,
        name: `Narrow B ${ts}`,
        content: 'narrow agent skill B',
        createdBy: 'agent',
        state: 'active',
      })
      .returning();
    const [userSkill] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `user-safe-${ts}`,
        name: `User Safe ${ts}`,
        content: 'user skill, must not be archived',
        createdBy: 'user',
        state: 'active',
      })
      .returning();
    if (!narrow1 || !narrow2 || !userSkill) throw new Error('failed to seed skills');

    // Set last_curator_run_at to 8 days ago (> CURATOR_INTERVAL_DAYS=7) to trigger run
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.update(entities).set({ lastCuratorRunAt: eightDaysAgo }).where(eq(entities.id, seed.entityId));

    const umbrellaSeed = `umbrella-${ts}`;

    const deps = makeDeps(
      makeScriptedClient([
        // Turn 1: create umbrella, archive narrow1, archive narrow2
        {
          toolCalls: [
            {
              toolCallId: 'c1',
              toolName: 'create_skill',
              args: {
                slug: umbrellaSeed,
                name: `Umbrella ${ts}`,
                content: 'merged content of A and B',
                description: 'Umbrella for narrow A and B',
              },
            },
            {
              toolCallId: 'c2',
              toolName: 'archive_skill',
              args: { skillId: narrow1.id },
            },
            {
              toolCallId: 'c3',
              toolName: 'archive_skill',
              args: { skillId: narrow2.id },
            },
          ],
        },
        // Turn 2: no-op → stop
        {},
      ]),
    );

    const result = await runCuratorTick(
      db,
      deps,
      makeCuratorEnv({ reflectionEnabled: 'true', curatorMinSkills: 2, curatorIntervalDays: 7 }),
    );

    expect(result.consolidationRan).toBeGreaterThanOrEqual(1);

    // Umbrella skill created with created_by='agent'
    const [umbrella] = await db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.slug, umbrellaSeed), eq(agentSkills.entityId, seed.entityId)));
    expect(umbrella).toBeDefined();
    expect(umbrella!.createdBy).toBe('agent');

    // narrow1 and narrow2 are archived
    const [r1] = await db.select().from(agentSkills).where(eq(agentSkills.id, narrow1.id));
    const [r2] = await db.select().from(agentSkills).where(eq(agentSkills.id, narrow2.id));
    expect(r1!.state).toBe('archived');
    expect(r2!.state).toBe('archived');

    // User skill is untouched
    const [rUser] = await db.select().from(agentSkills).where(eq(agentSkills.id, userSkill.id));
    expect(rUser!.state).toBe('active');
    expect(rUser!.createdBy).toBe('user');
  });
});

// ── 11. Regression: REFLECTION_ENABLED='' (unset/empty = per-entity decides) ───
// This test FAILS against the old run-curator.ts where the gate was
// `REFLECTION_ENABLED !== 'true'` (empty string !== 'true' → early return → deferred 0).
// After the fix (`=== 'false'`), empty string passes the gate → per-entity decides → deferred 1.
describe('curator — runCuratorTick: REFLECTION_ENABLED empty (unset) passes gate when entity opt-in = true', () => {
  it('first-run-deferred === 1 when REFLECTION_ENABLED is empty string and entity.reflection_enabled=true', async () => {
    const ts = Date.now();

    // Seed >= CURATOR_MIN_SKILLS=2 agent-created ACTIVE skills
    for (let i = 0; i < 3; i++) {
      await db.insert(agentSkills).values({
        entityId: seed.entityId,
        slug: `regression-empty-env-${ts}-${i}`,
        name: `Regression Empty Env ${ts} ${i}`,
        content: 'agent skill for empty-env regression',
        createdBy: 'agent',
        state: 'active',
      });
    }

    // beforeEach already sets reflection_enabled=true and lastCuratorRunAt to
    // whatever the entity has — explicitly NULL it so first-run-deferred fires.
    await db.update(entities).set({ lastCuratorRunAt: null }).where(eq(entities.id, seed.entityId));

    // Pass REFLECTION_ENABLED: '' (empty string — the new default when env is unset).
    // Old gate: '' !== 'true' → early-return → consolidationDeferred=0  (BUG)
    // New gate: '' === 'false' is false → proceeds → deferred=1          (FIXED)
    const result = await runCuratorTick(
      db,
      makeNoopDeps(),
      makeCuratorEnv({ reflectionEnabled: '', curatorMinSkills: 2, curatorIntervalDays: 7 }),
    );

    expect(result.consolidationDeferred).toBeGreaterThanOrEqual(1);
    expect(result.consolidationRan).toBe(0); // first-run-deferred: LLM not yet called

    // last_curator_run_at was stamped (confirms deferral path executed)
    const [entityRow] = await db
      .select({ lastCuratorRunAt: entities.lastCuratorRunAt })
      .from(entities)
      .where(eq(entities.id, seed.entityId));
    expect(entityRow!.lastCuratorRunAt).not.toBeNull();
  });
});

// ── 10. Curator: only processes entities with reflection_enabled=true ──────────
describe('curator — runCuratorTick: only reflection_enabled entities get LLM consolidation', () => {
  it('skips LLM consolidation for entity with reflection_enabled=false', async () => {
    const ts = Date.now();

    // Ensure entity has reflection_enabled=false
    await db
      .update(entities)
      .set({ reflectionEnabled: false })
      .where(eq(entities.id, seed.entityId));

    // Seed enough active agent skills
    for (let i = 0; i < 3; i++) {
      await db.insert(agentSkills).values({
        entityId: seed.entityId,
        slug: `curator-disabled-${ts}-${i}`,
        name: `Curator Disabled ${ts} ${i}`,
        content: 'agent skill',
        createdBy: 'agent',
        state: 'active',
      });
    }

    // Set last_curator_run_at to 8 days ago to trigger consolidation if enabled
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.update(entities).set({ lastCuratorRunAt: eightDaysAgo }).where(eq(entities.id, seed.entityId));

    let llmCallCount = 0;
    const baseClient = makeScriptedClient([{}]);
    const wrappedClient: RunnerDeps['llmClient'] = {
      ...baseClient,
      generateText: (...args) => {
        llmCallCount += 1;
        return baseClient.generateText(...args);
      },
    };
    const deps = makeDeps(wrappedClient);

    const result = await runCuratorTick(
      db,
      deps,
      makeCuratorEnv({ reflectionEnabled: 'true', curatorMinSkills: 2, curatorIntervalDays: 7 }),
    );

    // Entity has reflection_enabled=false → LLM consolidation must NOT run for it
    expect(llmCallCount).toBe(0);
    expect(result.consolidationRan).toBe(0);
  });
});
