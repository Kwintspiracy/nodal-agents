// reflection.test.ts — Tier-1 reflection pass (learning-loop Phase B).
//
// Asserts on REAL DB rows (agent_skills) — never call counts (CLAUDE.md
// invariant 5). The reflection LLM is mocked by intercepting createLlmClient
// (the same path resolveAgentLlmClient takes to build the agent's client), so
// each test scripts exactly what the reflection model "decides" to do.
//
// Coverage:
//   1. happy path create  → agent_skills row, created_by='agent'
//   2. happy path patch   → patch_count incremented + created_by='agent'
//   3. gate: disabled (REFLECTION_ENABLED=false) → no write
//   4. gate: trivial job (turn<MIN) → no reflection
//   5. gate: failed job (status!='completed') → no reflection
//   6. gate: recursion (channel='reflection') → no reflection
//   7. gate: chat (channel='chat') → no reflection
//   8. gate: throttle (>MAX_PER_HOUR/h) → skipped
//   9. anti-lesson prompt contains the verbatim clauses
//  10. non-blocking: executeJob completes WITHOUT awaiting reflection

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and, agentJobs, agentSkills, agentSkillAssignments } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import { _resetEnvCache } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import { maybeRunReflection } from '../../reflection/index.ts';
import { ANTI_LESSON_FILTER, buildReflectionSystemPrompt } from '../../reflection/prompt.ts';
import { _resetReflectionThrottle } from '../../reflection/throttle.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ── createLlmClient interception (mirrors root-meta-tools.test) ────────────────
const { getActiveLlmClient, setActiveLlmClient, recordLlmArgs, getLastLlmConfig, resetLastLlmConfig } = vi.hoisted(() => {
  let _active: RunnerDeps['llmClient'] | null = null;
  // Captures the ProviderConfig passed to createLlmClient so tests can assert
  // which model flowed through the resolution path.
  let _lastConfig: { provider: string; model: string } | null = null;
  return {
    getActiveLlmClient: () => _active,
    setActiveLlmClient: (c: RunnerDeps['llmClient'] | null) => { _active = c; },
    recordLlmArgs: (cfg: { provider: string; model: string }) => { _lastConfig = cfg; },
    getLastLlmConfig: () => _lastConfig,
    resetLastLlmConfig: () => { _lastConfig = null; },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (...args: Parameters<typeof actual.createLlmClient>) => {
      // Record the config (provider + model) so REFLECTION_MODEL tests can
      // assert the override reached the resolution layer.
      recordLlmArgs({ provider: args[0].provider, model: args[0].model });
      const active = getActiveLlmClient();
      if (!active) throw new Error('reflection.test: no active LLM client set');
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
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
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

/** Insert a COMPLETED job snapshot (the shape execute.ts hands the hook). */
async function insertCompletedJob(opts?: {
  channel?: string;
  status?: string;
  turn?: number;
  toolsUsed?: string[];
}) {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: opts?.channel ?? 'api',
      task: 'Scrape three competitor pricing pages and summarise into a table.',
      status: opts?.status ?? 'completed',
      turn: opts?.turn ?? 5,
      toolsUsed: opts?.toolsUsed ?? ['web_browse', 'save_memory'],
      messages: [
        { role: 'user', content: 'Scrape three competitor pricing pages.' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will paginate before scraping the table.' },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'web_browse',
              input: { url: 'https://example.com/pricing' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'web_browse',
              output: { type: 'text', value: 'pricing table HTML ...' },
            },
          ],
        },
      ],
    })
    .returning();
  if (!job) throw new Error('failed to insert job');
  return job;
}

async function skillsForAgentCreatedBy(createdBy: string) {
  return db
    .select()
    .from(agentSkills)
    .where(and(eq(agentSkills.entityId, seed.entityId), eq(agentSkills.createdBy, createdBy)));
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
  delete process.env['REFLECTION_MIN_TURNS'];
  delete process.env['REFLECTION_MAX_PER_HOUR'];
  delete process.env['REFLECTION_MAX_TURNS'];
  delete process.env['REFLECTION_MODEL'];
  _resetEnvCache();
});

