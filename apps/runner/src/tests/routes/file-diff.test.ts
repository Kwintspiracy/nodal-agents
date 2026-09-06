// file-diff.test.ts — GET /api/jobs/:jobId/file-diff (P11).
//
// Un VRAI dépôt fantôme dans un dossier temporaire, un vrai `git`, de vraies
// lignes `tool_calls` et `job_checkpoints` : ce qui est asserté est le texte du
// diff que l'écran affichera, pas la forme de la réponse. Un test qui se
// contenterait de `kind === 'diff'` passerait sur une implémentation qui rend
// le diff du mauvais fichier.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agentWorkspaces,
  entities,
  jobCheckpoints,
  toolCalls,
  users,
  eq,
} from '@nodal-agents/db';
import { snapshot } from '@nodal-agents/checkpoints';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { createApp } from '../../server.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

let db: TestDb;
let app: ReturnType<typeof createApp>;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let store: string;
let ws: string;
const storeAvant = process.env['NODALAI_CHECKPOINTS_ROOT'];

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'claude-sonnet-4-6-20260217',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
  REFLECTION_ENABLED: 'false',
  REFLECTION_MAX_PER_HOUR: 6,
  REFLECTION_MAX_TURNS: 3,
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  CURATOR_MEMORY_STALE_DAYS: 60,
  CURATOR_MEMORY_IMPORTANCE_MAX: 2,
  CURATOR_MEMORY_MIN: 8,
  MEMORY_CURATION_ENABLED: '',
  RETENTION_DAYS: 0,
  SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
  SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
  NODALAI_APPROVAL_GRACE_MS: 0,
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  const registry = createToolRegistry();
  registerBuiltins(registry);
  const deps: RunnerDeps = {
    db: db as RunnerDeps['db'],
    llmClient: createLlmClient({ provider: 'anthropic', model: 'test', apiKey: 'key' }),
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
  app = createApp(deps, testEnv);
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-fd-'));
  store = join(root, 'checkpoints');
  process.env['NODALAI_CHECKPOINTS_ROOT'] = store;
  ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  await db.delete(jobCheckpoints);
  await db.delete(toolCalls);
  await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, seed.agentId));
  await db
    .insert(agentWorkspaces)
    .values({ agentId: seed.agentId, label: 'ws', path: ws, position: 0 });
});

