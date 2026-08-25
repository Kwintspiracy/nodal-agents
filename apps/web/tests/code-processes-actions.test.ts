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
import {
  inArray,
  agents,
  agentJobs,
  agentWorkspaces,
  agentSkills,
  agentSkillAssignments,
  cliRuns,
  toolCalls,
} from '@nodal-agents/db';
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

/**
 * Le skill de l'entité pour un slug donné, créé à la demande. La v6 qualifie
 * par IDENTITÉ : sans assignation de skill, plus aucun pipeline n'entre dans
 * l'onglet Code, quels que soient les fichiers touchés.
 */
const skillIdBySlug = new Map<string, string>();
async function skillId(slug: string, name: string): Promise<string> {
  const cached = skillIdBySlug.get(slug);
  if (cached) return cached;
  const [row] = await _testDb!
    .insert(agentSkills)
    .values({
      entityId: _testEntityId,
      name,
      slug,
      content: `test skill ${slug}`,
      // Le skill du CATALOGUE : la qualification exige `createdBy='system'`
      // pour qu'un homonyme créé par l'utilisateur ne fabrique pas de faux
      // développeurs. Le seeder du runner stampe cette valeur.
      createdBy: 'system',
    })
    .returning();
  if (!row) throw new Error(`Failed to seed skill ${slug}`);
  skillIdBySlug.set(slug, row.id);
  return row.id;
}

/**
 * `skills` par défaut = ['dev'] : la quasi-totalité de cette suite décrit le
 * travail d'un DÉVELOPPEUR. Passer `[]` fabrique un agent qui n'appartient pas
 * à l'équipe de dev — le coffre de notes, l'agent bureautique, le générateur
 * d'images — dont le travail ne doit JAMAIS apparaître dans l'onglet.
 */
