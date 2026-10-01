// notify-elicitation.test.ts — OÙ va la question d'un serveur MCP (0145).
//
// Règle du propriétaire (01/10) : la question s'affiche là où la DEMANDE a été
// faite. Ce fichier relit ce que le canal REÇOIT :
//   1. une demande née sur un canal de messages y reçoit une carte texte qui
//      cite le serveur et sa question, sans aucun bouton (un formulaire ne se
//      remplit pas d'un ✅) ;
//   2. une demande née sur le web, ou sans personne sur son canal (MCP), ne
//      reçoit RIEN sur le canal du propriétaire — alors que c'est exactement là
//      qu'une approbation du même job serait envoyée : la question reste sur le
//      dashboard.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agentJobs,
  approvalRequests,
  channelBindings,
  channelAllowedConversations,
} from '@nodal-agents/db';
import type { ApprovalGateRequest } from '@nodal-agents/tools';
import type { RunnerDeps } from '../../deps.ts';

const sent = vi.hoisted(() => ({
  text: [] as Array<{ conversationId: string; text: string }>,
  cards: [] as string[],
  forms: [] as Array<{ conversationId: string; text: string; labels: string[] }>,
}));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getAdapter: (channel: string) => {
      if (channel !== 'discord') {
        return actual.getAdapter(channel as Parameters<typeof actual.getAdapter>[0]);
      }
      return {
        channel: 'discord',
        capabilities: { buttons: true, threads: true, media: true, editMessage: true },
        sendText: vi.fn(async (_c: unknown, conversationId: string, text: string) => {
          sent.text.push({ conversationId, text });
          return { messageId: 'discord-text-1' };
        }),
        sendMedia: vi.fn(),
        validateCredentials: vi.fn(),
        sendApprovalCard: vi.fn(async (_c: unknown, _id: string, card: { text: string }) => {
          sent.cards.push(card.text);
          return { messageId: 'discord-card-1' };
        }),
        sendQuestionCard: vi.fn(async (_c: unknown, _id: string, card: { text: string }) => {
          sent.cards.push(card.text);
          return { messageId: 'discord-q-1' };
        }),
        sendCard: vi.fn(
          async (
            _c: unknown,
            conversationId: string,
            card: { text: string; buttons: Array<Array<{ label: string }>> },
          ) => {
            sent.forms.push({
              conversationId,
              text: card.text,
              labels: card.buttons.flat().map((b) => b.label),
            });
            return { messageId: 'discord-form-1' };
          },
        ),
      };
    },
  };
});

import { notifyApprovalCreated, settledApprovalCardText } from '../../approvals/notify.ts';

const CONVERSATION_ID = 'conv-owner-1';
const MESSAGE = 'How should "report.pdf" be printed?';

let db: TestDb;
let deps: RunnerDeps;
let seed: { entityId: string; agentId: string; jobId: string };

function req(kind: ApprovalGateRequest['kind']): ApprovalGateRequest {
  return {
    approvalRequestId: '00000000-0000-0000-0000-0000000000e1',
    toolName: 'printer__request_print',
    toolInput:
      kind === 'elicitation'
        ? {
            server: 'printer',
            message: MESSAGE,
            requestedSchema: { type: 'object', properties: {} },
          }
        : { url: 'https://example.com/report.pdf', purpose: 'print it' },
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    kind,
  };
}

async function jobFrom(channel: string): Promise<void> {
  await db.update(agentJobs).set({ channel }).where(eq(agentJobs.id, seed.jobId));
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  deps = { db: db as RunnerDeps['db'] } as RunnerDeps;
  // Le propriétaire a Discord : c'est là que ses approbations arrivent.
  await db.insert(channelBindings).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'discord',
    enabled: true,
    credentials: JSON.stringify({ botToken: 'fake-token' }),
  });
  await db.insert(channelAllowedConversations).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'discord',
    conversationId: CONVERSATION_ID,
    kind: 'private',
    role: 'owner',
    status: 'active',
  });
});

beforeEach(() => {
  sent.text.length = 0;
  sent.cards.length = 0;
  sent.forms.length = 0;
});

describe('notifyApprovalCreated — la question d’un serveur MCP @cap:approuver-une-action/moteur', () => {
  it('une demande faite sur Discord y reçoit la carte à remplir, dans SA conversation', async () => {
    // La demande est née dans une autre conversation que celle du propriétaire
    // (où une approbation du même job irait) : la question y retourne.
    await db
      .update(agentJobs)
      .set({ channel: 'discord', chatId: 'conv-requester', chatChannel: 'discord' })
      .where(eq(agentJobs.id, seed.jobId));
    const [row] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'printer__request_print',
        toolInput: {
          server: 'printer',
          message: MESSAGE,
          requestedSchema: { type: 'object', properties: { print: { type: 'boolean' } } },
        },
        kind: 'elicitation',
        status: 'pending',
        executedAt: new Date(),
      })
      .returning();
    await notifyApprovalCreated(deps, { ...req('elicitation'), approvalRequestId: row!.id });
    expect(sent.cards).toEqual([]);
    expect(sent.text).toEqual([]);
    expect(sent.forms).toHaveLength(1);
    expect(sent.forms[0]!.conversationId).toBe('conv-requester');
    expect(sent.forms[0]!.text).toContain('The MCP server "printer" asks:');
    expect(sent.forms[0]!.text).toContain(`« ${MESSAGE} »`);
    expect(sent.forms[0]!.labels).toEqual(['✅ Confirm', 'Decline', 'print: Yes', '✓ print: No']);
  });

  it('une demande faite sur le web garde sa question sur le dashboard', async () => {
    await jobFrom('dashboard');
    // Témoin : une APPROBATION du même job part bien sur Discord.
    await notifyApprovalCreated(deps, req('approval'));
    expect(sent.cards).toHaveLength(1);

    sent.cards.length = 0;
    await notifyApprovalCreated(deps, req('elicitation'));
    expect(sent.cards).toEqual([]);
    expect(sent.text).toEqual([]);
  });

  it('une demande venue du MCP de Nodal (personne sur ce canal) reste sur le dashboard', async () => {
    await jobFrom('mcp');
    await notifyApprovalCreated(deps, req('elicitation'));
    expect(sent.cards).toEqual([]);
    expect(sent.text).toEqual([]);
  });
});

describe('settledApprovalCardText — une élicitation tranchée @cap:approuver-une-action/moteur', () => {
  // La carte réécrite ne dit jamais « Approved — <outil> » : la personne n'a
  // pas approuvé l'outil MCP, elle a répondu à sa question.
  const base = { kind: 'elicitation', toolName: 'printer__request_print', answer: null };
  it('répondue, refusée, fermée sans réponse', () => {
    expect(settledApprovalCardText({ ...base, status: 'approved' })).toBe('✅ Answer sent');
    expect(settledApprovalCardText({ ...base, status: 'rejected' })).toBe('❌ Declined');
    expect(settledApprovalCardText({ ...base, status: 'expired' })).toBe(
      '⌛ Closed without an answer',
    );
  });
});
