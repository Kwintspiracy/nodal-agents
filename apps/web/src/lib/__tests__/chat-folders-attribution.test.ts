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
//
// Depuis le 18/09 il prouve la même chose du dossier MCP : un run venu de
// dehors n'a pas de conversation, son délégué n'en a pas non plus, et c'est sa
// CHAÎNE qui range l'attente. Voir le dernier `describe`.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, conversations } from '@nodal-agents/db';
import { chatFolders, chatWaitingTotal, DASHBOARD_FOLDER, MCP_FOLDER } from '../chat-folders.ts';
import { conversationRows } from '@/app/(dashboard)/chat/conversation-rows.ts';
import { runRows } from '@/app/(dashboard)/chat/run-rows.ts';
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

/** Le run demandé par le serveur MCP — la TÊTE dont la chaîne porte l'attente. */
let runDeDehors = '';

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

  // Un délégué rattaché à une conversation que la liste ne MONTRE pas — un
  // entretien d'accueil Slack (`origin = 'onboarding'`). Le dossier Slack ne
  // doit pas compter ce que sa liste ne peut pas afficher (Reviewer C, #157).
  const [accueil] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      chatId: '77',
      origin: 'onboarding',
      title: 'un entretien d’accueil',
    })
    .returning({ id: conversations.id });
  const [enfantAccueil] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'task-board',
      task: 'un sous-travail né d’un accueil',
      status: 'awaiting_approval',
      conversationId: accueil!.id,
    })
    .returning({ id: agentJobs.id });
  await testDb.insert(approvalRequests).values({
    entityId: seed.entityId,
    jobId: enfantAccueil!.id,
    agentId: seed.agentId,
    toolName: 'ask_user',
    toolInput: { question: 'et pour l’accueil ?' },
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

  // ─── Les runs venus de DEHORS (18/09) ──────────────────────────────────────
  // Deux runs de tête sans conversation : l'un demandé par le serveur MCP,
  // l'autre par `/api/agent`. Aucun n'a de conversation — c'est exactement ce
  // que dit la base du propriétaire — et c'est le dossier MCP qui les porte.
  const [runMcp] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'mcp',
      task: 'le run demandé par le serveur MCP',
      // Il a délégué : c'est son enfant qui attend, et lui reste vivant.
      status: 'awaiting_delegation',
      conversationId: null,
    })
    .returning({ id: agentJobs.id });
  runDeDehors = runMcp!.id;

  await testDb.insert(agentJobs).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'api',
    task: 'la tâche envoyée par l’API',
    status: 'completed',
    conversationId: null,
  });

  // L'ENFANT de ce run : `internal`, aucune conversation — il ne dit RIEN de sa
  // provenance. Seule sa chaîne le rattache au dossier MCP.
  const [delegueDeDehors] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'le sous-travail d’un run venu de dehors',
      status: 'awaiting_approval',
      conversationId: null,
      parentJobId: runMcp!.id,
    })
    .returning({ id: agentJobs.id });
  await testDb.insert(approvalRequests).values({
    entityId: seed.entityId,
    jobId: delegueDeDehors!.id,
    agentId: seed.agentId,
    toolName: 'ask_user_from_outside',
    toolInput: { question: 'et pour le run de dehors ?' },
    kind: 'question',
    status: 'pending',
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
      externalRuns: snapshot.externalRuns,
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
    const entrees = {
      channels: snapshot.channels,
      waiting,
      running: snapshot.running,
      externalRuns: snapshot.externalRuns,
    };
    const rows = chatFolders({ ...entrees, pathname: '/chat', folderParam: null });
    // À LA LETTRE la somme des pastilles : une question sur Telegram, une sur
    // le run venu de dehors. Le délégué sans fil n'est nulle part.
    expect(chatWaitingTotal(entrees)).toBe(rows.reduce((n, r) => n + r.waiting, 0));
    expect(chatWaitingTotal(entrees)).toBe(2);
  });

  it('ne compte pas dans un dossier ce que sa liste ne montre pas : l’accueil reste dehors', async () => {
    const [waiting, snapshot] = [await attentes(), await instantane()];
    // La demande du délégué de l'accueil est lue SANS canal de conversation :
    // sa conversation n'est pas listable, donc elle ne range rien.
    const accueil = waiting.find(
      (w) => w.jobChannel === 'task-board' && w.conversationChannel === 'slack',
    );
    expect(accueil).toBeUndefined();
    const rows = chatFolders({
      channels: snapshot.channels,
      waiting,
      running: snapshot.running,
      externalRuns: snapshot.externalRuns,
      pathname: '/chat',
      folderParam: null,
    });
    expect(rows.find((r) => r.key === 'slack')?.waiting ?? 0).toBe(0);
    // Deux attentes rangées en tout — Telegram et MCP — et l'accueil dehors.
    expect(
      chatWaitingTotal({
        channels: snapshot.channels,
        waiting,
        running: snapshot.running,
        externalRuns: snapshot.externalRuns,
      }),
    ).toBe(2);
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
    // son propre canal, il n'allumait aucun dossier. Les deux `mcp` à côté sont
    // le run venu de dehors — resté vivant pendant que son délégué attend — et
    // le job `api` que `seedMinimal` crée lui-même, `pending` et sans
    // conversation, donc un run de dehors lui aussi.
    expect(snapshot.running).toEqual({ telegram: 1, mcp: 2 });
    const rows = chatFolders({
      channels: snapshot.channels,
      waiting: await attentes(),
      running: snapshot.running,
      externalRuns: snapshot.externalRuns,
      pathname: '/chat',
      folderParam: null,
    });
    expect(rows.find((r) => r.key === 'telegram')?.running).toBe(true);
  });
});