async function makeAgent(name: string, skills: string[] = ['dev']): Promise<string> {
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
  for (const slug of skills) {
    await _testDb!.insert(agentSkillAssignments).values({
      entityId: _testEntityId,
      agentId: row.id,
      skillId: await skillId(slug, slug === 'dev' ? 'Software development' : 'Code review'),
    });
  }
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

  it('un agent bureautique (PAS de skill dev) reste EXCLU — v6 : c’est l’identité, pas le .pptx', async () => {
    // v6 (25/08) : le garde-fou Office ne juge plus l'extension. Un agent qui
    // écrit une présentation n'est pas un développeur — non parce que .pptx
    // serait un format indigne, mais parce que personne ne l'a désigné
    // développeur. Le même agent, s'il portait le skill dev, apparaîtrait.
    const agentId = await makeAgent('Audit Code Office Agent', []);
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

// ─── Définition v6 (décision Quentin 25/08) ───────────────────────────────────
// C'est l'IDENTITÉ qui qualifie, jamais l'extension : « une exclusion par
// langage ratera tôt ou tard du vrai code ». Le coffre Obsidian sort parce que
// son agent n'est pas un développeur ; le README d'un développeur reste dans
// son projet ; les mock-data .json d'une vraie app aussi.

describe('listCodingProcessesAction — v6, la qualification par identité', () => {
  it('le coffre de notes est ABSENT — son agent n’est pas un développeur', async () => {
    const agentId = await makeAgent('Vault Notes Agent', []);
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: '/vault/Notes/idees.md', content: '# Idées' },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Edit',
        toolInput: { file_path: '/vault/Journal/2026-08-25.md', old_string: 'a', new_string: 'b' },
        toolOutput: 'ok',
      },
    ]);

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.data.find((r) => r.id === jobId),
      'le travail d’un agent non-développeur est apparu dans l’onglet Code',
    ).toBeUndefined();
  });

  it('le MÊME markdown, écrit par un DÉVELOPPEUR, qualifie — c’est le README de son projet', async () => {
    // Le pendant du test précédent, et la raison d'être de la v6 : les mêmes
    // fichiers, le même outil, un résultat opposé selon QUI écrit. Sous la v5,
    // un développeur qui ne touchait que sa doc disparaissait de l'onglet.
    const agentId = await makeAgent('Doc Writing Coder');
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'cli:Write',
      toolInput: { file_path: '/repos/monapp/README.md', content: '# MonApp' },
      toolOutput: 'ok',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.data.find((r) => r.id === jobId),
      'le travail d’un développeur a été jugé sur l’extension de son fichier',
    ).toBeTruthy();
  });

  it('un agent SANS skill qui écrit du .ts est EXCLU — le test qui sépare vraiment v5 et v6', async () => {
    // LE cas que la v6 introduit, et le seul que les autres exclusions ne
    // prouvent pas : sur main, ce pipeline QUALIFIE (fichier de code = dev).
    // C'est aussi le cas vécu du coffre Obsidian — il qualifiait à cause de
    // vrais .py et .bat écrits dedans en juillet, pas à cause de son markdown.
    //
    // Sans ce test, une régression de `devTeamAgentIds` vers « tous les
    // agents » ne ferait rougir aucune assertion : le défaut `['dev']` de
    // makeAgent masque le trou partout ailleurs.
    const agentId = await makeAgent('Vault Python Writer', []);
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'cli:Write',
      toolInput: { file_path: '/vault/scripts/export.py', content: 'print(1)' },
      toolOutput: 'ok',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.data.find((r) => r.id === jobId),
      'un fichier de code a suffi à qualifier un agent non-développeur (retour à la v5)',
    ).toBeUndefined();
  });

  it('chaîne à 3 niveaux : le skill porté par le SEUL intermédiaire suffit', async () => {
    // Constat majeur des deux relecteurs (25/08). L'orchestrateur délègue au
    // lead, qui délègue au worker ; seul le LEAD est développeur, et il
    // n'édite rien lui-même — il délègue. Comme les appels de délégation ne
    // font pas partie du scan, il n'apparaissait jamais comme participant, et
    // tout le pipeline disparaissait de l'onglet.
    const orchestrateur = await makeAgent('Chain Orchestrator', []);
    const lead = await makeAgent('Chain Lead Dev', ['dev']);
    const worker = await makeAgent('Chain Worker', []);

    const racineId = await makeJob(orchestrateur, 'completed');
    const leadJobId = await makeJob(lead, 'completed', racineId);
    const workerJobId = await makeJob(worker, 'completed', leadJobId);

    // C'est le WORKER qui édite — le lead n'a que délégué.
    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId: workerJobId,
      toolName: 'file_write',
      toolInput: { path: 'src/feature.ts', content: 'export const x = 1;' },
      toolOutput: '{"ok":true}',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.data.find((r) => r.id === racineId),
      'le porteur du skill était au milieu de la chaîne : le pipeline a disparu',
    ).toBeTruthy();
  });

  it('un skill maison qui squatte le slug est SIGNALÉ, pas subi', async () => {
    // Le cul-de-sac que la revue a déroulé (25/08) : si un skill de
    // l'utilisateur occupe déjà le slug `dev`, le seeder refuse de s'en
    // emparer — à raison. Mais alors le skill du catalogue n'existe nulle
    // part, personne ne peut qualifier, et l'écran demandait d'attacher un
    // skill introuvable. L'utilisateur attachait le sien, rien ne changeait,
    // le message revenait : une boucle sans issue depuis l'interface, dont la
    // seule sortie était écrite dans un log que personne ne lit.
    const { getDevTeamStatusAction } = await import('../src/lib/actions.ts');

    // État normal : le skill du catalogue est là (posé par le harnais).
    const avant = await getDevTeamStatusAction();
    expect(avant.ok).toBe(true);
    if (avant.ok) expect(avant.data.catalogSkillMissing).toBe(false);

    // On simule l'install où seul un homonyme de l'utilisateur existe.
    await _testDb!
      .update(agentSkills)
      .set({ createdBy: 'user' })
      .where(inArray(agentSkills.slug, ['dev', 'code-review']));

    try {
      const apres = await getDevTeamStatusAction();
      expect(apres.ok).toBe(true);
      if (!apres.ok) return;
      expect(
        apres.data.catalogSkillMissing,
        'le squat du slug n’est pas détecté : l’écran enverra dans un mur',
      ).toBe(true);
      // Et plus personne ne qualifie, ce qui est correct — un skill maison
      // ne fait pas d'un agent un développeur.
      expect(apres.data.count).toBe(0);
    } finally {
      await _testDb!
        .update(agentSkills)
        .set({ createdBy: 'system' })
        .where(inArray(agentSkills.slug, ['dev', 'code-review']));
    }
  });

  it('un RELECTEUR (skill code-review) entre aussi dans l’onglet', async () => {
    const agentId = await makeAgent('Reviewer Agent', ['code-review']);
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'review_verdict',
      toolInput: { verdict: 'approve', summary: 'ok' },
      toolOutput: '{"ok":true}',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.find((r) => r.id === jobId)).toBeTruthy();
  });

  it('le .json QUALIFIE (décision Quentin : mock-data = vrai code ; le bruit Comfy se traitera par agent)', async () => {
    const agentId = await makeAgent('Mock Data Writer');
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'file_write',
      toolInput: { path: 'app/mock-data/users.json', content: '[{"id":1}]' },
      toolOutput: '{"ok":true}',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.data.find((r) => r.id === jobId),
      'un .json de mock-data a été exclu — l’exclusion par extension est revenue',
    ).toBeTruthy();
  });

  it('un pipeline MIXTE (.md + .ts) reste un projet de code', async () => {
    const agentId = await makeAgent('Mixed Docs Coder');
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: '/repo/README.md', content: '# Doc' },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: '/repo/src/feature.ts', content: 'export {}' },
        toolOutput: 'ok',
      },
    ]);

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.find((r) => r.id === jobId)).toBeTruthy();
  });

  it('un preneur de notes sans skill dev ne qualifie pas non plus, CLI ou pas', async () => {
    const agentId = await makeAgent('Nodal Notes Writer', []);
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'file_write',
      toolInput: { path: 'notes/reunion.md', content: '# CR' },
      toolOutput: '{"ok":true}',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.find((r) => r.id === jobId)).toBeUndefined();
  });

  it('session dev sans chemin ancrable : repli sur l’UNIQUE workspace de l’agent', async () => {
    const agentId = await makeAgent('Solo Workspace Coder');
    const jobId = await makeJob(agentId, 'completed');
    await _testDb!.insert(agentWorkspaces).values({
      entityId: _testEntityId,
      agentId,
      label: 'app',
      path: 'D:\\Projets\\MonApp',
    });

    // Chemin relatif dont le fichier n'existe pas sur CE disque : la
    // résolution par existence échoue, l'entité a plusieurs workspaces →
    // aucun ancrage par fichier. Le repli = le seul workspace de l'AGENT.
    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'file_edit',
      toolInput: { path: 'src/main.ts', old_string: 'a', new_string: 'b' },
      toolOutput: '{"ok":true}',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data.find((r) => r.id === jobId);
    expect(row).toBeTruthy();
    expect(row?.projectPath).toBe('D:/Projets/MonApp');
    expect(row?.projectName).toBe('MonApp');
  });

  it('sessionType : verdicts sans édition = review, et « PR #n » dans la tâche = pr_review', async () => {
    const agentId = await makeAgent('Session Type Reviewer');

    // Une review de PR — le cas MCP typique : la session Claude Code de
    // Quentin demande à Nodal « review la PR #12 ».
    const [prJob] = await _testDb!
      .insert(agentJobs)
      .values({
        entityId: _testEntityId,
        agentId,
        status: 'completed',
        channel: 'mcp',
        task: 'Review PR #12 on nodal-agents and give a verdict',
      })
      .returning();
    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId: prJob!.id,
      toolName: 'review_verdict',
      toolInput: { verdict: 'approve' },
      toolOutput: '{"verdict":"approve","summary":"LGTM"}',
    });

    // Une review classique — mêmes signaux, tâche sans référence de PR.
    const [plainJob] = await _testDb!
      .insert(agentJobs)
      .values({
        entityId: _testEntityId,
        agentId,
        status: 'completed',
        channel: 'api',
        task: 'Review the changes Dev C just made to the auth module',
      })
      .returning();
    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId: plainJob!.id,
      toolName: 'review_verdict',
      toolInput: { verdict: 'request_changes' },
      toolOutput: '{"verdict":"request_changes","summary":"missing tests"}',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.find((r) => r.id === prJob!.id)?.sessionType).toBe('pr_review');
    expect(result.data.find((r) => r.id === plainJob!.id)?.sessionType).toBe('review');
  });
});
