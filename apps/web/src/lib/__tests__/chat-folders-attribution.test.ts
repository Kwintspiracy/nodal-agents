// chat-folders-attribution.test.ts — un délégué du tableau des tâches compte
// dans le dossier de SA CONVERSATION (#148).
//
// Le défaut, sur une vraie base : un job délégué que le tableau des tâches crée
// porte `channel = 'task-board'` et le `conversation_id` de son créateur.
// `task-board` n'est le dossier de personne. La LIGNE de la conversation
// s'allumait — elle attribue par `conversation_id` — pendant que la pastille du
// dossier, son sous-titre et le total du menu comptaient zéro. Un dossier muet
// au-dessus d'une ligne qui dit « Question asked ».
//
// Ce fichier prouve la moitié que le test pur ne voit pas : les lectures rendent
// bien le canal de la conversation, et la ligne et le dossier comptent la MÊME
// chose. Les assertions portent sur les lignes rendues, jamais sur des appels
// comptés (invariant #5).
//
// Mutation vérifiée : dans `folderOfWork` (lib/chat-folders.ts), l'attribution
// par la conversation retirée — `return folderOfJobChannel(origin.jobChannel)`
// seul — rend rouges « la pastille du dossier », « le total du menu » et « le
// point vert », la ligne restant verte : exactement le désaccord de l'issue.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, conversations } from '@nodal-agents/db';
import { chatFolders, chatWaitingTotal, DASHBOARD_FOLDER } from '../chat-folders.ts';
import { conversationRows } from '@/app/(dashboard)/chat/conversation-rows.ts';
import type { ChannelChatRow } from '../chat-list.ts';

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

/** Le fil Telegram : celui d'où la personne parle, et le dossier qui doit compter. */
let filTelegram = '';

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [fil] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '4242',
      origin: 'user',
      title: 'un fil de canal',
    })
    .returning({ id: conversations.id });
  filTelegram = fil!.id;

  // Le PARENT : le travail arrivé par Telegram, qui a délégué. Terminé — c'est
  // son enfant qui vit encore, et le compte du dossier ne doit rien lui devoir.
  await testDb.insert(agentJobs).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'telegram',
    task: 'le travail demandé depuis le canal',
    status: 'completed',
    conversationId: filTelegram,
  });

  // L'ENFANT qui POSE UNE QUESTION : créé par le tableau des tâches, donc
  // `task-board`, et rattaché au fil de son créateur. C'est lui, tout le sujet.
  const [enfantQuestion] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'task-board',
      task: 'le sous-travail délégué',
      status: 'awaiting_approval',
      conversationId: filTelegram,
    })
    .returning({ id: agentJobs.id });
  await testDb.insert(approvalRequests).values({
    entityId: seed.entityId,
    jobId: enfantQuestion!.id,
    agentId: seed.agentId,
    toolName: 'ask_user',
    toolInput: { question: 'laquelle des deux ?' },
    kind: 'question',
    status: 'pending',
  });

  // Un délégué SANS conversation : il attend lui aussi, mais rien ne dit d'où
  // il vient. Il ne doit tomber dans AUCUN dossier (invariant #4).
  const [orphelin] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'task-board',
      task: 'un sous-travail sans fil',
      status: 'awaiting_approval',
      conversationId: null,
    })
    .returning({ id: agentJobs.id });
  await testDb.insert(approvalRequests).values({
    entityId: seed.entityId,
    jobId: orphelin!.id,
    agentId: seed.agentId,
    toolName: 'write_file',
    toolInput: { note: 'rien de secret' },
    kind: 'approval',
    status: 'pending',
  });

  // Un délégué qui TOURNE sur le même fil : c'est le point vert du dossier.
  await testDb.insert(agentJobs).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'task-board',
    task: 'un sous-travail en cours',
    status: 'processing',
    conversationId: filTelegram,
  });
});