beforeEach(async () => {
  _resetReflectionThrottle();
  // maybeRunReflection reads the validated `env` proxy (over process.env), so the
  // required vars must be present for parseEnv to succeed. Other runner tests
  // pass a testEnv object and never touch the proxy; reflection deliberately reads
  // env so a deployment toggles it purely via environment.
  process.env['DATABASE_URL'] = 'test://local';
  // Default env for the gate-passing tests; individual tests override + reset.
  process.env['REFLECTION_ENABLED'] = 'true';
  process.env['REFLECTION_MIN_TURNS'] = '3';
  process.env['REFLECTION_MAX_PER_HOUR'] = '6';
  process.env['REFLECTION_MAX_TURNS'] = '3';
  _resetEnvCache();

  // Phase D: Gate 5b requires per-entity opt-in. Reset to enabled before each test
  // so existing gate-passing tests continue to work. Gate-disabled tests override
  // this to false after the reset (see test 11).
  const { entities: entitiesTable, eq: eqFn } = await import('@nodal-agents/db');
  await db.update(entitiesTable).set({ reflectionEnabled: true }).where(eqFn(entitiesTable.id, seed.entityId));
});

// ── 1. Happy path create ────────────────────────────────────────────────────────
describe('reflection — happy path create', () => {
  it('persists a NEW agent-authored skill (created_by=agent) when the model calls create_skill', async () => {
    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: {
                slug: 'paginate-before-scrape',
                name: 'Paginate before scraping tables',
                content:
                  'When scraping a multi-page table, follow pagination links to the end before extracting rows so no records are missed.',
                description: 'Durable scraping technique.',
              },
            },
          ],
        },
        {}, // 2nd turn: no tool call → stop
      ]),
    );
    const job = await insertCompletedJob();

    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
    } as Parameters<typeof maybeRunReflection>[2]);

    const rows = await db
      .select()
      .from(agentSkills)
      .where(
        and(eq(agentSkills.slug, 'paginate-before-scrape'), eq(agentSkills.entityId, seed.entityId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdBy).toBe('agent');
    expect(rows[0]!.name).toBe('Paginate before scraping tables');
    expect(rows[0]!.content).toContain('pagination');
  });
});

// ── 2. Happy path patch (agent-owned skill only) ─────────────────────────────────
describe('reflection — happy path patch', () => {
  it('increments patch_count on an AGENT-owned assigned skill, provenance stays agent', async () => {
    // Reflection may only patch skills it authored itself (created_by='agent').
    // Seed an agent-owned skill (patch_count=0) assigned to the agent.
    const [existing] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: 'scraping-skill',
        name: 'Web Scraping',
        content: 'Original scraping guidance.',
        createdBy: 'agent',
      })
      .returning();
    if (!existing) throw new Error('failed to seed skill');
    await db.insert(agentSkillAssignments).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      skillId: existing.id,
    });

    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'update_skill',
              args: {
                skillSlug: 'scraping-skill',
                content:
                  'Original scraping guidance. ALSO: paginate to the last page before extracting rows.',
              },
            },
          ],
        },
        {},
      ]),
    );
    const job = await insertCompletedJob();

    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
    } as Parameters<typeof maybeRunReflection>[2]);

    const [row] = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.id, existing.id));
    expect(row!.patchCount).toBe(1);
    expect(row!.createdBy).toBe('agent'); // provenance unchanged (stays agent)
    expect(row!.content).toContain('paginate to the last page');
    expect(row!.contentOverridden).toBe(true);
  });

  // ── 2b. Provenance sandbox: refuse to patch a USER-owned skill ────────────────
  // The whole point of Phase A: reflection must NEVER alter a user/system skill,
  // because flipping its provenance to 'agent' would make it curator-eligible.
  it('REFUSES to patch a user-owned skill — row stays unchanged (created_by=user, patch_count=0)', async () => {
    const [userSkill] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: 'user-authored-skill',
        name: 'User Authored',
        content: 'Carefully hand-written user guidance — do not touch.',
        description: 'Owned by the user.',
        createdBy: 'user',
      })
      .returning();
    if (!userSkill) throw new Error('failed to seed user skill');
    await db.insert(agentSkillAssignments).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      skillId: userSkill.id,
    });

    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'update_skill',
              args: {
                skillSlug: 'user-authored-skill',
                content: 'Reflection trying to overwrite user content.',
              },
            },
          ],
        },
        {}, // 2nd turn after the refusal tool-result: no tool call → stop
      ]),
    );
    const job = await insertCompletedJob();

    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
    } as Parameters<typeof maybeRunReflection>[2]);

    // The user-owned row is byte-for-byte UNCHANGED.
    const [row] = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.id, userSkill.id));
    expect(row!.createdBy).toBe('user'); // provenance NOT flipped
    expect(row!.patchCount).toBe(0); // NOT bumped
    expect(row!.content).toBe('Carefully hand-written user guidance — do not touch.');
    expect(row!.contentOverridden).toBe(false);
  });
});

