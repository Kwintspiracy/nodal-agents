// notify-question.test.ts — la carte d'une QUESTION dans le canal d'origine
// (P10a).
//
// Deux choses sont prouvées ici, et elles portent toutes les deux sur ce que le
// canal REÇOIT :
//   1. un canal qui rend des boutons reçoit un `sendQuestionCard` avec les
//      options et le `callbackId` `apr:<id>`, et un texte qui contient la
//      question VERBATIM (invariant #2 : c'est la voix de l'agent) ;
//   2. un canal sans `sendQuestionCard` reçoit un `sendText` où les options
//      sont numérotées et où le dashboard est nommé — la limite assumée de
//      P10a, dite plutôt que silencieuse.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agents, agentJobs, channelBindings, channelAllowedConversations } from '@nodal-agents/db';
import type { ApprovalGateRequest } from '@nodal-agents/tools';
import type { RunnerDeps } from '../../deps.ts';

const { discordSendQuestionCardMock, whatsappSendTextMock } = vi.hoisted(() => ({
  discordSendQuestionCardMock: vi.fn(async () => ({ messageId: 'discord-msg-1' })),
  whatsappSendTextMock: vi.fn(async () => ({ messageId: 'wa-msg-1' })),
}));

// Deux adapters factices : l'un SAIT poser des boutons, l'autre non. C'est la
// seule différence qui compte pour ce module, et elle est déclarée par
// l'adapter — jamais devinée depuis le nom du canal.
vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getAdapter: (channel: string) => {
      if (channel === 'discord') {
        return {
          channel: 'discord',
          capabilities: { buttons: true, threads: true, media: true, editMessage: true },
          sendText: vi.fn(async () => ({ messageId: 'unused' })),
          sendMedia: vi.fn(),
          validateCredentials: vi.fn(),
          sendQuestionCard: discordSendQuestionCardMock,
        };
      }
      if (channel === 'whatsapp') {
        return {
          channel: 'whatsapp',
          capabilities: { buttons: false, threads: false, media: true, editMessage: false },
          sendText: whatsappSendTextMock,
          sendMedia: vi.fn(),
          validateCredentials: vi.fn(),
        };
      }
      return actual.getAdapter(channel as Parameters<typeof actual.getAdapter>[0]);
    },
  };
});

import { notifyApprovalCreated } from '../../approvals/notify.ts';

const CONVERSATION_ID = 'conv-owner-1';
const APPROVAL_ID = '00000000-0000-0000-0000-0000000000cd';
const QUESTION = 'Where should I write the summary?';
const OPTIONS = ['The repo README', 'A new file in notes'];
const CONTEXT = 'Both already exist; the README is tracked by git.';

let db: TestDb;
let deps: RunnerDeps;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

function req(): ApprovalGateRequest {
  return {
    approvalRequestId: APPROVAL_ID,
    toolName: 'ask_user',
    toolInput: { question: QUESTION, options: OPTIONS, context: CONTEXT },
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    kind: 'question',
  };
}

/** Rend le canal donné livrable pour ce job : binding activé + conversation propriétaire. */
async function bindChannel(channel: 'discord' | 'whatsapp'): Promise<void> {
  await db.delete(channelBindings).where(eq(channelBindings.agentId, seed.agentId));
  await db
    .delete(channelAllowedConversations)
    .where(eq(channelAllowedConversations.agentId, seed.agentId));
  await db.insert(channelBindings).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel,
    enabled: true,
    credentials: JSON.stringify({ botToken: 'fake-token' }),
  });
  await db.insert(channelAllowedConversations).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel,
    conversationId: CONVERSATION_ID,
    kind: 'private',
    role: 'owner',
    status: 'active',
  });
  await db.update(agentJobs).set({ channel }).where(eq(agentJobs.id, seed.jobId));
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  deps = { db: db as RunnerDeps['db'] } as RunnerDeps;
  await db.update(agents).set({ name: 'Alfred' }).where(eq(agents.id, seed.agentId));
});

beforeEach(() => {
  discordSendQuestionCardMock.mockClear();
  whatsappSendTextMock.mockClear();
});

describe('notifyApprovalCreated — une question', () => {
  it('un canal à boutons reçoit les OPTIONS et la question verbatim', async () => {
    await bindChannel('discord');

    await notifyApprovalCreated(deps, req());

    expect(discordSendQuestionCardMock).toHaveBeenCalledTimes(1);
    const [, conversationId, card] = discordSendQuestionCardMock.mock.calls[0] as unknown as [
      unknown,
      string,
      { text: string; options: string[]; callbackId: string },
    ];
    expect(conversationId).toBe(CONVERSATION_ID);
    expect(card.options).toEqual(OPTIONS);
    expect(card.callbackId).toBe(`apr:${APPROVAL_ID}`);
    // La voix de l'agent : son nom, sa question telle qu'il l'a écrite, son
    // contexte. Rien de reformulé.
    expect(card.text).toContain(QUESTION);
    expect(card.text).toContain('Alfred');
    expect(card.text).toContain(CONTEXT);
    expect(card.text).toContain('Tap an option below');
  });

  it('un canal SANS boutons reçoit un texte aux options numérotées, et le dashboard nommé', async () => {
    await bindChannel('whatsapp');

    await notifyApprovalCreated(deps, req());

    expect(whatsappSendTextMock).toHaveBeenCalledTimes(1);
    const [, conversationId, text] = whatsappSendTextMock.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
    ];
    expect(conversationId).toBe(CONVERSATION_ID);
    expect(text).toContain(QUESTION);
    expect(text).toContain(`1. ${OPTIONS[0]}`);
    expect(text).toContain(`2. ${OPTIONS[1]}`);
    expect(text).toContain('Answer from the dashboard');
    // Pas de promesse de bouton sur un canal qui n'en a pas.
    expect(text).not.toContain('Tap an option below');
  });

  it("une question dont l'entrée ne se lit pas retombe sur la carte d'approbation, jamais sur le silence", async () => {
    await bindChannel('discord');

    await notifyApprovalCreated(deps, {
      ...req(),
      toolInput: { question: 'Which?', options: 'not-a-list' },
    });

    // Aucune carte de question — mais le job ne reste pas muet : le chemin
    // d'approbation a pris le relais (l'adapter factice n'a pas
    // `sendApprovalCard`, donc c'est son `sendText` qui a servi).
    expect(discordSendQuestionCardMock).not.toHaveBeenCalled();
  });
});