/** La PREMIÈRE page des runs venus de dehors, telle que la page la reçoit. */
async function runsDeDehors() {
  const { listExternalRunsAction } = await import('../conversation-actions.ts');
  const result = await listExternalRunsAction();
  if (!result.ok) throw new Error(result.message);
  return result.data.runs;
}

describe('le dossier MCP lit ce que la base en dit @cap:parler-par-canal-externe/moteur', () => {
  // La moitié qu'aucun test pur ne voit : les lectures rendent bien les
  // colonnes dont le dossier MCP se nourrit, sur une vraie base, et le compte
  // du menu et la liste du dossier parlent des MÊMES lignes.
  //
  // Mutation vérifiée : la remontée de chaîne retirée de `listApprovalsAction`
  // (`rootChannel` rendu `null`) → « compte la question d'un délégué » rougit,
  // et le dossier redevient muet exactement comme avant le 18/09 ;
  // `conversation_id IS NULL` retiré de `runsFromOutside` → rien ne bouge ici,
  // parce qu'aucun run de dehors n'a de conversation — c'est ce que la base du
  // propriétaire disait déjà.

  it('compte les runs de tête venus de dehors, et eux seuls', async () => {
    const snapshot = await instantane();
    // Le run MCP, la tâche de l'API, et le job `api` que `seedMinimal` crée
    // lui-même — trois jobs de tête sans conversation. Ni les délégués (ils ont
    // un parent), ni le travail des conversations.
    expect(snapshot.externalRuns).toBe(3);
  });

  it('liste ces runs, les plus récents d’abord, avec leur tâche', async () => {
    const runs = await runsDeDehors();
    expect(runs.map((r) => r.task)).toEqual([
      'la tâche envoyée par l’API',
      'le run demandé par le serveur MCP',
      // Le job du semis, créé avant les deux autres : l'ordre est bien celui de
      // la création, du plus récent au plus ancien.
      'Test task',
    ]);
    // Aucun délégué dans la liste : un sous-travail n'est pas un run.
    expect(runs.some((r) => r.task.includes('sous-travail'))).toBe(false);
  });

  it('remonte la question d’un délégué jusqu’au canal ET au run de tête', async () => {
    const demande = (await attentes()).find((a) => a.toolName === 'ask_user_from_outside');
    // Sur lui-même, ce job ne dit rien : `internal`, aucune conversation.
    expect(demande?.jobChannel).toBe('internal');
    expect(demande?.conversationChannel).toBeNull();
    // Sa chaîne, elle, dit tout.
    expect(demande?.rootChannel).toBe('mcp');
    expect(demande?.rootJobId).toBe(runDeDehors);
  });

  it('allume la pastille du dossier MCP pour cette question', async () => {
    const [waiting, snapshot] = [await attentes(), await instantane()];
    const rows = chatFolders({
      channels: snapshot.channels,
      waiting,
      running: snapshot.running,
      externalRuns: snapshot.externalRuns,
      pathname: '/chat',
      folderParam: null,
    });
    expect(rows.find((r) => r.key === MCP_FOLDER)?.waiting).toBe(1);
    expect(rows.find((r) => r.key === MCP_FOLDER)?.running).toBe(true);
    // Et pas ailleurs : Telegram garde la sienne, « Nodal chats » n'a rien.
    expect(rows.find((r) => r.key === 'telegram')?.waiting).toBe(1);
    expect(rows.find((r) => r.key === DASHBOARD_FOLDER)?.waiting).toBe(0);
  });

  it('pose la MÊME pastille sur la LIGNE du run, par le job de tête', async () => {
    const rows = runRows({ runs: await runsDeDehors(), waiting: await attentes() });
    const ligne = rows.find((r) => r.id === runDeDehors);
    expect(ligne?.waiting).toBe('question');
    expect(ligne?.href).toBe(`/jobs/${runDeDehors}`);
    // L'autre run n'a rien : une demande ne se pose pas sur la première ligne
    // venue.
    expect(rows.find((r) => r.id !== runDeDehors)?.waiting).toBeNull();
  });

  it('rend un job de tête comme sa propre tête — sans remonter quoi que ce soit', async () => {
    const demande = (await attentes()).find((a) => a.toolName === 'ask_user');
    expect(demande?.rootJobId).toBe(demande?.jobId);
    expect(demande?.rootChannel).toBe('task-board');
  });
});