// ── 3. Gate: disabled ───────────────────────────────────────────────────────────
describe('reflection — gate: disabled', () => {
  it('writes nothing when REFLECTION_ENABLED is false', async () => {
    process.env['REFLECTION_ENABLED'] = 'false';
    _resetEnvCache();

    const before = (await skillsForAgentCreatedBy('agent')).length;
    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: { slug: 'should-not-exist', name: 'Nope', content: 'x' },
            },
          ],
        },
      ]),
    );
    const job = await insertCompletedJob();
    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
    } as Parameters<typeof maybeRunReflection>[2]);

    const after = await skillsForAgentCreatedBy('agent');
    expect(after.length).toBe(before);
    const sneaked = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'should-not-exist'));
    expect(sneaked).toHaveLength(0);
  });
});

// ── 4. Gate: trivial job (turn < MIN) ───────────────────────────────────────────
describe('reflection — gate: trivial job', () => {
  it('skips when job.turn is below REFLECTION_MIN_TURNS', async () => {
    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: { slug: 'trivial-skill', name: 'Trivial', content: 'x' },
            },
          ],
        },
      ]),
    );
    const job = await insertCompletedJob({ turn: 1 });
    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
      turn: 1,
    } as Parameters<typeof maybeRunReflection>[2]);

    const rows = await db.select().from(agentSkills).where(eq(agentSkills.slug, 'trivial-skill'));
    expect(rows).toHaveLength(0);
  });

  it('skips when toolsUsed is empty even if turn is high', async () => {
    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: { slug: 'no-tools-skill', name: 'NoTools', content: 'x' },
            },
          ],
        },
      ]),
    );
    const job = await insertCompletedJob({ turn: 9, toolsUsed: [] });
    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
      turn: 9,
      toolsUsed: [],
    } as Parameters<typeof maybeRunReflection>[2]);

    const rows = await db.select().from(agentSkills).where(eq(agentSkills.slug, 'no-tools-skill'));
    expect(rows).toHaveLength(0);
  });
});

// ── 5. Gate: failed job ─────────────────────────────────────────────────────────
describe('reflection — gate: failed job', () => {
  it('skips when status is not completed', async () => {
    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: { slug: 'failed-job-skill', name: 'Failed', content: 'x' },
            },
          ],
        },
      ]),
    );
    const job = await insertCompletedJob({ status: 'failed' });
    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'failed',
    } as Parameters<typeof maybeRunReflection>[2]);

    const rows = await db.select().from(agentSkills).where(eq(agentSkills.slug, 'failed-job-skill'));
    expect(rows).toHaveLength(0);
  });
});

// ── 6. Gate: recursion (channel='reflection') ───────────────────────────────────
// 'reflection' is not in the agent_jobs.channel CHECK, so we cannot persist such
// a row. We exercise the guard directly against an in-memory snapshot — exactly
// what execute.ts hands the hook (the hook never re-reads the row).
describe('reflection — gate: recursion', () => {
  it('skips when channel is reflection (no self-reflection)', async () => {
    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: { slug: 'recursion-skill', name: 'Recursion', content: 'x' },
            },
          ],
        },
      ]),
    );
    const job = await insertCompletedJob({ channel: 'api' });
    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
      channel: 'reflection',
    } as Parameters<typeof maybeRunReflection>[2]);

    const rows = await db.select().from(agentSkills).where(eq(agentSkills.slug, 'recursion-skill'));
    expect(rows).toHaveLength(0);
  });
});

