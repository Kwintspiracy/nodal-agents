// @vitest-environment node
/**
 * Integration tests for listCodingProcessesAction (Code tab — étape V).
 *
 * Uses a real pglite in-memory DB (spinUpTestDb / seedMinimal from
 * @nodal-agents/db/test-utils) so assertions target actual DB rows — not
 * mocks of mocks. Mirrors the harness in root-agent-actions.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, _resetMasterKeyCacheForTests } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, agentWorkspaces, cliRuns, toolCalls } from '@nodal-agents/db';
import type * as NodalMemory from '@nodal-agents/memory';

// ─── Module-level state ───────────────────────────────────────────────────────

let _testDb: TestDb | null = null;
let _testUserId = 'placeholder-user-id';
let _testEntityId = 'placeholder-entity-id';
let _llmKeyId = 'placeholder-llm-key-id';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/server.ts', () => ({
  getDb: () => {
    if (!_testDb) throw new Error('Test DB not initialized');
    return _testDb;
  },
  getAuthProvider: () => ({
    getSession: async (_req: Request) => ({
      userId: _testUserId,
      entityId: _testEntityId,
    }),
    handleAuthRequest: null,
  }),
  requireAuth: vi.fn().mockImplementation(async () => ({
    userId: _testUserId,
    entityId: _testEntityId,
  })),
  requireAuthWithEntity: vi.fn(),
  requireUserWithEntity: vi.fn(),
  applyActiveEntity: vi.fn(async (session: unknown) => session),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
}));

vi.mock('../src/lib/cli-config.ts', () => ({
  NODALAI_CONFIG_PATH: '/tmp/test/config.json',
  readNodalaiConfig: vi.fn(),
  mergeNodalaiConfig: vi.fn(),
}));

vi.mock('@nodal-agents/memory', async () => {
  const actual = await vi.importActual<typeof NodalMemory>('@nodal-agents/memory');
  return {
    ...actual,
    listMemories: vi.fn(),
    deleteMemory: vi.fn(),
    updateMemory: vi.fn(),
  };
});

vi.mock('@nodal-agents/adapter-mcp', () => ({
  connectMcp: vi.fn(),
}));

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env['DATABASE_URL'] = 'postgres://placeholder:5432/placeholder';
  process.env['AUTH_MODE'] = 'local-trust';
  process.env['RUNNER_URL'] = 'http://localhost:3001';
  process.env['WORKER_SECRET'] = 'test-bearer-789';

  _setMasterKeyForTests(randomBytes(32));

  const { db } = await spinUpTestDb();
  _testDb = db;

  const seed = await seedMinimal(db);
  _testUserId = seed.userId;
  _testEntityId = seed.entityId;
  _llmKeyId = seed.llmKeyId;
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
  _testDb = null;
  vi.restoreAllMocks();
});

async function makeAgent(name: string): Promise<string> {
  const [row] = await _testDb!
    .insert(agents)
    .values({
      entityId: _testEntityId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      personality: 'test',
      llmKeyId: _llmKeyId,
    })
    .returning();
  if (!row) throw new Error(`Failed to seed agent ${name}`);
  return row.id;
}

async function makeJob(agentId: string, status: string, parentJobId?: string): Promise<string> {
  const [row] = await _testDb!
    .insert(agentJobs)
    .values({
      entityId: _testEntityId,
      agentId,
      status,
      channel: 'api',
      task: 'Fix the flaky auth test',
      parentJobId: parentJobId ?? null,
    })
    .returning();
  if (!row) throw new Error('Failed to seed job');
  return row.id;
}

describe('listCodingProcessesAction', () => {
  it('a job with cli_runs + cli:Edit tool_calls surfaces with the right stage/cost/files', async () => {
    const agentId = await makeAgent('Audit Code Agent');
    const jobId = await makeJob(agentId, 'processing');

    await _testDb!.insert(cliRuns).values({
      entityId: _testEntityId,
      agentId,
      jobId,
      provider: 'claude',
      mode: 'write',
      costUsd: 0.42,
    });

    // Two edits to the SAME file (must dedupe to 1) + one edit to a second file.
    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Edit',
        toolInput: { file_path: '/repo/src/auth.ts', old_string: 'a', new_string: 'b' },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Edit',
        toolInput: { file_path: '/repo/src/auth.ts', old_string: 'b', new_string: 'c' },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: '/repo/src/auth.test.ts', content: 'test content' },
        toolOutput: 'ok',
      },
    ]);

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = result.data.find((r) => r.id === jobId);
    expect(row).toBeTruthy();
    expect(row?.kind).toBe('job');
    expect(row?.stage).toBe('coding');
    expect(row?.costUsd).toBeCloseTo(0.42, 5);
    expect(row?.filesChanged).toBe(2);
    expect(row?.agentId).toBe(agentId);
  });

  it('a pipeline whose ONLY writes were refused reports 0 files changed', async () => {
    const agentId = await makeAgent('Audit Refused Write Agent');
    const jobId = await makeJob(agentId, 'completed');

    // The exact shape recorded for Dev C (read-only runtime agent, 20/08):
    // the CLI removes the tool from the palette and answers with an error
    // envelope. Nine of these used to read as nine files changed.
    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: '/repo/src/ghost.ts', content: 'never written' },
        toolOutput:
          '<tool_use_error>Error: No such tool available: Write. Write is disabled for this session, in subagents as well as here.</tool_use_error>',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Read',
        toolInput: { file_path: '/repo/src/real.ts' },
        toolOutput: 'file contents',
      },
    ]);

    const { listCodingProcessesAction, getCodingProcessDetailAction } =
      await import('../src/lib/actions.ts');
    const list = await listCodingProcessesAction();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    // It still surfaces (the CLI ran) — but claims NOTHING was changed.
    expect(list.data.find((r) => r.id === jobId)?.filesChanged).toBe(0);

    const detail = await getCodingProcessDetailAction({ jobId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.changes).toHaveLength(0);
    expect(detail.data.header.filesChanged).toBe(0);
  });

  it('a refused write alongside a real one counts only the real one', async () => {
    const agentId = await makeAgent('Audit Mixed Writes Agent');
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: '/repo/src/ghost.ts', content: 'never written' },
        toolOutput: '<tool_use_error>Error: No such tool available: Write.</tool_use_error>',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: '/repo/src/real.ts', content: 'written for real' },
        toolOutput: 'File created successfully.',
      },
    ]);

    const { listCodingProcessesAction, getCodingProcessDetailAction } =
      await import('../src/lib/actions.ts');
    const list = await listCodingProcessesAction();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.find((r) => r.id === jobId)?.filesChanged).toBe(1);

    const detail = await getCodingProcessDetailAction({ jobId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.changes).toHaveLength(1);
    expect(detail.data.changes[0]!.filePath).toBe('/repo/src/real.ts');
    // The refused attempt still exists in the timeline — it is the signal
    // that the agent's posture is wrong, not something to hide.
    const calls = detail.data.activity.filter((a) => a.kind === 'call');
    expect(calls).toHaveLength(2);
  });

  it('the CLI absolute path and the Nodal workspace-relative path of the SAME file count as ONE (job cbdbfc6c)', async () => {
    const agentId = await makeAgent('Audit Path Canon Agent');
    // The agent's workspace root — the prefix the canonicalizer must strip.
    await _testDb!.insert(agentWorkspaces).values({
      entityId: _testEntityId,
      agentId,
      label: 'dev',
      path: 'C:\\Users\\test\\Dev',
    });
    const jobId = await makeJob(agentId, 'completed');

    // The recorded real shape of job cbdbfc6c: cli:Write with the ABSOLUTE
    // Windows path, then file_write with the workspace-RELATIVE path — the
    // same index.html, written twice through two tool families.
    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: {
          file_path: 'C:\\Users\\test\\Dev\\outputs\\app\\index.html',
          content: '<!DOCTYPE html>v1',
        },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'file_write',
        toolInput: { path: 'outputs/app/index.html', content: '<!DOCTYPE html>v2' },
        toolOutput: 'ok',
      },
    ]);

    const { listCodingProcessesAction, getCodingProcessDetailAction } =
      await import('../src/lib/actions.ts');

    const list = await listCodingProcessesAction();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.find((r) => r.id === jobId)?.filesChanged).toBe(1);

    const detail = await getCodingProcessDetailAction({ jobId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.header.filesChanged).toBe(1);
    expect(detail.data.changes).toHaveLength(1);
    // One group, the canonical (workspace-relative) name, BOTH edits kept.
    expect(detail.data.changes[0]!.filePath).toBe('outputs/app/index.html');
    expect(detail.data.changes[0]!.edits).toHaveLength(2);
  });

  it('a file_edit in a direct child + an approve review_verdict qualifies the pipeline (condition C) and marks the completed parent "done_approved" with filesChanged >= 1', async () => {
    const agentId = await makeAgent('Audit Code Reviewer Parent Agent');
    const parentJobId = await makeJob(agentId, 'completed');
    const childJobId = await makeJob(agentId, 'completed', parentJobId);

    // Cost comes from cli_runs on the root; the QUALIFYING signal is
    // condition C — a Nodal file_edit in the child PLUS a dev marker
    // (the review_verdict itself, also in the child) elsewhere in the
    // pipeline. Neither alone would qualify (v3).
    await _testDb!.insert(cliRuns).values({
      entityId: _testEntityId,
      agentId,
      jobId: parentJobId,
      provider: 'claude',
      mode: 'write',
      costUsd: 0.1,
    });

    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId: childJobId,
        toolName: 'file_edit',
        toolInput: { path: '/repo/src/reviewed.ts', old_string: 'a', new_string: 'b' },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId: childJobId,
        toolName: 'review_verdict',
        toolInput: { summary: 'Looks good' },
        toolOutput: JSON.stringify({
          verdict: 'approve',
          summary: 'Looks good',
          findings: [],
          counts: { blocking: 0 },
        }),
      },
    ]);

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parentRow = result.data.find((r) => r.id === parentJobId);
    expect(parentRow).toBeTruthy();
    expect(parentRow?.stage).toBe('done_approved');
    expect(parentRow?.filesChanged).toBeGreaterThanOrEqual(1);

    // The child carries the qualifying signals but is a delegated child — it
    // rolls up to the parent and never appears as its own list entry.
    const childRow = result.data.find((r) => r.id === childJobId);
    expect(childRow).toBeUndefined();
  });

  it('a completed job with an edit but no review_verdict anywhere is plain "done"', async () => {
    const agentId = await makeAgent('Audit Code Plain Done Agent');
    const jobId = await makeJob(agentId, 'completed');
    await _testDb!.insert(cliRuns).values({
      entityId: _testEntityId,
      agentId,
      jobId,
      provider: 'claude',
      mode: 'read',
      costUsd: 0.05,
    });
    // Qualifying signal (condition A) — a bare shell call would NOT qualify
    // under v3 (cli:Bash never qualifies alone), so this uses a real edit.
    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'cli:Write',
      toolInput: { file_path: '/repo/src/done.ts', content: 'done' },
      toolOutput: 'ok',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = result.data.find((r) => r.id === jobId);
    expect(row?.stage).toBe('done');
  });

  it('a code_task in read mode (analysis, no edits) is EXCLUDED — v3 condition B requires write mode', async () => {
    const agentId = await makeAgent('Audit Code ReadCodeTask Agent');
    const jobId = await makeJob(agentId, 'completed');
    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'code_task',
      toolInput: { provider: 'claude', mode: 'read', task: 'Explain this codebase' },
      toolOutput: JSON.stringify({ resultText: 'Here is an explanation…', isError: false }),
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.find((r) => r.id === jobId)).toBeUndefined();
  });

  it('an OFFICE-only file_write (.pptx) with no dev signal is EXCLUDED (guard v4: file nature)', async () => {
    // v4 (23/08) : le garde-fou Office ne passe plus par la présence d'un
    // marqueur CLI mais par la NATURE des fichiers édités. Un .pptx seul
    // reste invisible — c'est le même comportement que v3, pour la bonne
    // raison cette fois.
    const agentId = await makeAgent('Audit Code Office Agent');
    const jobId = await makeJob(agentId, 'completed');
    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'file_write',
      toolInput: { path: '/workspace/quarterly-report.pptx', content: 'binary-ish content' },
      toolOutput: 'ok',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.find((r) => r.id === jobId)).toBeUndefined();
  });

  it('a pure-LLM coder — file_edit on a .ts file, NO CLI, NO code_task, NO reviewer — is INCLUDED (v4)', async () => {
    // Le constat live de Quentin (23/08) : orchestrateur → codeur OpenRouter
    // qui édite du code via les outils Nodal. Il code réellement ; la v3 le
    // rendait invisible (aucun « marqueur dev »). La v4 le qualifie par la
    // nature du fichier édité.
    const agentId = await makeAgent('Audit Code PureLLM Coder');
    const jobId = await makeJob(agentId, 'completed');
    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'file_edit',
      toolInput: {
        path: 'src/lib/parser.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      },
      toolOutput: 'ok',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data.find((r) => r.id === jobId);
    expect(row, 'un codeur sans CLI est un codeur quand même').toBeDefined();
    expect(row!.filesChanged).toBeGreaterThan(0);
  });

  it('a file without extension (Dockerfile) written by file_write is INCLUDED (v4: no-extension = dev)', async () => {
    const agentId = await makeAgent('Audit Code Dockerfile Agent');
    const jobId = await makeJob(agentId, 'completed');
    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'file_write',
      toolInput: { path: 'deploy/Dockerfile', content: 'FROM node:22-slim' },
      toolOutput: 'ok',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.find((r) => r.id === jobId)).toBeDefined();
  });

  it('a read-only CLI job (cli_runs + cli:Read only) is EXCLUDED — not a coding session', async () => {
    const agentId = await makeAgent('Audit Code ReadOnly Agent');
    const jobId = await makeJob(agentId, 'completed');
    await _testDb!.insert(cliRuns).values({
      entityId: _testEntityId,
      agentId,
      jobId,
      provider: 'claude',
      mode: 'read',
      costUsd: 0.3,
    });
    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'cli:Read',
      toolInput: { file_path: '/repo/readme.md' },
      toolOutput: 'contents',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.find((r) => r.id === jobId)).toBeUndefined();
  });

  it('a failed job surfaces with stage "failed"', async () => {
    const agentId = await makeAgent('Audit Code Failed Agent');
    const jobId = await makeJob(agentId, 'failed');
    await _testDb!.insert(cliRuns).values({
      entityId: _testEntityId,
      agentId,
      jobId,
      provider: 'claude',
      mode: 'write',
      costUsd: 0.02,
    });
    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'cli:Write',
      toolInput: { file_path: '/repo/x.ts', content: 'x' },
      toolOutput: 'ok',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = result.data.find((r) => r.id === jobId);
    expect(row?.stage).toBe('failed');
  });
});
