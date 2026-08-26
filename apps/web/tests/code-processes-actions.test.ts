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
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _setMasterKeyForTests, _resetMasterKeyCacheForTests } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
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

  // De VRAIS dossiers sur le disque, pas des chemins inventés.
  //
  // Depuis le 26/08, la dérivation vérifie qu'un projet existe encore avant de
  // l'afficher (constat Quentin : « des dossiers supprimés apparaissent malgré
  // tout »). Des chemins fictifs comme `/repo` rendraient donc cette suite
  // entièrement décorative : tout serait filtré, et les assertions négatives
  // passeraient pour de mauvaises raisons.
  _tmpRoot = (await mkdtemp(join(tmpdir(), 'nodal-code-tab-'))).replace(/\\/g, '/');
  DEV_FOLDER = `${_tmpRoot}/repo`;
  VAULT = `${_tmpRoot}/vault`;
  for (const d of [
    `${DEV_FOLDER}/monapp`,
    `${DEV_FOLDER}/app`,
    `${DEV_FOLDER}/src`,
    `${DEV_FOLDER}/mock-data`,
    `${DEV_FOLDER}/deploy`,
    `${VAULT}/Journal`,
    `${VAULT}/Notes`,
    `${VAULT}/notes`,
    `${VAULT}/scripts`,
  ]) {
    await mkdir(d, { recursive: true });
  }

  // Les dossiers de l'agent de base. Un seul jeu suffit pour tout le fichier —
  // la lecture se fait par ESPACE, pas par agent.
  await db.insert(agentWorkspaces).values([
    { entityId: _testEntityId, agentId: seed.agentId, label: 'repo', path: DEV_FOLDER },
    { entityId: _testEntityId, agentId: seed.agentId, label: 'vault', path: VAULT },
  ]);
});

let _tmpRoot = '';
/** Le dossier de travail « code » de cette suite. */
let DEV_FOLDER = '';
/** Le coffre de notes. Depuis le 26/08 il apparaît AUSSI — et se masque. */
let VAULT = '';

