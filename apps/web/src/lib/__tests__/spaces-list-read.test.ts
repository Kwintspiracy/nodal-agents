// spaces-list-read.test.ts — la liste des espaces lue en base : les
// automatisations et les conversations ont chacune leur limite (revue passe
// 22 : une limite globale laissait les cron évincer les conversations), les
// délégations n'apparaissent pas, le nom de l'automatisation vient de la trace.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

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

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  // Une conversation ANCIENNE (Telegram), puis cinq runs cron plus récents.
  const [conv] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      task: 'Rappelle-moi ce que j’aime',
      status: 'completed',
      createdAt: at(600),
    })
    .returning();
  for (let i = 0; i < 5; i++) {
    await testDb.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'cron',
      task: 'Goal: detect new CHANGELOG entries',
      status: i === 2 ? 'failed' : 'completed',
      createdAt: at(60 - i * 10),
      triggerContext: { type: 'cron', scheduleId: 'sched-1', scheduleName: 'Changelog' } as never,
    });
  }
  // Une délégation (enfant) : jamais une ligne de la liste.
  await testDb.insert(agentJobs).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'internal',
    task: 'sous-tâche',
    status: 'completed',
    parentJobId: conv!.id,
    createdAt: at(1),
  });
});

describe('listSpacesAction', () => {
  it('une conversation ancienne survit à des runs cron plus nombreux que sa limite', async () => {
    const { listSpacesAction } = await actions();
    const r = await listSpacesAction({ conversations: 10, scheduledRuns: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const channels = r.data.map((x) => x.channel);
    expect(channels.filter((c) => c === 'telegram')).toHaveLength(1);
    expect(channels.filter((c) => c === 'cron')).toHaveLength(3); // la limite des automatisations, pas la globale
    expect(channels).not.toContain('internal'); // la délégation n'est pas une tâche de tête
    const cron = r.data.filter((x) => x.channel === 'cron');
    expect(cron.every((x) => x.scheduleName === 'Changelog')).toBe(true);
    // Les plus récents d'abord, toutes sections confondues.
    const times = r.data.map((x) => x.createdAt?.getTime() ?? 0);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