// ── 7. Gate: chat ───────────────────────────────────────────────────────────────
describe('reflection — gate: chat', () => {
  it('skips when channel is chat', async () => {
    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: { slug: 'chat-skill', name: 'Chat', content: 'x' },
            },
          ],
        },
      ]),
    );
    const job = await insertCompletedJob({ channel: 'api' });
    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
      channel: 'chat',
    } as Parameters<typeof maybeRunReflection>[2]);

    const rows = await db.select().from(agentSkills).where(eq(agentSkills.slug, 'chat-skill'));
    expect(rows).toHaveLength(0);
  });
});

// ── 8. Gate: throttle ───────────────────────────────────────────────────────────
describe('reflection — gate: throttle', () => {
  it('skips once more than REFLECTION_MAX_PER_HOUR passes have run for the entity in the rolling hour', async () => {
    process.env['REFLECTION_MAX_PER_HOUR'] = '2';
    _resetEnvCache();

    // Each pass creates a distinctly-slugged skill so we can count how many ran.
    const makePassDeps = (n: number) =>
      makeDeps(
        makeScriptedClient([
          {
            toolCalls: [
              {
                toolCallId: `r${n}`,
                toolName: 'create_skill',
                args: { slug: `throttle-skill-${n}`, name: `T${n}`, content: 'x' },
              },
            ],
          },
          {},
        ]),
      );

    for (let n = 0; n < 4; n += 1) {
      const job = await insertCompletedJob();
      await maybeRunReflection(makePassDeps(n), db as RunnerDeps['db'], {
        ...job,
        status: 'completed',
      } as Parameters<typeof maybeRunReflection>[2]);
    }

    // Cap = 2 ⇒ only the first two passes wrote a skill.
    const created: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      const rows = await db
        .select()
        .from(agentSkills)
        .where(eq(agentSkills.slug, `throttle-skill-${n}`));
      if (rows.length > 0) created.push(`throttle-skill-${n}`);
    }
    expect(created).toHaveLength(2);
    expect(created).toContain('throttle-skill-0');
    expect(created).toContain('throttle-skill-1');
  });
});

// ── 9. Anti-lesson prompt ────────────────────────────────────────────────────────
describe('reflection — anti-lesson prompt', () => {
  it('the constant contains all four verbatim anti-lesson clauses', () => {
    expect(ANTI_LESSON_FILTER).toContain('ANTI-LESSON FILTER');
    expect(ANTI_LESSON_FILTER).toContain('Environment-dependent failures');
    expect(ANTI_LESSON_FILTER).toContain('command not found');
    expect(ANTI_LESSON_FILTER).toContain('Negative claims about tools');
    expect(ANTI_LESSON_FILTER).toContain('harden into refusals');
    expect(ANTI_LESSON_FILTER).toContain('Transient errors that resolved on retry');
    expect(ANTI_LESSON_FILTER).toContain('One-off task narratives');
    expect(ANTI_LESSON_FILTER).toContain('durable TECHNIQUE or a FIX');
    expect(ANTI_LESSON_FILTER).toContain('a no-op pass is correct and common');
  });

  it('the built system prompt embeds the anti-lesson filter and the assigned-skills block', () => {
    const prompt = buildReflectionSystemPrompt('JobHunter', '- existing-slug — Existing Skill');
    expect(prompt).toContain('JobHunter');
    expect(prompt).toContain('ANTI-LESSON FILTER');
    expect(prompt).toContain('harden into refusals');
    expect(prompt).toContain('- existing-slug — Existing Skill');
    expect(prompt).toContain('create_skill');
    expect(prompt).toContain('update_skill');
  });
});