afterAll(async () => {
  _resetMasterKeyCacheForTests();
  _testDb = null;
  vi.restoreAllMocks();
  if (_tmpRoot) await rm(_tmpRoot, { recursive: true, force: true });
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
 * Un agent et ses dossiers.
 *
 * `folders` par défaut = le dossier de code seul. `'vault'` y ajoute le coffre
 * de notes — c'est ce qui fabrique l'agent POLYVALENT, celui qui code le matin
 * et range ses notes l'après-midi. `'none'` fabrique un agent sans aucun
 * dossier : ses écritures ne sont rattachables à rien.
 */
async function makeAgent(
  name: string,
  opts: { folders?: 'repo' | 'repo+vault' | 'vault' | 'none' } = {},
): Promise<string> {
  const folders = opts.folders ?? 'repo';
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
  const values: Array<{ entityId: string; agentId: string; label: string; path: string }> = [];
  if (folders === 'repo' || folders === 'repo+vault') {
    values.push({ entityId: _testEntityId, agentId: row.id, label: 'repo', path: DEV_FOLDER });
  }
  if (folders === 'vault' || folders === 'repo+vault') {
    values.push({ entityId: _testEntityId, agentId: row.id, label: 'vault', path: VAULT });
  }
  if (values.length > 0) await _testDb!.insert(agentWorkspaces).values(values);
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
        toolInput: { file_path: `${DEV_FOLDER}/src/auth.ts`, old_string: 'a', new_string: 'b' },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Edit',
        toolInput: { file_path: `${DEV_FOLDER}/src/auth.ts`, old_string: 'b', new_string: 'c' },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: `${DEV_FOLDER}/src/auth.test.ts`, content: 'test content' },
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
        toolInput: { file_path: `${DEV_FOLDER}/src/ghost.ts`, content: 'never written' },
        toolOutput:
          '<tool_use_error>Error: No such tool available: Write. Write is disabled for this session, in subagents as well as here.</tool_use_error>',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Read',
        toolInput: { file_path: `${DEV_FOLDER}/src/real.ts` },
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
        toolInput: { file_path: `${DEV_FOLDER}/src/ghost.ts`, content: 'never written' },
        toolOutput: '<tool_use_error>Error: No such tool available: Write.</tool_use_error>',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: `${DEV_FOLDER}/src/real.ts`, content: 'written for real' },
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
    // Le chemin s'affiche RELATIF au dossier, maintenant que `/repo` est un
    // workspace de l'agent — c'est la canonicalisation existante, et c'est la
    // forme la plus lisible.
    expect(detail.data.changes[0]!.filePath).toBe('src/real.ts');
    // The refused attempt still exists in the timeline — it is the signal
    // that the agent's posture is wrong, not something to hide.
    const calls = detail.data.activity.filter((a) => a.kind === 'call');
    expect(calls).toHaveLength(2);
  });

  it('the CLI absolute path and the Nodal workspace-relative path of the SAME file count as ONE (job cbdbfc6c)', async () => {
    const agentId = await makeAgent('Audit Path Canon Agent', { folders: 'none' });
    // The agent's workspace root — the prefix the canonicalizer must strip.
    // Un VRAI dossier : la dérivation vérifie l'existence du projet depuis le
    // 26/08, et un chemin inventé rendrait ce test décoratif.
    const canonRoot = `${_tmpRoot}/canon`;
    await mkdir(`${canonRoot}/outputs/app`, { recursive: true });
    await _testDb!.insert(agentWorkspaces).values({
      entityId: _testEntityId,
      agentId,
      label: 'dev',
      path: canonRoot,
    });
    const jobId = await makeJob(agentId, 'completed');

    // The recorded real shape of job cbdbfc6c: cli:Write with the ABSOLUTE
    // path, then file_write with the workspace-RELATIVE path — the same
    // index.html, written twice through two tool families.
    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: {
          file_path: `${canonRoot}/outputs/app/index.html`,
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
        toolInput: { path: `${DEV_FOLDER}/src/reviewed.ts`, old_string: 'a', new_string: 'b' },
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
      toolInput: { file_path: `${DEV_FOLDER}/src/done.ts`, content: 'done' },
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

  it('un .pptx écrit hors de tout dossier attaché reste EXCLU — faute de savoir où le ranger', async () => {
    // Ce test a longtemps prouvé qu'on savait reconnaître un agent
    // bureautique. On ne cherche plus : ce qui l'exclut ici, c'est que
    // `/workspace/...` n'est couvert par aucun dossier de l'agent. L'extension
    // n'entre pas dans le calcul — un .pptx écrit dans un dossier attaché
    // apparaîtrait, et se masquerait comme le reste.
    const agentId = await makeAgent('Audit Code Office Agent', { folders: 'none' });
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
      toolInput: { file_path: `${DEV_FOLDER}/readme.md` },
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
      toolInput: { file_path: `${DEV_FOLDER}/x.ts`, content: 'x' },
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

// ─── Définition v8 (décision Quentin 26/08) ───────────────────────────────────
// L'onglet ne devine plus RIEN. Il montre les dossiers où les agents ont
// écrit ; ce qu'on ne veut pas voir, on le masque. Six définitions du « vrai
// code » ont été essayées avant d'en arriver là (migration 0086 les liste), et
// chacune se cassait sur un cas réel.
//
// Les tests ci-dessous encodent le renversement : là où la v6/v7 prouvaient
// qu'un coffre de notes RESTAIT DEHORS, on prouve désormais qu'il ENTRE — et
// qu'un seul geste l'en sort, sans jamais toucher le dossier.

describe('listCodingProcessesAction — v8, on range au lieu de deviner', () => {
  it('le coffre de notes ENTRE dans la liste — c’est le prix assumé de ne plus deviner', async () => {
    // Ce test disait exactement l'inverse jusqu'au 26/08. Le renversement est
    // délibéré : les six façons de reconnaître « du vrai code » écartaient
    // aussi du vrai travail, en silence. Un coffre visible qu'on masque en un
    // clic vaut mieux qu'un projet absent dont rien ne signale l'absence.
    const agentId = await makeAgent('Vault Notes Agent', { folders: 'vault' });
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: `${VAULT}/Notes/idees.md`, content: '# Idées' },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Edit',
        toolInput: {
          file_path: `${VAULT}/Journal/2026-08-25.md`,
          old_string: 'a',
          new_string: 'b',
        },
        toolOutput: 'ok',
      },
    ]);

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data.find((r) => r.id === jobId);
    expect(row, 'un travail réel a été filtré alors que plus rien ne filtre').toBeTruthy();
    // Et il est rangé sous le bon projet : les sous-dossiers du coffre.
    expect([`${VAULT}/Notes`, `${VAULT}/Journal`]).toContain(row?.projectPath);
  });

  it('MASQUER un projet le retire de la liste, sans toucher au dossier', async () => {
    // LE geste qui remplace le filtrage. Il est réversible, il est explicite,
    // et il porte jusqu'au contexte des agents (prouvé côté runner dans
    // apps/runner/src/tests/job/code-projects-context.test.ts).
    const { listCodingProcessesAction, setCodeProjectHiddenAction, listCodeProjectPrefsAction } =
      await import('../src/lib/actions.ts');
    const agentId = await makeAgent('Comfy Output Writer', { folders: 'vault' });
    const jobId = await makeJob(agentId, 'completed');
    const projet = `${VAULT}/notes`;

    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'file_write',
      toolInput: { path: `${projet}/bruit.md`, content: '# bruit' },
      toolOutput: '{"ok":true}',
    });

    const avant = await listCodingProcessesAction();
    expect(avant.ok).toBe(true);
    if (!avant.ok) return;
    expect(avant.data.find((r) => r.id === jobId)?.projectPath).toBe(projet);

    const hide = await setCodeProjectHiddenAction({ projectPath: projet, hidden: true });
    expect(hide.ok, hide.ok ? '' : hide.message).toBe(true);

    // La ligne EXISTE en base et porte `hidden` — c'est elle que la page et le
    // runner lisent pour écarter le projet.
    const prefs = await listCodeProjectPrefsAction();
    expect(prefs.ok).toBe(true);
    if (prefs.ok) {
      expect(
        prefs.data.find((p) => p.projectPath === projet)?.hidden,
        'le masquage n’a rien écrit',
      ).toBe(true);
    }

    // Le dossier réel n'a pas bougé — masquer est un choix d'affichage.
    expect(existsSync(projet), 'masquer a touché le dossier sur le disque').toBe(true);

    await setCodeProjectHiddenAction({ projectPath: projet, hidden: false });
  });

  it('RENOMMER un projet change le nom affiché, le chemin reste la vérité', async () => {
    const { listCodingProcessesAction, renameCodeProjectAction, getCodingProcessDetailAction } =
      await import('../src/lib/actions.ts');
    const agentId = await makeAgent('Named Project Coder');
    const jobId = await makeJob(agentId, 'completed');
    const projet = `${DEV_FOLDER}/monapp`;

    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'file_write',
      toolInput: { path: `${projet}/index.ts`, content: 'export {}' },
      toolOutput: '{"ok":true}',
    });

    const avant = await listCodingProcessesAction();
    expect(avant.ok).toBe(true);
    if (!avant.ok) return;
    expect(avant.data.find((r) => r.id === jobId)?.projectName).toBe('monapp');

    const renamed = await renameCodeProjectAction({
      projectPath: projet,
      displayName: 'Portail client',
    });
    expect(renamed.ok, renamed.ok ? '' : renamed.message).toBe(true);

    // Le DÉTAIL d'une session titre avec le même nom : ouvrir une session ne
    // doit pas donner l'impression de changer de projet.
    const detail = await getCodingProcessDetailAction({ jobId });
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.data.header.projectName, 'le détail ignore le nom choisi').toBe(
        'Portail client',
      );
      expect(detail.data.header.projectPath, 'le chemin a été altéré par le renommage').toBe(
        projet,
      );
    }

    await renameCodeProjectAction({ projectPath: projet, displayName: '' });
  });

  it('le MÊME markdown, écrit dans un dossier de code, est le README d’un projet', async () => {
    // On ne juge jamais l'extension — « une exclusion par langage ratera tôt ou
    // tard du vrai code », et elle rate aussi la doc d'un vrai projet.
    const agentId = await makeAgent('Doc Writing Coder');
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'cli:Write',
      toolInput: { file_path: `${DEV_FOLDER}/monapp/README.md`, content: '# MonApp' },
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

  it('une écriture rattachable à AUCUN dossier reste dehors — rien à afficher', async () => {
    // La seule exclusion qui subsiste, et elle ne devine rien : sans dossier
    // qui couvre le chemin, il n'y a ni projet à nommer ni ligne où ranger la
    // session.
    const agentId = await makeAgent('Orphan Path Writer', { folders: 'none' });
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'cli:Write',
      toolInput: { file_path: `${_tmpRoot}/nulle-part/export.py`, content: 'print(1)' },
      toolOutput: 'ok',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.data.find((r) => r.id === jobId),
      'une écriture qu’aucun dossier ne couvre a produit une ligne',
    ).toBeUndefined();
  });

  it('un projet dont le DOSSIER a été supprimé disparaît de la liste', async () => {
    // Constat Quentin (26/08), de bout en bout cette fois : les tool_calls
    // restent en base pour toujours, le dossier non. L'interface ne vérifiait
    // pas l'existence alors que le contexte injecté aux agents, lui, le
    // faisait — les deux vues se contredisaient.
    const agentId = await makeAgent('Deleted Project Coder');
    const jobId = await makeJob(agentId, 'completed');
    const projet = `${DEV_FOLDER}/ephemere`;
    await mkdir(projet, { recursive: true });

    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId,
      toolName: 'file_write',
      toolInput: { path: `${projet}/a.ts`, content: 'export {}' },
      toolOutput: '{"ok":true}',
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const avant = await listCodingProcessesAction();
    expect(avant.ok).toBe(true);
    if (!avant.ok) return;
    expect(avant.data.find((r) => r.id === jobId)?.projectPath).toBe(projet);

    await rm(projet, { recursive: true, force: true });

    const apres = await listCodingProcessesAction();
    expect(apres.ok).toBe(true);
    if (!apres.ok) return;
    const row = apres.data.find((r) => r.id === jobId);
    // Le PROJET disparaît — c'est le constat de Quentin. La session, elle,
    // reste : elle a bien eu lieu, et l'effacer réécrirait l'histoire. Elle
    // tombe dans « Other sessions », et surtout PAS sous le dossier conteneur,
    // ce qui ferait réapparaître le travail supprimé sous un autre nom.
    expect(
      row?.projectPath,
      'un dossier supprimé apparaît encore comme projet dans l’onglet',
    ).toBeNull();
    expect(
      apres.data.some((r) => r.projectPath === projet),
      'le projet supprimé subsiste sur une autre session',
    ).toBe(false);
  });

  it('une NOUVELLE app dont toutes les écritures ont été REFUSÉES reste visible', async () => {
    // Constat P1 de la revue Codex (26/08), et le cas le plus important de
    // l'onglet : un agent tente de créer une app, chaque écriture est refusée,
    // et il ne dit rien. C'est la panne la plus dure à diagnostiquer — Dev C,
    // neuf tentatives, neuf refus, une journée perdue.
    //
    // Le dossier n'existe pas, précisément parce que rien n'a abouti. Qualifier
    // via la dérivation de projet filtrait donc la session entière : l'onglet
    // cachait exactement ce qu'il existe pour montrer. La qualification demande
    // maintenant « l'écriture visait-elle un dossier attaché ? », sans exiger
    // que le projet existe.
    const agentId = await makeAgent('Failed New App Coder');
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: `${DEV_FOLDER}/nouvelle-app/index.ts`, content: 'export {}' },
        toolOutput: '<tool_use_error>No such tool available: Write.</tool_use_error>',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: `${DEV_FOLDER}/nouvelle-app/app.tsx`, content: 'export {}' },
        toolOutput: '<tool_use_error>No such tool available: Write.</tool_use_error>',
      },
    ]);

    const { listCodingProcessesAction, getCodingProcessDetailAction } =
      await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data.find((r) => r.id === jobId);
    expect(row, 'la session qui échoue à créer une app a été filtrée de l’onglet').toBeTruthy();

    // Le DÉTAIL doit dire la même chose (revue Codex, 26/08). Il écartait les
    // appels refusés avant de décider, croyait donc n'avoir rien à ancrer, et
    // le repli lui faisait nommer un projet que la liste ne nommait pas.
    const detail = await getCodingProcessDetailAction({ jobId });
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(
        detail.data.header.projectPath,
        'le détail nomme un projet que la liste laisse dans « Other sessions »',
      ).toBeNull();
      expect(detail.data.header.filesChanged).toBe(0);
    }
    // Honnête sur le résultat : rien n'a été écrit.
    expect(row?.filesChanged, 'une écriture refusée a été comptée comme un fichier').toBe(0);
    // Aucun projet à nommer — rien n'a abouti. La session vit dans le tiroir
    // « Other sessions », et surtout PAS sous le dossier conteneur : l'y
    // ranger inventerait un projet à partir d'un échec.
    expect(row?.projectPath, 'un projet a été inventé à partir d’écritures refusées').toBeNull();
    expect(
      result.data.some((r) => r.projectPath === `${DEV_FOLDER}/nouvelle-app`),
      'le dossier jamais créé apparaît comme projet',
    ).toBe(false);
  });

  it('MASQUER un dossier retire TOUS ses projets d’un seul geste', async () => {
    // Constat de Quentin (26/08) : son coffre Obsidian produisait 8 projets, un
    // par dossier de premier niveau où l'agent avait écrit, et rien ne borne ce
    // nombre. Masquer projet par projet ne tient pas à cette échelle.
    //
    // Ici : trois sujets dans le coffre, trois lignes. Une case, zéro ligne.
    const {
      listCodingProcessesAction,
      setWorkspaceHiddenFromCodeAction,
      listAgentWorkspacesAction,
    } = await import('../src/lib/actions.ts');
    const agentId = await makeAgent('Vault Sujet Writer', { folders: 'vault' });

    const jobIds: string[] = [];
    for (const sujet of ['Physique', 'Sante', 'Warhammer']) {
      await mkdir(`${VAULT}/${sujet}`, { recursive: true });
      const jobId = await makeJob(agentId, 'completed');
      jobIds.push(jobId);
      await _testDb!.insert(toolCalls).values({
        entityId: _testEntityId,
        jobId,
        toolName: 'file_write',
        toolInput: { path: `${VAULT}/${sujet}/note.md`, content: '# note' },
        toolOutput: '{"ok":true}',
      });
    }

    const avant = await listCodingProcessesAction();
    expect(avant.ok).toBe(true);
    if (!avant.ok) return;
    const projetsAvant = new Set(
      avant.data.filter((r) => jobIds.includes(r.id)).map((r) => r.projectPath),
    );
    expect(projetsAvant.size, 'chaque sujet du coffre devrait être un projet distinct').toBe(3);

    // LE geste : une case sur le dossier.
    const list = await listAgentWorkspacesAction(agentId);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const coffre = list.data.find((w) => w.path === VAULT);
    expect(coffre, 'le coffre n’est pas attaché à cet agent').toBeTruthy();

    const hide = await setWorkspaceHiddenFromCodeAction(coffre!.id, true);
    expect(hide.ok, hide.ok ? '' : hide.message).toBe(true);

    try {
      const apres = await listCodingProcessesAction();
      expect(apres.ok).toBe(true);
      if (!apres.ok) return;
      expect(
        apres.data.filter((r) => jobIds.includes(r.id)),
        'les projets du coffre masqué sont encore dans l’onglet',
      ).toHaveLength(0);
    } finally {
      await setWorkspaceHiddenFromCodeAction(coffre!.id, false);
    }
  });

  it('la case se propage à TOUS les agents qui partagent le dossier', async () => {
    // Sur cette install `Documents/Dev` est attaché à cinq agents. Masquer
    // serait cinq gestes, et l'état mi-masqué n'aurait aucun sens : un dossier
    // est un coffre de notes ou non, cela ne dépend pas de qui le regarde.
    const { setWorkspaceHiddenFromCodeAction, listAgentWorkspacesAction } =
      await import('../src/lib/actions.ts');
    const un = await makeAgent('Partage Un', { folders: 'vault' });
    const deux = await makeAgent('Partage Deux', { folders: 'vault' });

    const listUn = await listAgentWorkspacesAction(un);
    expect(listUn.ok).toBe(true);
    if (!listUn.ok) return;
    const wsUn = listUn.data.find((w) => w.path === VAULT)!;

    const r = await setWorkspaceHiddenFromCodeAction(wsUn.id, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.updated, 'la bascule n’a touché qu’une ligne').toBeGreaterThan(1);

    try {
      const listDeux = await listAgentWorkspacesAction(deux);
      expect(listDeux.ok).toBe(true);
      if (!listDeux.ok) return;
      expect(
        listDeux.data.find((w) => w.path === VAULT)?.hiddenFromCode,
        'le second agent affiche une case vide sur un dossier masqué',
      ).toBe(true);

      // Et un agent qui l'attache APRÈS coup hérite de l'état.
      const troisieme = await makeAgent('Partage Trois', { folders: 'none' });
      const { addAgentWorkspaceAction } = await import('../src/lib/actions.ts');
      const added = await addAgentWorkspaceAction(troisieme, 'vault', VAULT);
      expect(added.ok, added.ok ? '' : added.message).toBe(true);
      const listTrois = await listAgentWorkspacesAction(troisieme);
      expect(listTrois.ok).toBe(true);
      if (!listTrois.ok) return;
      expect(
        listTrois.data.find((w) => w.path === VAULT)?.hiddenFromCode,
        'un dossier déjà masqué revient visible en l’attachant à un nouvel agent',
      ).toBe(true);
    } finally {
      await setWorkspaceHiddenFromCodeAction(wsUn.id, false);
    }
  });

  it('un pipeline ne compte QUE les fichiers rattachables', async () => {
    // Constat P2 de la revue Codex : une seule écriture rattachable qualifiait
    // le pipeline, et tout le reste suivait — y compris des chemins qu'aucun
    // dossier ne couvre.
    const agentId = await makeAgent('Mixed Perimeter Coder');
    const jobId = await makeJob(agentId, 'completed');

    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'file_write',
        toolInput: { path: `${DEV_FOLDER}/app/index.ts`, content: 'export {}' },
        toolOutput: '{"ok":true}',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'file_write',
        toolInput: { path: `${_tmpRoot}/dehors/note.md`, content: '# hors sujet' },
        toolOutput: '{"ok":true}',
      },
    ]);

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data.find((r) => r.id === jobId);
    expect(row, 'le pipeline aurait dû qualifier par son écriture rattachable').toBeTruthy();
    expect(row?.filesChanged, 'un fichier non rattachable a été compté').toBe(1);
  });

  it('chaîne à 3 niveaux : l’écriture du worker remonte au pipeline racine', async () => {
    // Constat majeur des deux relecteurs (25/08). L'orchestrateur délègue au
    // lead, qui délègue au worker ; c'est le worker qui écrit, et le pipeline
    // entier doit apparaître sous une seule ligne — celle de la racine.
    const orchestrateur = await makeAgent('Chain Orchestrator', { folders: 'none' });
    const lead = await makeAgent('Chain Lead Dev');
    const worker = await makeAgent('Chain Worker');

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
      'l’écriture était au bout de la chaîne : le pipeline a disparu',
    ).toBeTruthy();
  });

  it('un RELECTEUR entre aussi dans l’onglet — review_verdict est un signal de code', async () => {
    const agentId = await makeAgent('Reviewer Agent');
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
        toolInput: { file_path: `${DEV_FOLDER}/README.md`, content: '# Doc' },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: `${DEV_FOLDER}/src/feature.ts`, content: 'export {}' },
        toolOutput: 'ok',
      },
    ]);

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.find((r) => r.id === jobId)).toBeTruthy();
  });

  it('sans aucun chemin exploitable, le projet est l’unique dossier de l’agent', async () => {
    // Une review pure n'écrit aucun fichier : rien à ancrer. Le repli est
    // l'unique dossier de l'agent — sans lui, ce travail disparaîtrait de
    // l'onglet faute d'avoir touché un fichier. Un agent à 0 ou 2+ dossiers
    // reste dans le tiroir « Autres » : on ne devine pas.
    const agentId = await makeAgent('Solo Workspace Coder', { folders: 'none' });
    const jobId = await makeJob(agentId, 'completed');
    const solo = `${_tmpRoot}/MonApp`;
    await mkdir(solo, { recursive: true });
    await _testDb!.insert(agentWorkspaces).values({
      entityId: _testEntityId,
      agentId,
      label: 'app',
      path: solo,
    });

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
    const row = result.data.find((r) => r.id === jobId);
    expect(row, 'une review sans edition a disparu de l onglet').toBeTruthy();
    expect(row?.projectPath).toBe(solo);
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
