// spaces-list-read.test.ts — les deux listes lues en base. P9 : les runs
// d'automatisation ont leur page, donc leur ACTION. `listSpacesAction` ne rend
// que des conversations (aucune ligne cron, même quand les runs cron sont plus
// récents et plus nombreux), `listScheduledRunsAction` ne rend que des runs
// cron, avec le nom de l'automatisation lu dans la trace et sa propre limite.
// Dans les deux cas les délégations n'apparaissent pas.

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

  // Une conversation ANCIENNE (Telegram), puis 300 runs cron TOUS plus
  // récents qu'elle — bien au-delà de la limite par défaut des conversations.
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
  await testDb.insert(agentJobs).values(
    Array.from({ length: 300 }, (_, i) => ({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'cron',
      task: 'Goal: detect new CHANGELOG entries',
      status: i === 2 ? 'failed' : 'completed',
      createdAt: at(1 + i),
      // La provenance porte l'id de l'automatisation (passe 26) ; ici la
      // colonne `schedule_id` reste NULL, comme après la suppression de
      // l'automatisation : c'est la provenance seule qui regroupe.
      triggerContext: {
        type: 'cron' as const,
        scheduleId: 'sched-1',
        scheduleName: 'Changelog',
        prevRunAt: null,
      },
    })),
  );
  // Deux automatisations SUPPRIMÉES, homonymes (« Digest »), plus anciennes que
  // les 300 runs ci-dessus : `schedule_id` est NULL pour les deux, seule la
  // provenance garde leur id distinct. Avant la passe 26 elles se fondaient en
  // une ligne.
  await testDb.insert(agentJobs).values(
    (['digest-a', 'digest-b'] as const).map((id, i) => ({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'cron',
      task: 'Goal: send the daily digest',
      status: 'completed',
      createdAt: at(400 + i),
      triggerContext: {
        type: 'cron' as const,
        scheduleId: id,
        scheduleName: 'Digest',
        prevRunAt: null,
      },
    })),
  );
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
  it('ne rend AUCUN run cron, même quand 300 runs cron sont plus récents que la conversation', async () => {
    const { listSpacesAction } = await actions();
    const r = await listSpacesAction();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const channels = r.data.map((x) => x.channel);
    expect(channels).not.toContain('cron'); // P9 : les runs vivent sur /scheduled
    expect(channels).not.toContain('internal'); // la délégation n'est pas une tâche de tête
    // La conversation ancienne est là malgré les 300 runs plus récents.
    expect(r.data.map((x) => x.task)).toContain('Rappelle-moi ce que j’aime');
  });

  it('applique sa limite aux conversations', async () => {
    const { listSpacesAction } = await actions();
    const r = await listSpacesAction({ conversations: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
    expect(r.data[0]!.channel).not.toBe('cron');
  });
});

describe('listScheduledRunsAction', () => {
  it('ne rend que les runs cron, avec le nom de l’automatisation, les plus récents d’abord', async () => {
    const { listScheduledRunsAction } = await actions();
    const r = await listScheduledRunsAction();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(300); // la limite par défaut, tous les runs semés
    expect(r.data.every((x) => x.channel === 'cron')).toBe(true);
    expect(r.data.every((x) => x.scheduleName === 'Changelog')).toBe(true);
    expect(r.data.filter((x) => x.status === 'failed')).toHaveLength(1);
    const times = r.data.map((x) => x.createdAt?.getTime() ?? 0);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('applique sa limite', async () => {
    const { listScheduledRunsAction } = await actions();
    const r = await listScheduledRunsAction({ limit: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(3);
    // Les trois plus récents : 1, 2 et 3 minutes avant maintenant.
    expect(r.data.every((x) => x.channel === 'cron')).toBe(true);
  });

  it('garde l’id de l’automatisation depuis la provenance quand schedule_id est NULL (deux homonymes supprimées restent deux lignes)', async () => {
    const { listScheduledRunsAction } = await actions();
    const { groupSpaces } = await import('../spaces-list.ts');
    const r = await listScheduledRunsAction({ limit: 302 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const digests = r.data.filter((x) => x.scheduleName === 'Digest');
    expect(digests).toHaveLength(2);
    // La colonne est NULL (automatisation supprimée) : l'id vient de la provenance.
    expect(digests.map((x) => x.scheduleId).sort()).toEqual(['digest-a', 'digest-b']);
    // Et la page les montre comme DEUX automatisations, pas une.
    const groups = groupSpaces(r.data).scheduled;
    expect(groups.filter((g) => g.name === 'Digest')).toHaveLength(2);
    expect(groups.find((g) => g.name === 'Changelog')?.runs).toHaveLength(300);
  });
});
