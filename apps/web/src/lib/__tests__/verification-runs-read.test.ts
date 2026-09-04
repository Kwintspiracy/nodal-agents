// verification-runs-read.test.ts — la lecture des preuves dans le détail de
// run (T24 / D9) : tout le pipeline, borné à l'espace, la trace D8 et non le
// réglage courant, un livrable sans commandes nommé. Chaque cas part de lignes
// réelles écrites en base et lit ce que l'action rend.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  entities,
  users,
  agents,
  agentJobs,
  cliRuns,
  verificationRuns,
  jobDeliverableVerificationState,
} from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let rootJobId: string;
let delegateJobId: string;
let neighbourJobId: string;

const MARQUEUR = 'ZIGGURAT-VOISIN-7f3a';
const ALL = { codeTask: true, cliRuntime: true, fileOps: true, shell: true };
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
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
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

const actions = () => import('../actions.ts');

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  // Le pipeline : une racine terminée et un délégué qui a écrit dans le projet.
  const [root] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'Racine du pipeline',
      status: 'completed',
    })
    .returning();
  rootJobId = root!.id;
  const [delegate] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'Délégué du pipeline',
      status: 'completed',
      parentJobId: rootJobId,
    })
    .returning();
  delegateJobId = delegate!.id;

  // Le voisin : un autre espace, avec son agent, son job et SA preuve.
  const [other] = await testDb
    .insert(users)
    .values({ email: `voisin-${Date.now()}@example.com` })
    .returning();
  const [otherEntity] = await testDb
    .insert(entities)
    .values({ userId: other!.id, name: 'Espace voisin', slug: `voisin-${Date.now()}` })
    .returning();
  const [otherAgent] = await testDb
    .insert(agents)
    .values({
      entityId: otherEntity!.id,
      name: `${MARQUEUR}-agent`,
      slug: `agent-voisin-${Date.now()}`,
      personality: 'privée',
    })
    .returning();
  const [neighbourJob] = await testDb
    .insert(agentJobs)
    .values({
      entityId: otherEntity!.id,
      agentId: otherAgent!.id,
      channel: 'api',
      task: `${MARQUEUR} tâche du voisin`,
      status: 'completed',
    })
    .returning();
  neighbourJobId = neighbourJob!.id;

  const t0 = new Date('2026-09-04T09:00:00Z');
  const t1 = new Date('2026-09-04T09:05:00Z');
  await testDb.insert(verificationRuns).values([
    // S1 sur le DÉLÉGUÉ, rangs insérés à l'envers.
    {
      jobId: delegateJobId,
      entityId: seed.entityId,
      deliverableType: 'code_project',
      canonicalKey: 'd:/apps/projet',
      sequenceId: S1,
      commandRank: 2,
      command: 'pnpm test',
      exitCode: 1,
      outcomeKind: 'exit',
      durationMs: 4200,
      verdict: 'red',
      testedGeneration: 3,
      testedEpoch: 0,
      createdAt: t0,
    },
    {
      jobId: delegateJobId,
      entityId: seed.entityId,
      deliverableType: 'code_project',
      canonicalKey: 'd:/apps/projet',
      sequenceId: S1,
      commandRank: 1,
      command: 'pnpm typecheck',
      exitCode: 0,
      outcomeKind: 'exit',
      durationMs: 1500,
      verdict: 'green',
      testedGeneration: 3,
      testedEpoch: 0,
      createdAt: t0,
    },
    // S2 sur la RACINE, plus tard.
    {
      jobId: rootJobId,
      entityId: seed.entityId,
      deliverableType: 'code_project',
      canonicalKey: 'd:/apps/projet',
      sequenceId: S2,
      commandRank: 1,
      command: 'pnpm lint',
      exitCode: 0,
      outcomeKind: 'exit',
      durationMs: 800,
      verdict: 'green',
      testedGeneration: 4,
      testedEpoch: 0,
      createdAt: t1,
    },
    // La preuve du voisin — ne doit jamais apparaître ici.
    {
      jobId: neighbourJobId,
      entityId: otherEntity!.id,
      deliverableType: 'code_project',
      canonicalKey: `d:/apps/${MARQUEUR}`,
      sequenceId: '33333333-3333-4333-8333-333333333333',
      commandRank: 1,
      command: `echo ${MARQUEUR}`,
      exitCode: 0,
      outcomeKind: 'exit',
      durationMs: 1,
      verdict: 'green',
      createdAt: t1,
    },
  ]);

  // Un tour de chat : une ligne cli_runs sans job.
  await testDb.insert(cliRuns).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    provider: 'claude',
    mode: 'write',
    sessionId: 'sess-chat-t24',
  });
});