/** Les attentes telles que la barre latérale et la page les reçoivent. */
async function attentes() {
  const { listApprovalsAction } = await import('../actions.ts');
  const result = await listApprovalsAction({ status: 'pending' });
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

/** L'instantané des dossiers, tel que le menu et la page le reçoivent. */
async function instantane() {
  const { getChatFoldersAction } = await import('../conversation-actions.ts');
  const result = await getChatFoldersAction();
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

describe('l’attente d’un délégué dit le canal de sa conversation @cap:reprendre-conversation/moteur', () => {
  it('rend le canal du fil sur la demande du délégué, et `null` sur celle sans fil', async () => {
    const parOutil = new Map((await attentes()).map((r) => [r.toolName, r.conversationChannel]));
    // Le job dit `task-board` ; sa conversation dit Telegram. C'est elle que la
    // lecture rend, et sans elle aucun dossier ne peut compter la demande.
    expect(parOutil.get('ask_user')).toBe('telegram');
    expect(parOutil.get('write_file')).toBeNull();
  });

  it('rend toujours le canal du job à côté — il reste la règle sans conversation', async () => {
    const parOutil = new Map((await attentes()).map((r) => [r.toolName, r.jobChannel]));
    expect(parOutil.get('ask_user')).toBe('task-board');
    expect(parOutil.get('write_file')).toBe('task-board');
  });
});

describe('le dossier compte ce que sa ligne affiche @cap:reprendre-conversation/moteur', () => {
  it('allume la pastille du dossier Telegram pour la question d’un délégué', async () => {
    const [waiting, snapshot] = [await attentes(), await instantane()];
    const rows = chatFolders({
      channels: snapshot.channels,
      waiting,
      running: snapshot.running,
      pathname: '/chat',
      folderParam: null,
    });
    const telegram = rows.find((r) => r.key === 'telegram');
    expect(telegram?.waiting).toBe(1);
    // Le délégué sans fil n'est tombé nulle part — surtout pas dans « Nodal
    // chats », le dossier qui ramasserait tout si la règle se trompait.
    expect(rows.find((r) => r.key === DASHBOARD_FOLDER)?.waiting).toBe(0);
  });

  it('fait porter au lien « Channels » le même chiffre que la pastille', async () => {
    const [waiting, snapshot] = [await attentes(), await instantane()];
    expect(
      chatWaitingTotal({ channels: snapshot.channels, waiting, running: snapshot.running }),
    ).toBe(1);
  });

  it('pose la MÊME pastille sur la ligne de la conversation', async () => {
    // La ligne attribue par `conversation_id`, le dossier par le canal de cette
    // conversation : les deux comptes viennent des mêmes lignes en base, et
    // c'est leur désaccord qui faisait l'issue #148.
    const chat: ChannelChatRow = {
      key: `telegram:4242`,
      channel: 'telegram',
      chatId: '4242',
      name: 'le fil',
      kind: 'private',
      currentConversationId: filTelegram,
      conversationCount: 1,
      agentName: null,
      agentSlug: null,
      agentAvatarUrl: null,
      updatedAt: null,
      lastPreview: null,
      turns: 1,
    };
    const snapshot = await instantane();
    const rows = conversationRows({
      chats: [chat],
      waiting: await attentes(),
      runningConversationIds: snapshot.runningConversationIds,
    });
    expect(rows[0]?.waiting).toBe('question');
  });

  it('allume le point vert du dossier pour un délégué qui TOURNE sur le fil', async () => {
    const snapshot = await instantane();
    // Un seul `processing`, et il porte `channel = 'task-board'` : compté sur
    // son propre canal, il n'allumait aucun dossier.
    expect(snapshot.running).toEqual({ telegram: 1 });
    const rows = chatFolders({
      channels: snapshot.channels,
      waiting: await attentes(),
      running: snapshot.running,
      pathname: '/chat',
      folderParam: null,
    });
    expect(rows.find((r) => r.key === 'telegram')?.running).toBe(true);
  });
});