// ── 10. Non-blocking ────────────────────────────────────────────────────────────
// Proves the completion path is not delayed by reflection: executeJob resolves
// to `completed` while the reflection LLM call is still pending (gated on a
// deferred promise the test releases only AFTER asserting completion).
describe('reflection — non-blocking', () => {
  it('executeJob returns completed before the fire-and-forget reflection resolves', async () => {
    // The work loop completes in ONE turn (turn=1), so lower MIN_TURNS to 1 for
    // this test — we are exercising the non-blocking wiring, not the turn gate
    // (which has its own dedicated test above).
    process.env['REFLECTION_MIN_TURNS'] = '1';
    _resetEnvCache();

    let releaseReflection!: () => void;
    const reflectionGate = new Promise<void>((resolve) => {
      releaseReflection = resolve;
    });
    let reflectionStarted = false;
    let reflectionFinished = false;

    // One mock client serves BOTH the work loop and the reflection pass (both go
    // through createLlmClient). Call 1 = work loop → return_result (completes the
    // job in one turn). Call 2 = reflection turn 1 → blocks on reflectionGate,
    // then returns a create_skill so we can confirm it eventually ran.
    let call = 0;
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock',
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'rr',
                toolName: 'return_result',
                input: JSON.stringify({ status: 'success' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
            warnings: [],
          };
        }
        // Reflection turn: mark started, block until released.
        reflectionStarted = true;
        await reflectionGate;
        reflectionFinished = true;
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'nb',
              toolName: 'create_skill',
              input: JSON.stringify({
                slug: 'nonblocking-skill',
                name: 'NB',
                content: 'durable technique',
              }),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const client: RunnerDeps['llmClient'] = {
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
      streamText: () => {
        throw new Error('no');
      },
      generateObject: () => {
        throw new Error('no');
      },
    };

    const deps = makeDeps(client);
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'A substantial task that will use a tool.',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('failed to insert job');

    const result = await executeJob(job.id as JobId, deps);

    // The job is DONE. Reflection may have started but must NOT have finished
    // (it is parked on the gate) — proving completion did not await it.
    expect(result.status).toBe('completed');
    expect(reflectionFinished).toBe(false);

    // Now let the parked reflection finish and confirm it actually ran to a write
    // (so the assertion above isn't vacuously true because reflection never ran).
    releaseReflection();
    await vi.waitFor(
      async () => {
        const rows = await db
          .select()
          .from(agentSkills)
          .where(eq(agentSkills.slug, 'nonblocking-skill'));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.createdBy).toBe('agent');
      },
      { timeout: 2000, interval: 25 },
    );
    expect(reflectionStarted).toBe(true);
    expect(reflectionFinished).toBe(true);
  });
});

// ── 11. Gate: per-entity reflection_enabled flag ─────────────────────────────
describe('reflection — gate: per-entity flag', () => {
  it('skips when entity.reflection_enabled = false even if REFLECTION_ENABLED env is not false', async () => {
    // beforeEach sets reflectionEnabled=true on the entity; disable it here to
    // test that Gate 5b blocks when the entity hasn't opted in.
    const { entities: entitiesTable2, eq: eqFn2 } = await import('@nodal-agents/db');
    await db.update(entitiesTable2).set({ reflectionEnabled: false }).where(eqFn2(entitiesTable2.id, seed.entityId));

    // The env has REFLECTION_ENABLED='true' (set in beforeEach) so only
    // the per-entity flag should block the pass.
    process.env['REFLECTION_ENABLED'] = 'true';
    _resetEnvCache();

    const before = (await skillsForAgentCreatedBy('agent')).length;
    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: { slug: 'entity-flag-blocked', name: 'Blocked', content: 'x' },
            },
          ],
        },
      ]),
    );
    const job = await insertCompletedJob();
    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
    } as Parameters<typeof maybeRunReflection>[2]);

    const after = await skillsForAgentCreatedBy('agent');
    expect(after.length).toBe(before);

    const sneaked = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'entity-flag-blocked'));
    expect(sneaked).toHaveLength(0);
  });

  it('runs when entity.reflection_enabled = true', async () => {
    // Enable reflection on the entity
    const { entities: entitiesTable, eq: eqFn } = await import('@nodal-agents/db');
    await (db as Parameters<typeof maybeRunReflection>[1])
      .update(entitiesTable)
      .set({ reflectionEnabled: true })
      .where(eqFn(entitiesTable.id, seed.entityId));

    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: { slug: 'entity-flag-allowed', name: 'Allowed', content: 'durable technique' },
            },
          ],
        },
        {},
      ]),
    );
    const job = await insertCompletedJob();
    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
    } as Parameters<typeof maybeRunReflection>[2]);

    const rows = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'entity-flag-allowed'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdBy).toBe('agent');

    // Cleanup: disable for other tests
    await (db as Parameters<typeof maybeRunReflection>[1])
      .update(entitiesTable)
      .set({ reflectionEnabled: false })
      .where(eqFn(entitiesTable.id, seed.entityId));
  });

  // ── 11b. Regression: REFLECTION_ENABLED UNSET (production default) ───────────
  // This test FAILS against the old env.ts where REFLECTION_ENABLED defaults
  // to 'false' (which globally kills reflection regardless of entity flag).
  // After the fix (default=''), unset env → per-entity flag decides → pass runs.
  it('runs when REFLECTION_ENABLED env is UNSET (default) and entity.reflection_enabled = true', async () => {
    // Remove the env var entirely — this is the production-default path.
    // beforeEach sets reflectionEnabled=true on the entity, but be explicit.
    delete process.env['REFLECTION_ENABLED'];
    _resetEnvCache();

    const { entities: entitiesTable3, eq: eqFn3 } = await import('@nodal-agents/db');
    await db.update(entitiesTable3).set({ reflectionEnabled: true }).where(eqFn3(entitiesTable3.id, seed.entityId));

    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: {
                slug: 'unset-env-skill',
                name: 'Unset Env Skill',
                content: 'Skill created when REFLECTION_ENABLED env is unset.',
              },
            },
          ],
        },
        {}, // 2nd turn: no tool call → stop
      ]),
    );
    const job = await insertCompletedJob();
    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
    } as Parameters<typeof maybeRunReflection>[2]);

    // The skill MUST be persisted — unset env + entity opt-in = reflection runs.
    const rows = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'unset-env-skill'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdBy).toBe('agent');
  });
});