afterEach(async () => {
  if (storeAvant === undefined) delete process.env['NODALAI_CHECKPOINTS_ROOT'];
  else process.env['NODALAI_CHECKPOINTS_ROOT'] = storeAvant;
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

async function callRow(over: {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  turn: number;
  presented?: unknown;
  jobId?: string;
  entityId?: string;
}): Promise<void> {
  await db.insert(toolCalls).values({
    entityId: over.entityId ?? seed.entityId,
    jobId: over.jobId ?? seed.jobId,
    toolCallId: over.toolCallId,
    toolName: over.toolName,
    toolInput: over.toolInput,
    toolOutput: '{"ok":true}',
    turn: over.turn,
    card: 'files',
    presented: over.presented ?? null,
  });
}

const get = (jobId: string, query: string) =>
  app.fetch(new Request(`http://localhost/api/jobs/${jobId}/file-diff?${query}`));

describe('GET /api/jobs/:jobId/file-diff', () => {
  it('file_write : rend le diff réel entre l’instantané du tour et l’arbre de travail', async () => {
    await writeFile(join(ws, 'code.txt'), 'alpha\nbeta\ngamma\n');
    const avant = await snapshot(store, ws, 'tour 1');
    await db
      .insert(jobCheckpoints)
      .values({ jobId: seed.jobId, turn: 1, workspace: ws, sha: avant!.sha });
    // Ce que l'outil a réellement fait après l'instantané.
    await writeFile(join(ws, 'code.txt'), 'alpha\nBETA\ngamma\n');
    await callRow({
      toolCallId: 'call-1',
      toolName: 'file_write',
      toolInput: { path: 'code.txt', content: 'alpha\nBETA\ngamma\n' },
      turn: 1,
    });

    const res = await get(seed.jobId, 'toolCallId=call-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      text: string;
      truncated: boolean;
      path: string;
      from: string;
      to: string;
    };
    expect(body.kind).toBe('diff');
    expect(body.text).toContain('-beta');
    expect(body.text).toContain('+BETA');
    expect(body.path).toBe('code.txt');
    expect(body.from).toBe(avant!.sha);
    expect(body.to, "sans tour suivant, la comparaison porte sur l'arbre de travail").toBe(
      'working_tree',
    );
    expect(body.truncated).toBe(false);
  });

  it('un tour SUIVANT existe : la borne haute est cet instantané, et la réponse le dit', async () => {
    await writeFile(join(ws, 'code.txt'), 'v1\n');
    const t1 = await snapshot(store, ws, 'tour 1');
    await writeFile(join(ws, 'code.txt'), 'v2\n');
    const t2 = await snapshot(store, ws, 'tour 2');
    // Ce qui est écrit APRÈS le tour 2 ne doit PAS apparaître dans le diff du
    // tour 1 : c'est tout l'intérêt de la borne haute.
    await writeFile(join(ws, 'code.txt'), 'v3-ne-doit-pas-apparaitre\n');

    await db.insert(jobCheckpoints).values([
      { jobId: seed.jobId, turn: 1, workspace: ws, sha: t1!.sha },
      { jobId: seed.jobId, turn: 2, workspace: ws, sha: t2!.sha },
    ]);
    await callRow({
      toolCallId: 'call-2',
      toolName: 'file_write',
      toolInput: { path: 'code.txt', content: 'v2\n' },
      turn: 1,
    });

    const body = (await (await get(seed.jobId, 'toolCallId=call-2')).json()) as {
      kind: string;
      text: string;
      to: string;
    };
    expect(body.kind).toBe('diff');
    expect(body.to).toBe('next_turn');
    expect(body.text).toContain('-v1');
    expect(body.text).toContain('+v2');
    expect(body.text).not.toContain('v3-ne-doit-pas-apparaitre');
  });

  it('file_edit : le fragment, sans jamais toucher à git', async () => {
    // Aucun instantané en base pour ce travail : la réponse doit venir de la
    // ligne elle-même, sinon elle serait `no_checkpoint`.
    await callRow({
      toolCallId: 'call-3',
      toolName: 'file_edit',
      toolInput: { path: 'note.md', old_string: 'avant', new_string: 'après' },
      turn: 1,
    });

    const body = (await (await get(seed.jobId, 'toolCallId=call-3')).json()) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      kind: 'fragment',
      oldString: 'avant',
      newString: 'après',
      path: 'note.md',
    });
  });

  it('aucun instantané pour ce travail : no_checkpoint, pas une erreur', async () => {
    await callRow({
      toolCallId: 'call-4',
      toolName: 'file_write',
      toolInput: { path: 'code.txt', content: 'x' },
      turn: 1,
    });
    const body = await (await get(seed.jobId, 'toolCallId=call-4')).json();
    expect(body).toEqual({ kind: 'unavailable', reason: 'no_checkpoint' });
  });

  it('un fichier ignoré par le .gitignore du dossier : not_in_snapshot', async () => {
    await writeFile(join(ws, '.gitignore'), 'secrets.env\n');
    await writeFile(join(ws, 'code.txt'), 'v1\n');
    const t1 = await snapshot(store, ws, 'tour 1');
    await db
      .insert(jobCheckpoints)
      .values({ jobId: seed.jobId, turn: 1, workspace: ws, sha: t1!.sha });
    await writeFile(join(ws, 'secrets.env'), 'CLE=x\n');
    await callRow({
      toolCallId: 'call-5',
      toolName: 'file_write',
      toolInput: { path: 'secrets.env', content: 'CLE=x\n' },
      turn: 1,
    });

    const body = await (await get(seed.jobId, 'toolCallId=call-5')).json();
    expect(body).toEqual({ kind: 'unavailable', reason: 'not_in_snapshot' });
  });

  it('un toolCallId d’un AUTRE travail : 404', async () => {
    const [autre] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'un autre travail',
      })
      .returning({ id: agentJobs.id });
    await callRow({
      toolCallId: 'call-6',
      toolName: 'file_write',
      toolInput: { path: 'code.txt', content: 'x' },
      turn: 1,
      jobId: autre!.id,
    });

    // L'appel existe, mais pas sous CE travail.
    const res = await get(seed.jobId, 'toolCallId=call-6');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'tool_call_not_found' });
  });

  it('un travail d’une AUTRE entité, appelant non de confiance : 404', async () => {
    // Le cadrage par entité (findings #4/#5). `callerTrusted` n'est posé que
    // par la porte d'authentification ; ici on appelle la route directement
    // avec un contexte non de confiance pour éprouver LA garde, pas la porte.
    const [user] = await db
      .insert(users)
      .values({ email: `fd-${Date.now()}@example.com` })
      .returning();
    const [autreEntite] = await db
      .insert(entities)
      .values({ userId: user!.id, name: 'Autre', slug: `autre-${Date.now()}` })
      .returning();
    const [jobAilleurs] = await db
      .insert(agentJobs)
      .values({ entityId: autreEntite!.id, channel: 'api', task: 'ailleurs' })
      .returning({ id: agentJobs.id });

    const { fileDiffRoute } = await import('../../routes/file-diff.ts');
    const ctx = {
      req: {
        param: () => jobAilleurs!.id,
        query: (k: string) => (k === 'toolCallId' ? 'call-7' : undefined),
      },
      get: (k: string) => (k === 'callerTrusted' ? false : seed.entityId),
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), { status: status ?? 200 }),
    };
    const res = await fileDiffRoute(
      ctx as unknown as Parameters<typeof fileDiffRoute>[0],
      { db } as unknown as Parameters<typeof fileDiffRoute>[1],
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'job_not_found' });
  });

  it('le chemin demandé doit figurer sur la carte de la ligne', async () => {
    await writeFile(join(ws, 'code.txt'), 'v1\n');
    await writeFile(join(ws, 'prive.txt'), 'rien à voir\n');
    const t1 = await snapshot(store, ws, 'tour 1');
    await db
      .insert(jobCheckpoints)
      .values({ jobId: seed.jobId, turn: 1, workspace: ws, sha: t1!.sha });
    await writeFile(join(ws, 'code.txt'), 'v2\n');
    await writeFile(join(ws, 'prive.txt'), 'MODIFIÉ AUSSI\n');
    await callRow({
      toolCallId: 'call-8',
      toolName: 'file_write',
      toolInput: { path: 'code.txt', content: 'v2\n' },
      turn: 1,
      presented: {
        card: 'files',
        files: [{ path: 'code.txt', action: 'written' }],
        total: 1,
        truncated: false,
      },
    });

    const declare = await (await get(seed.jobId, 'toolCallId=call-8&path=code.txt')).json();
    expect((declare as { kind: string }).kind).toBe('diff');

    const nonDeclare = await (await get(seed.jobId, 'toolCallId=call-8&path=prive.txt')).json();
    expect(
      nonDeclare,
      'un chemin absent de la carte a été lu — la route deviendrait une lecture de disque libre',
    ).toEqual({ kind: 'unavailable', reason: 'path_unresolved' });
  });
});
