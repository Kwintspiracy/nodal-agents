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
//      approbation n'y est pas — il attend la personne, il ne tourne pas ;
//   4. depuis les LIGNES d'un dossier (#135) : une approbation porte aussi la
//      CONVERSATION d'où elle vient, et la lecture dit sur quelles
//      conversations un run tourne. Sans ces deux colonnes, chaque ligne de la
//      liste porterait la pastille et le point de tout le dossier.
//
// Mutations vérifiées : `jobChannel` retiré du select → test 1 rouge ;
// `awaiting_approval` remis dans les statuts « en cours » → test 3 rouge ;
// `conversationId` retiré du select des approbations → test 4a rouge ;
// `runningConversationIds` rendu vide → test 4b rouge.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, conversations, eq } from '@nodal-agents/db';

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
async function jobAvecAttente(
  channel: string,
  toolName: string,
  /** La conversation d'où vient le travail. `null` = une tâche sans fil. */
  conversationId: string | null = null,
): Promise<string> {
  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      task: `travail sur ${channel}`,
      status: 'awaiting_approval',
      conversationId,
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

/** La conversation Telegram listable — celle que les lignes dessinent. */
let filTelegram = '';

/** L'entretien d'accueil sur Slack - une conversation que Work ne liste PAS. */
let filAccueil = '';

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
  const fils = await testDb
    .insert(conversations)
    .values([
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
    ])
    .returning({ id: conversations.id, chatId: conversations.chatId });
  filTelegram = fils.find((f) => f.chatId === '42')!.id;
  filAccueil = fils.find((f) => f.chatId === 'C0FEE')!.id;

  // Une QUESTION en attente, posée sur ce fil-là. C'est ce que la ligne du
  // dossier doit porter — et elle ne le peut que si la lecture rend la
  // conversation, pas seulement le canal.
  const jobQuestion = await jobAvecAttente('telegram', 'ask_user', filTelegram);
  await testDb
    .update(approvalRequests)
    .set({ kind: 'question' })
    .where(eq(approvalRequests.jobId, jobQuestion));

  // Les runs : deux qui TOURNENT sur Telegram — l'un rattaché au fil, l'autre
  // à aucun — et un terminé, sur le fil, qui ne doit rien allumer.
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
      task: 'un run en cours sur le fil',
      status: 'processing',
      conversationId: filTelegram,
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      task: 'un run fini',
      status: 'completed',
      conversationId: filTelegram,
    },
    // UN RUN QU'AUCUN DOSSIER NE RANGE (#300) : une automatisation tourne, son
    // canal `cron` ne designe aucun dossier de chat, et `running` l'oublie
    // donc en route. C'est precisement ce que la case Logs doit montrer.
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'cron',
      task: 'une automatisation en cours',
      status: 'processing',
    },
    // UN RUN SUR UNE CONVERSATION QUE WORK NE LISTE PAS (#303) : l'entretien
    // d'accueil tourne - un agent delegue, donc `internal` - et aucune ligne
    // de la section Work ne peut le montrer.
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'un run sur l accueil',
      status: 'processing',
      conversationId: filAccueil,
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
    // Deux `processing` sur Telegram. Les jobs `awaiting_approval` du même
    // canal ne sont PAS comptés — c'est la pastille qui les dit, pas le point.
    //
    // Le `mcp: 1` est le job que `seedMinimal` crée lui-même : `channel = 'api'`,
    // `pending`, sans conversation. C'est exactement la forme d'un run venu de
    // dehors, et depuis le 18/09 il allume le dossier MCP. La lecture dit donc
    // ce que la base CONTIENT, pas ce que la fixture avait en tête.
    expect(result.data.running).toEqual({ telegram: 2, mcp: 1 });
  });

  it('dit sur QUELLES conversations un run tourne — et seulement celles-là', async () => {
    // Sans cette lecture, la ligne d'un dossier ne pourrait allumer son point
    // qu'au niveau du dossier : cinquante lignes vertes pour un seul run.
    const { getChatFoldersAction } = await import('../conversation-actions.ts');
    const result = await getChatFoldersAction();
    if (!result.ok) throw new Error(result.message);
    // Les DEUX fils sur lesquels un run tourne, l'accueil compris : cette
    // liste dit ce qui tourne, pas ce que la barre sait montrer. C'est la case
    // Work qui trie ensuite sur ce qu'elle peut lister (#303).
    expect([...result.data.runningConversationIds].sort()).toEqual(
      [filTelegram, filAccueil].sort(),
    );
    // Le run TERMINÉ sur ce même fil n'y ajoute rien, et le `processing`
    // rattaché à aucune conversation n'y met pas de `null`.
    expect(result.data.runningConversationIds).not.toContain(null);
  });

  it('compte TOUS les runs vivants, y compris ceux qu’aucun dossier ne range', async () => {
    const { getChatFoldersAction } = await import('../conversation-actions.ts');
    const result = await getChatFoldersAction();
    if (!result.ok) throw new Error(result.message);
    // Cinq jobs vivants : deux `processing` sur Telegram, le job `api` de la
    // fixture, l'automatisation `cron` et le run de l'accueil. Les quatre
    // `awaiting_approval` n'en sont pas : ils attendent la personne.
    expect(result.data.runsInProgress).toBe(5);
    // Et c'est bien PLUS que ce que les dossiers savent ranger : `running`
    // perd le `cron` et l'`internal`, qui ne designent aucun dossier de chat.
    const parDossier = Object.values(result.data.running).reduce((t, n) => t + n, 0);
    expect(parDossier).toBe(3);
  });

  it('ne compte pour Work que les conversations que la section peut lister', async () => {
    const { getChatFoldersAction } = await import('../conversation-actions.ts');
    const result = await getChatFoldersAction();
    if (!result.ok) throw new Error(result.message);
    // Deux fils tournent, un seul est listable : l'entretien d'accueil
    // (`origin: 'onboarding'`) n'a aucune ligne dans Work, et un point qui
    // designerait une ligne introuvable serait pire que pas de point.
    expect(result.data.runningConversationIds).toHaveLength(2);
    expect(result.data.workConversationsInProgress).toBe(1);
  });
});

describe('l’attente dit SA conversation @cap:reprendre-conversation/moteur', () => {
  it('rend la conversation du job sur chaque approbation en attente', async () => {
    const { listApprovalsAction } = await import('../actions.ts');
    const result = await listApprovalsAction({ status: 'pending' });
    if (!result.ok) throw new Error(result.message);
    const parOutil = new Map(result.data.map((r) => [r.toolName, r.conversationId]));
    // La question posée sur le fil Telegram porte SON identifiant : c'est la
    // seule ligne de la liste qui doit afficher « Question asked ».
    expect(parOutil.get('ask_user')).toBe(filTelegram);
    // Les autres attentes ne sont rattachées à aucun fil : elles ne se posent
    // sur AUCUNE ligne plutôt que sur la première venue (invariant #4).
    expect(parOutil.get('send_message')).toBeNull();
    expect(parOutil.get('run_command')).toBeNull();
  });

  it('rend le `kind` de la demande, lu sur la colonne', async () => {
    const { listApprovalsAction } = await import('../actions.ts');
    const result = await listApprovalsAction({ status: 'pending' });
    if (!result.ok) throw new Error(result.message);
    const parOutil = new Map(result.data.map((r) => [r.toolName, r.kind]));
    expect(parOutil.get('ask_user')).toBe('question');
    expect(parOutil.get('send_message')).toBe('approval');
  });
});