// ── 12. skill_assignment_mode='auto' ───────────────────────────────────────────
describe('reflection — skill_assignment_mode=auto', () => {
  it('auto-assigns the new skill to the authoring agent and stamps created_by_agent_id', async () => {
    // Set the entity to auto-assign mode so new reflection skills are immediately
    // wired to the agent without owner approval.
    const { entities: entitiesTable, eq: eqFn } = await import('@nodal-agents/db');
    await db
      .update(entitiesTable)
      .set({ skillAssignmentMode: 'auto' })
      .where(eqFn(entitiesTable.id, seed.entityId));

    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: {
                slug: 'auto-assign-skill',
                name: 'Auto Assign Skill',
                content: 'Durable technique created in auto-assign mode.',
                description: 'Auto-assigned on creation.',
              },
            },
          ],
        },
        {}, // 2nd turn: no tool call → stop
      ]),
    );
    const job = await insertCompletedJob();

    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
    } as Parameters<typeof maybeRunReflection>[2]);

    // (1) The skill row has created_by_agent_id set to the authoring agent.
    const [skillRow] = await db
      .select()
      .from(agentSkills)
      .where(
        and(eq(agentSkills.slug, 'auto-assign-skill'), eq(agentSkills.entityId, seed.entityId)),
      );
    expect(skillRow).toBeDefined();
    expect(skillRow!.createdBy).toBe('agent');
    expect(skillRow!.createdByAgentId).toBe(seed.agentId);

    // (2) An agent_skill_assignments row links the skill to the agent.
    const [assignRow] = await db
      .select()
      .from(agentSkillAssignments)
      .where(
        and(
          eq(agentSkillAssignments.skillId, skillRow!.id),
          eq(agentSkillAssignments.agentId, seed.agentId),
        ),
      );
    expect(assignRow).toBeDefined();

    // Cleanup: reset mode to 'approval' so other tests are not affected.
    await db
      .update(entitiesTable)
      .set({ skillAssignmentMode: 'approval' })
      .where(eqFn(entitiesTable.id, seed.entityId));
  });
});

