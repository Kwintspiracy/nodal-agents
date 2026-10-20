// conversation-handles-shown.test.ts — une PERSONNE lit la vraie conversation
// là où le modèle a lu un handle (#824).
//
// Le modèle nomme désormais une conversation par son handle (`conv_…`) : c'est
// ce qu'il écrit en entrée des outils d'envoi, ce que porte la carte « Sent »,
// ce que dit l'avis de livraison d'un délégué. Le dashboard montrait l'id du
// canal à ces endroits ; il le montre encore, relu par l'entité de la session.
// Par les ACTIONS que les pages appellent : le fil d'une conversation (et donc
// d'un run, même assemblage), le détail d'un process de l'onglet Code et la
// liste des approbations.
//
// Mutations vérifiées :
//   - `showConversationsTo` retiré de `getConversationThreadAction` → le
//     premier cas voit le handle ;
//   - retiré de `getSpaceConversationAction` → le deuxième cas voit le handle ;
//   - retiré de `getCodingProcessDetailAction` → le troisième cas voit le
//     handle ;
//   - retiré de `listApprovalsAction` → le quatrième cas voit le handle.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  approvalRequests,
  channelAllowedConversations,
  conversationHandleFor,
  conversations,
  toolCalls,
  eq,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('server-only', () => ({}));
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

const WA_DM = '33612345678@s.whatsapp.net';
const fil = { id: '' };
const run = { id: '' };
let handle = '';

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
  handle = await conversationHandleFor(testDb as unknown as AnyDrizzleDb, {
    entityId: seed.entityId,
    channel: 'whatsapp',
    conversationId: WA_DM,
  });

  const [conv] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Envoi',
      origin: 'user',
      channel: 'telegram',
      chatId: 'feed-824',
    })
    .returning({ id: conversations.id });
  fil.id = conv!.id;

  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'feed-824',
      chatChannel: 'telegram',
      conversationId: fil.id,
      task: 'Préviens Marie',
      status: 'completed',
      result: `C'est envoyé.\n\n[livraison effectuée : telegram_send_message → chat ${handle}]`,
      messages: [
        { role: 'user', content: 'Préviens Marie' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c_send_824',
              toolName: 'telegram_send_message',
              input: { chatId: handle, text: 'Bonjour Marie', channel: 'whatsapp' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c_send_824',
              toolName: 'telegram_send_message',
              output: { type: 'json', value: { sent: true } },
            },
          ],
        },
        { role: 'assistant', content: "C'est envoyé." },
      ],
      completedAt: new Date(),
    })
    .returning({ id: agentJobs.id });
  run.id = job!.id;

  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: job!.id,
    toolName: 'telegram_send_message',
    toolInput: { chatId: handle, text: 'Bonjour Marie', channel: 'whatsapp' },
    toolOutput: JSON.stringify({ sent: true }),
    durationMs: 5,
    turn: 1,
    toolCallId: 'c_send_824',
    card: 'sent',
    presented: { card: 'sent', channel: 'whatsapp', kind: 'message', target: handle },
  });

  await testDb.insert(approvalRequests).values({
    entityId: seed.entityId,
    jobId: job!.id,
    agentId: seed.agentId,
    toolName: 'telegram_send_message',
    toolInput: { chatId: handle, text: 'Bonjour Marie', channel: 'whatsapp' },
    status: 'pending',
  });
});

describe('the dashboard shows the conversation a handle names @cap:parler-par-canal-externe/ecran', () => {
  it('the feed of a run: tool input, Sent card and delivery notice read the real conversation', async () => {
    const { getConversationThreadAction } = await import('../conversation-actions.ts');
    const r = await getConversationThreadAction(fil.id);
    expect(r.ok, 'the thread assembles').toBe(true);
    const shown = JSON.stringify(r);
    expect(shown).not.toContain(handle);
    // The Sent card, the call's input, the notice in the run's result.
    expect(shown).toContain(`"target":"${WA_DM}"`);
    expect(shown).toContain(`"chatId":"${WA_DM}"`);
    expect(shown).toContain(`→ chat ${WA_DM}`);
  });

  it('the page of a run reads the real conversation the same way', async () => {
    const { getSpaceConversationAction } = await import('../actions.ts');
    const r = await getSpaceConversationAction(run.id);
    expect(r.ok, 'the run assembles').toBe(true);
    const shown = JSON.stringify(r);
    expect(shown).not.toContain(handle);
    expect(shown).toContain(`"target":"${WA_DM}"`);
    expect(shown).toContain(`→ chat ${WA_DM}`);
  });

  it('the Code tab detail of a process: its tool calls read the real conversation', async () => {
    const { getCodingProcessDetailAction } = await import('../actions.ts');
    const r = await getCodingProcessDetailAction({ jobId: run.id });
    expect(r.ok, 'the process detail assembles').toBe(true);
    if (!r.ok) return;
    const activity = JSON.stringify(r.data.activity);
    expect(activity).not.toContain(handle);
    expect(activity).toContain(`"chatId":"${WA_DM}"`);
  });

  it('an approval card shows the conversation the model named', async () => {
    const { listApprovalsAction } = await import('../actions.ts');
    const r = await listApprovalsAction({ status: 'pending' });
    expect(r.ok).toBe(true);
    const shown = JSON.stringify(r);
    expect(shown).not.toContain(handle);
    expect(shown).toContain(`"chatId":"${WA_DM}"`);
  });

  it('the Channels allowlist shows the OWNER who asked: the address the model never reads', async () => {
    const participant = '33677700824@s.whatsapp.net';
    const group = '120363000000824@g.us';
    await testDb.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      conversationId: group,
      kind: 'group',
      status: 'pending',
      requesterName: 'Someone',
      requesterAddress: participant,
    });
    const { getChannelAllowedConversationsAction } = await import('../actions.ts');
    const r = await getChannelAllowedConversationsAction(seed.agentId, 'whatsapp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.find((c) => c.conversationId === group)).toMatchObject({
      requesterName: 'Someone',
      requesterAddress: participant,
    });
  });

  it('the STORED rows keep what the model wrote — the runner re-reads them', async () => {
    const [row] = await testDb
      .select({ toolInput: approvalRequests.toolInput })
      .from(approvalRequests)
      .where(eq(approvalRequests.entityId, seed.entityId));
    expect(row!.toolInput).toMatchObject({ chatId: handle });
  });
});
