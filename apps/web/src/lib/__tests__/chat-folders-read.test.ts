// chat-folders-read.test.ts — ce que la BASE dit des dossiers du menu (#135).
//
// Le calcul est prouvé ailleurs, sur des entrées inventées. Ce fichier prouve
// l'autre moitié, celle qu'aucun test pur ne voit : les deux lectures rendent
// bien les colonnes dont le calcul se nourrit, sur une vraie base (PGlite) et
// sur les LIGNES rendues, jamais sur des appels comptés (invariant #5).
//
//   1. une approbation en attente porte le CANAL de son job. Sans lui, chaque
//      attente tomberait dans le même dossier — ou dans aucun ;
//   2. les canaux rendus sont ceux qui portent une conversation LISTABLE : un
//      entretien d'accueil, ou une conversation sans chat, n'ouvrent pas de
//      dossier ;
//   3. les runs en cours sont comptés PAR DOSSIER, et un run arrêté sur une
//      approbation n'y est pas — il attend la personne, il ne tourne pas.
//
// Mutations vérifiées : `jobChannel` retiré du select → test 1 rouge ;
// `awaiting_approval` remis dans les statuts « en cours » → test 3 rouge.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, conversations } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
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
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

/** Un job, et son approbation en attente. Rend l'identifiant du job. */
async function jobAvecAttente(channel: string, toolName: string): Promise<string> {
  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      task: `travail sur ${channel}`,
      status: 'awaiting_approval',
    })
    .returning({ id: agentJobs.id });
  await testDb.insert(approvalRequests).values({
    entityId: seed.entityId,
    jobId: job!.id,
    agentId: seed.agentId,
    toolName,
    toolInput: { note: 'rien de secret' },
    kind: 'approval',
    status: 'pending',
  });
  return job!.id;
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  // Trois attentes, trois provenances différentes.
  await jobAvecAttente('telegram', 'send_message');
  await jobAvecAttente('dashboard', 'write_file');
  await jobAvecAttente('cron', 'run_command');

  // Les conversations : un chat Telegram listable, un entretien d'accueil sur
  // Slack (qui n'ouvre PAS de dossier), une conversation du dashboard.
  await testDb.insert(conversations).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '42',
      origin: 'user',
      title: 'un fil',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      chatId: 'C0FEE',
      origin: 'onboarding',
      title: 'accueil',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      chatId: null,
      origin: 'user',
      title: 'ici',
    },
  ]);

  // Les runs : un qui TOURNE sur Telegram, un autre terminé sur Telegram.
  await testDb.insert(agentJobs).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      task: 'un run en cours',
      status: 'processing',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      task: 'un run fini',
      status: 'completed',
    },
  ]);
});

describe("l'attente porte d'où elle vient @cap:reprendre-conversation/moteur", () => {
  it('rend le canal du job sur chaque approbation en attente', async () => {
    const { listApprovalsAction } = await import('../actions.ts');
    const result = await listApprovalsAction({ status: 'pending' });
    if (!result.ok) throw new Error(result.message);
    const parOutil = new Map(result.data.map((r) => [r.toolName, r.jobChannel]));
    expect(parOutil.get('send_message')).toBe('telegram');
    expect(parOutil.get('write_file')).toBe('dashboard');
    expect(parOutil.get('run_command')).toBe('cron');
  });
});

describe('les dossiers lus en base @cap:reprendre-conversation/moteur', () => {
  it('ne rend que les canaux qui portent une conversation listable', async () => {
    const { getChatFoldersAction } = await import('../conversation-actions.ts');
    const result = await getChatFoldersAction();
    if (!result.ok) throw new Error(result.message);
    expect(result.data.channels).toEqual(['telegram']);
    // Un entretien d'accueil n'ouvre pas de dossier, le dashboard non plus :
    // il en a un de toute façon, et il n'a pas de `chat_id`.
    expect(result.data.channels).not.toContain('slack');
    expect(result.data.channels).not.toContain('dashboard');
  });

  it('compte par dossier les runs qui TOURNENT, sans ceux qui attendent la personne', async () => {
    const { getChatFoldersAction } = await import('../conversation-actions.ts');
    const result = await getChatFoldersAction();
    if (!result.ok) throw new Error(result.message);
    // Un seul `processing` sur Telegram. Le job `awaiting_approval` du même
    // canal n'est PAS compté — c'est la pastille qui le dit, pas le point.
    expect(result.data.running).toEqual({ telegram: 1 });
  });
});