// ── 13. skill_assignment_mode='approval' ────────────────────────────────────────
describe('reflection — skill_assignment_mode=approval', () => {
  it('stamps created_by_agent_id but does NOT auto-assign when mode is approval', async () => {
    // 'approval' is the default set in beforeEach — but be explicit.
    const { entities: entitiesTable, eq: eqFn } = await import('@nodal-agents/db');
    await db
      .update(entitiesTable)
      .set({ skillAssignmentMode: 'approval' })
      .where(eqFn(entitiesTable.id, seed.entityId));

    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: {
                slug: 'approval-mode-skill',
                name: 'Approval Mode Skill',
                content: 'Durable technique pending owner approval.',
                description: 'Queued for approval.',
              },
            },
          ],
        },
        {}, // 2nd turn: no tool call → stop
      ]),
    );
    const job = await insertCompletedJob();

    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
    } as Parameters<typeof maybeRunReflection>[2]);

    // The skill exists with provenance and authoring-agent stamped.
    const [skillRow] = await db
      .select()
      .from(agentSkills)
      .where(
        and(eq(agentSkills.slug, 'approval-mode-skill'), eq(agentSkills.entityId, seed.entityId)),
      );
    expect(skillRow).toBeDefined();
    expect(skillRow!.createdBy).toBe('agent');
    expect(skillRow!.createdByAgentId).toBe(seed.agentId);

    // NO assignment row — the skill is pending owner approval.
    const assignRows = await db
      .select()
      .from(agentSkillAssignments)
      .where(
        and(
          eq(agentSkillAssignments.skillId, skillRow!.id),
          eq(agentSkillAssignments.agentId, seed.agentId),
        ),
      );
    expect(assignRows).toHaveLength(0);
  });
});

// ── 14. REFLECTION_MODEL override ──────────────────────────────────────────────
// Asserts the model override flows all the way from env → resolveAgentLlmClient
// → createLlmClient. We capture the ProviderConfig that createLlmClient receives
// via the recordLlmArgs() hook in the mock (defined at the top of this file).
describe('reflection — REFLECTION_MODEL override', () => {
  it('when REFLECTION_MODEL is set, createLlmClient is called with the override model (not the agent model)', async () => {
    process.env['REFLECTION_MODEL'] = 'openai/gpt-4o-mini';
    _resetEnvCache();
    resetLastLlmConfig();

    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: {
                slug: 'override-model-skill',
                name: 'Override Model Skill',
                content: 'Created via override model.',
              },
            },
          ],
        },
        {},
      ]),
    );

    const job = await insertCompletedJob();
    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
    } as Parameters<typeof maybeRunReflection>[2]);

    // (a) The override model reached createLlmClient.
    const captured = getLastLlmConfig();
    expect(captured).not.toBeNull();
    expect(captured!.model).toBe('openai/gpt-4o-mini');

    // (b) The skill was actually written (the pass ran, not just resolved).
    const rows = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'override-model-skill'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdBy).toBe('agent');

    // Cleanup
    delete process.env['REFLECTION_MODEL'];
    _resetEnvCache();
  });

  it('when REFLECTION_MODEL is NOT set, createLlmClient is called with the agent\'s own model', async () => {
    // Ensure REFLECTION_MODEL is absent (beforeEach + _resetEnvCache handles REFLECTION_ENABLED).
    delete process.env['REFLECTION_MODEL'];
    _resetEnvCache();
    resetLastLlmConfig();

    const deps = makeDeps(
      makeScriptedClient([
        {
          toolCalls: [
            {
              toolCallId: 'r1',
              toolName: 'create_skill',
              args: {
                slug: 'agent-model-skill',
                name: 'Agent Model Skill',
                content: 'Created via agent own model (no override).',
              },
            },
          ],
        },
        {},
      ]),
    );

    const job = await insertCompletedJob();
    await maybeRunReflection(deps, db as RunnerDeps['db'], {
      ...job,
      status: 'completed',
    } as Parameters<typeof maybeRunReflection>[2]);

    // The agent's model from seedMinimal (defaults to the DB column default).
    // We assert it is NOT the override value, confirming the fallback path is taken.
    const captured = getLastLlmConfig();
    expect(captured).not.toBeNull();
    // The override was not set — the agent's seeded model flows through.
    expect(captured!.model).not.toBe('openai/gpt-4o-mini');

    // Skill still created (pass ran correctly on agent's model).
    const rows = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'agent-model-skill'));
    expect(rows).toHaveLength(1);
  });
});