describe('getCodingProcessDetailAction — verification (T24)', () => {
  it('lit les runs de tout le pipeline : le détail de la RACINE rend la preuve du délégué, groupée et triée', async () => {
    const { getCodingProcessDetailAction } = await actions();
    const r = await getCodingProcessDetailAction({ jobId: rootJobId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seqs = r.data.verificationRuns;
    expect(seqs.map((s) => s.sequenceId)).toEqual([S1, S2]);
    expect(seqs[0]!.jobId).toBe(delegateJobId);
    expect(seqs[0]!.runs.map((x) => [x.commandRank, x.command, x.exitCode, x.verdict])).toEqual([
      [1, 'pnpm typecheck', 0, 'green'],
      [2, 'pnpm test', 1, 'red'],
    ]);
    expect(seqs[0]!.verdict).toBe('red');
    expect(seqs[0]!.runs[1]!.durationMs).toBe(4200);
    expect(seqs[0]!.runs[1]!.testedGeneration).toBe(3);
    expect(seqs[1]!.jobId).toBe(rootJobId);
    expect(seqs[1]!.runs.map((x) => x.command)).toEqual(['pnpm lint']);
    expect(seqs[1]!.verdict).toBe('green');
  });

  it('borné à l’espace : la preuve du voisin est absente, et son job est introuvable', async () => {
    const { getCodingProcessDetailAction } = await actions();
    const r = await getCodingProcessDetailAction({ jobId: rootJobId });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(MARQUEUR);
    const voisin = await getCodingProcessDetailAction({ jobId: neighbourJobId });
    expect(voisin.ok).toBe(false);
    if (!voisin.ok) expect(voisin.code).toBe('not_found');
  });

  it('session de chat ⇒ preuves, trace et non-configurés vides', async () => {
    const { getCodingProcessDetailAction } = await actions();
    const r = await getCodingProcessDetailAction({ sessionId: 'sess-chat-t24' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.header.stage).toBe('chat');
    expect(r.data.verificationRuns).toEqual([]);
    expect(r.data.verificationSkippedSurfaces).toEqual([]);
    expect(r.data.verificationUnconfigured).toEqual([]);
  });

  it('surface décochée ⇒ la trace du pipeline remonte, fusionnée dans l’ordre des clés', async () => {
    const { getCodingProcessDetailAction } = await actions();
    await testDb
      .update(agentJobs)
      .set({ verificationSkippedSurfaces: ['fileOps'] })
      .where(eq(agentJobs.id, rootJobId));
    await testDb
      .update(agentJobs)
      .set({ verificationSkippedSurfaces: ['shell', 'fileOps'] })
      .where(eq(agentJobs.id, delegateJobId));
    const r = await getCodingProcessDetailAction({ jobId: rootJobId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.verificationSkippedSurfaces).toEqual(['fileOps', 'shell']);
  });

  it('le réglage changé après coup ne réécrit pas l’histoire : la mention vient de la trace', async () => {
    const { getCodingProcessDetailAction } = await actions();
    await testDb
      .update(agentJobs)
      .set({ verificationSkippedSurfaces: ['fileOps'] })
      .where(eq(agentJobs.id, rootJobId));
    await testDb
      .update(agentJobs)
      .set({ verificationSkippedSurfaces: [] })
      .where(eq(agentJobs.id, delegateJobId));
    // Tout recoché AUJOURD'HUI dans l'espace…
    await testDb
      .update(entities)
      .set({ verificationSurfaces: ALL })
      .where(eq(entities.id, seed.entityId));
    const r = await getCodingProcessDetailAction({ jobId: rootJobId });
    expect(r.ok).toBe(true);
    // …et le run d'HIER dit toujours qu'il n'a pas été vérifié.
    if (r.ok) expect(r.data.verificationSkippedSurfaces).toEqual(['fileOps']);
  });

  it('un livrable sans commandes (ou en attente d’approbation) est nommé ; un livrable vert ne l’est pas', async () => {
    const { getCodingProcessDetailAction } = await actions();
    await testDb.insert(jobDeliverableVerificationState).values([
      {
        jobId: rootJobId,
        deliverableType: 'code_project',
        canonicalKey: 'd:/apps/sans-commandes',
        displayPathSnapshot: 'D:\\APPS\\sans-commandes',
        dirtyGeneration: 1,
        decisionStatus: 'not_configured',
      },
      {
        jobId: delegateJobId,
        deliverableType: 'code_project',
        canonicalKey: 'd:/apps/en-attente',
        displayPathSnapshot: 'D:\\APPS\\en-attente',
        dirtyGeneration: 2,
        decisionStatus: 'pending_approval',
      },
      {
        jobId: rootJobId,
        deliverableType: 'code_project',
        canonicalKey: 'd:/apps/projet',
        displayPathSnapshot: 'D:\\APPS\\projet',
        dirtyGeneration: 4,
        verifiedGeneration: 4,
        decisionStatus: 'green',
      },
    ]);
    const r = await getCodingProcessDetailAction({ jobId: rootJobId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byKey = new Map(r.data.verificationUnconfigured.map((u) => [u.canonicalKey, u]));
    expect(Array.from(byKey.keys()).sort()).toEqual([
      'd:/apps/en-attente',
      'd:/apps/sans-commandes',
    ]);
    expect(byKey.get('d:/apps/sans-commandes')).toMatchObject({
      reason: 'not_configured',
      displayPath: 'D:\\APPS\\sans-commandes',
      deliverableType: 'code_project',
    });
    expect(byKey.get('d:/apps/en-attente')).toMatchObject({ reason: 'pending_approval' });
  });
});
