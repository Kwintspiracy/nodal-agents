// elicitation-channel.test.ts — la question d'un serveur MCP (0145) posée ET
// répondue sur le canal où la demande est née, sur de VRAIES lignes en base.
//
// Les adaptateurs de canal sont simulés à la frontière : ce qui est relu, c'est
// ce que le canal REÇOIT (images, texte et boutons de la carte, carte
// réécrite, avis) et ce que la base garde (brouillon, statut, réponse).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq } from '@nodal-agents/db';
import {
  agents,
  agentJobs,
  approvalRequests,
  approvalRequestAttachments,
  approvalCardMessages,
  channelBindings,
  telegramAllowedChats,
} from '@nodal-agents/db';
import { parseElicitationCallbackData, elicitationCallbackData } from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

type Sent =
  | { kind: 'media'; channel: string; conversationId: string; caption?: string; bytes: number }
  | { kind: 'card'; channel: string; conversationId: string; text: string; buttons: string[][] }
  | { kind: 'text'; channel: string; conversationId: string; text: string }
  | { kind: 'edit'; channel: string; messageId: string; text: string; buttons: string[][] };

const wire = vi.hoisted(() => ({
  sent: [] as Sent[],
  next: 100,
  limits: {} as Record<string, unknown>,
}));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  const fake = (channel: string, withButtons: boolean) => ({
    channel,
    capabilities: {
      buttons: withButtons,
      threads: false,
      media: true,
      editMessage: withButtons,
      ...(wire.limits[channel] ? { buttonLimits: wire.limits[channel] } : {}),
    },
    text: { renders: [], maxMessageChars: 4096 },
    sendText: async (_c: unknown, conversationId: string, text: string) => {
      wire.sent.push({ kind: 'text', channel, conversationId, text });
      return { messageId: String(wire.next++) };
    },
    sendMedia: async (
      _c: unknown,
      conversationId: string,
      m: { caption?: string; bytes: Uint8Array },
    ) => {
      wire.sent.push({
        kind: 'media',
        channel,
        conversationId,
        bytes: m.bytes.length,
        ...(m.caption ? { caption: m.caption } : {}),
      });
      return { messageId: String(wire.next++) };
    },
    validateCredentials: async () => ({ id: 'b', username: null, displayName: null }),
    ...(withButtons
      ? {
          sendCard: async (
            _c: unknown,
            conversationId: string,
            card: { text: string; buttons: Array<Array<{ label: string; callbackData: string }>> },
          ) => {
            wire.sent.push({
              kind: 'card',
              channel,
              conversationId,
              text: card.text,
              buttons: card.buttons.map((r) => r.map((b) => `${b.label}|${b.callbackData}`)),
            });
            return { messageId: String(wire.next++) };
          },
          editMessageText: async (
            _c: unknown,
            _conv: string,
            messageId: string,
            text: string,
            buttons?: Array<Array<{ label: string; callbackData: string }>>,
          ) => {
            wire.sent.push({
              kind: 'edit',
              channel,
              messageId,
              text,
              buttons: (buttons ?? []).map((r) => r.map((b) => `${b.label}|${b.callbackData}`)),
            });
            return { ok: true };
          },
        }
      : {}),
  });
  return {
    ...actual,
    getAdapter: (channel: string) => fake(channel, channel !== 'whatsapp'),
  };
});

import { notifyApprovalCreated } from '../../approvals/notify.ts';
import {
  handleElicitationTap,
  handleElicitationReply,
  saveElicitationDraft,
} from '../../approvals/elicitation-channel.ts';

const OWNER_CHAT = '111';
const GUEST_CHAT = '222';
// 1×1 PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const FORM = {
  type: 'object',
  properties: {
    color: { type: 'string', title: 'Color', enum: ['color', 'grayscale'] },
    copies: { type: 'integer', title: 'Copies', minimum: 1, maximum: 5 },
    duplex: { type: 'boolean', title: 'Two-sided' },
  },
  required: ['color', 'copies'],
};

let db: TestDb;
let deps: RunnerDeps;
let seed: { entityId: string; agentId: string; jobId: string };
const env = { WORKER_SECRET: 's', APP_URL: 'http://x' } as unknown as RunnerEnv;

async function question(): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName: 'printer__request_print',
      toolInput: { server: 'printer', message: 'How should it be printed?', requestedSchema: FORM },
      toolCallId: 'call-1',
      kind: 'elicitation',
      status: 'pending',
      executedAt: new Date(),
    })
    .returning();
  return row!.id;
}

async function deliver(id: string): Promise<void> {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  await notifyApprovalCreated(deps, {
    approvalRequestId: id,
    toolName: row!.toolName,
    toolInput: row!.toolInput,
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    kind: 'elicitation',
  });
}

async function readRow(id: string) {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  return row!;
}

const TG = { channel: 'telegram' as const, conversationId: GUEST_CHAT };
function origin() {
  return { ...TG, receivingAgentId: seed.agentId };
}

/** Le callback_data du bouton dont le libellé est `label`, sur la DERNIÈRE carte vue. */
function button(label: string): string {
  const last = [...wire.sent].reverse().find((s) => s.kind === 'card' || s.kind === 'edit') as
    | { buttons: string[][] }
    | undefined;
  const hit = last?.buttons.flat().find((b) => b.split('|')[0] === label);
  if (!hit) throw new Error(`no button "${label}" on ${JSON.stringify(last?.buttons)}`);
  return hit.split('|')[1]!;
}

function lastCardText(): string {
  const last = [...wire.sent].reverse().find((s) => s.kind === 'card' || s.kind === 'edit') as
    | { text: string }
    | undefined;
  return last?.text ?? '';
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  deps = { db: db as unknown as RunnerDeps['db'] } as RunnerDeps;
  await db.update(agents).set({ telegramBotToken: '123:fake' }).where(eq(agents.id, seed.agentId));
  // Le propriétaire a SA conversation : c'est là qu'une approbation irait.
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId: OWNER_CHAT,
    role: 'owner',
    status: 'active',
  });
});

beforeEach(async () => {
  wire.sent.length = 0;
  wire.limits = {};
  await db.delete(approvalRequests).where(eq(approvalRequests.jobId, seed.jobId));
  // La demande est née dans la conversation d'un INVITÉ, sur Telegram.
  await db
    .update(agentJobs)
    .set({ channel: 'telegram', chatId: GUEST_CHAT, status: 'processing' })
    .where(eq(agentJobs.id, seed.jobId));
});

describe('la question part là où la demande est née @cap:approuver-une-action/moteur', () => {
  it('Telegram : les images puis la carte, dans la conversation de la demande, pas celle du propriétaire', async () => {
    const id = await question();
    await db.insert(approvalRequestAttachments).values({
      approvalRequestId: id,
      position: 0,
      mimeType: 'image/png',
      data: PNG,
      byteSize: 70,
      caption: 'Page 1 preview',
    });
    await deliver(id);
    expect(wire.sent.map((s) => [s.kind, 'conversationId' in s ? s.conversationId : null])).toEqual(
      [
        ['media', GUEST_CHAT],
        ['card', GUEST_CHAT],
      ],
    );
    expect(wire.sent[0]).toMatchObject({ caption: 'Page 1 preview', bytes: 70 });
    const card = wire.sent[1] as Extract<Sent, { kind: 'card' }>;
    expect(card.text).toContain('« How should it be printed? »');
    expect(card.text).toContain('The image above comes with the question.');
    expect(card.buttons.flat().map((b) => b.split('|')[0])).toEqual([
      'Color: color',
      'Color: grayscale',
      'Two-sided: Yes',
      '✓ Two-sided: No',
      '✏️ Copies',
      '✅ Send',
      '❌ Decline',
    ]);
    const [recorded] = await db
      .select()
      .from(approvalCardMessages)
      .where(eq(approvalCardMessages.approvalRequestId, id));
    expect(recorded).toMatchObject({ channel: 'telegram', conversationId: GUEST_CHAT });
  });

  it('une demande faite sur le web ne reçoit rien sur Telegram', async () => {
    await db
      .update(agentJobs)
      .set({ channel: 'dashboard', chatId: null })
      .where(eq(agentJobs.id, seed.jobId));
    await deliver(await question());
    expect(wire.sent).toEqual([]);
  });

  it('un canal sans boutons reçoit la question et le renvoi au dashboard, avec la raison', async () => {
    await db
      .update(agentJobs)
      .set({ channel: 'whatsapp', chatId: 'wa-1' })
      .where(eq(agentJobs.id, seed.jobId));
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      enabled: true,
      credentials: JSON.stringify({ sessionDir: 'x' }),
    });
    try {
      await deliver(await question());
      expect(wire.sent).toHaveLength(1);
      expect(wire.sent[0]).toMatchObject({ kind: 'text', conversationId: 'wa-1' });
      expect((wire.sent[0] as { text: string }).text).toContain(
        '(whatsapp has no buttons to fill a form with.)',
      );
    } finally {
      await db.delete(channelBindings).where(eq(channelBindings.channel, 'whatsapp'));
    }
  });

  it('un formulaire trop grand pour le canal n’est pas amputé : renvoi au dashboard, avec la raison', async () => {
    wire.limits = { telegram: { maxRows: 2, maxPerRow: 5 } };
    await deliver(await question());
    expect(wire.sent.map((s) => s.kind)).toEqual(['text']);
    expect((wire.sent[0] as { text: string }).text).toContain(
      'this form does not fit on telegram: the form needs 4 rows of buttons and this channel shows at most 2',
    );
  });
});

describe('remplir la carte depuis le canal @cap:approuver-une-action/moteur', () => {
  it('un choix posé est gardé en base et la carte réécrite le montre', async () => {
    const id = await question();
    await deliver(id);
    const r = await handleElicitationTap({
      deps,
      env,
      origin: origin(),
      data: button('Color: grayscale'),
    });
    expect(r).toEqual({ handled: true, notice: null });
    expect((await readRow(id)).draft).toEqual({
      values: { duplex: false, color: 'grayscale' },
      awaiting: null,
    });
    expect(wire.sent.at(-1)).toMatchObject({ kind: 'edit' });
    expect(lastCardText()).toContain('Color: grayscale');
    expect(button('✓ Color: grayscale')).toBeTruthy();
  });

  it('un geste venu d’une autre conversation est refusé et ne touche rien', async () => {
    const id = await question();
    await deliver(id);
    const r = await handleElicitationTap({
      deps,
      env,
      origin: { channel: 'telegram', conversationId: OWNER_CHAT, receivingAgentId: seed.agentId },
      data: button('Color: grayscale'),
    });
    expect(r).toEqual({ handled: false, reason: 'not_authorized', notice: 'Not authorized.' });
    expect((await readRow(id)).draft).toBeNull();
  });

  it('✏️ puis une réponse tapée : refusée hors bornes (dit), prise dans les bornes', async () => {
    const id = await question();
    await deliver(id);
    const typed = await handleElicitationTap({
      deps,
      env,
      origin: origin(),
      data: button('✏️ Copies'),
    });
    expect(typed).toEqual({ handled: true, notice: 'Reply to the card with Copies.' });
    expect(lastCardText()).toContain(
      '✏️ Reply to this message with Copies: a whole number from 1 to 5.',
    );

    const [recorded] = await db
      .select({ messageId: approvalCardMessages.messageId })
      .from(approvalCardMessages)
      .where(eq(approvalCardMessages.approvalRequestId, id));

    const tooMany = await handleElicitationReply({
      deps,
      origin: origin(),
      replyToMessageId: recorded!.messageId,
      text: '9',
    });
    expect(tooMany).toEqual({ handled: true, notice: 'Not taken: Copies must be at most 5.' });
    expect(wire.sent.at(-1)).toMatchObject({
      kind: 'text',
      conversationId: GUEST_CHAT,
      text: 'Not taken: Copies must be at most 5.',
    });
    expect((await readRow(id)).draft).toMatchObject({ awaiting: 'copies' });

    const ok = await handleElicitationReply({
      deps,
      origin: origin(),
      replyToMessageId: recorded!.messageId,
      text: '3',
    });
    expect(ok).toEqual({ handled: true, notice: null });
    expect((await readRow(id)).draft).toEqual({
      values: { duplex: false, copies: 3 },
      awaiting: null,
    });
    expect(lastCardText()).toContain('Copies: 3');
  });

  it('une réponse à un autre message que la carte suit son chemin habituel', async () => {
    const id = await question();
    await deliver(id);
    expect(
      await handleElicitationReply({
        deps,
        origin: origin(),
        replyToMessageId: '9999',
        text: 'hi',
      }),
    ).toMatchObject({ handled: false, reason: 'not_a_card' });
    expect((await readRow(id)).draft).toBeNull();
  });

  it('Send : un formulaire incomplet n’est pas envoyé, et le dit', async () => {
    const id = await question();
    await deliver(id);
    const r = await handleElicitationTap({ deps, env, origin: origin(), data: button('✅ Send') });
    expect(r).toEqual({
      handled: false,
      reason: 'content_invalid',
      notice: 'Not sent: color: is required; copies: is required.',
    });
    expect((await readRow(id)).status).toBe('pending');
  });

  it('Send d’une carte périmée n’envoie rien et redessine la carte', async () => {
    const id = await question();
    await deliver(id);
    const staleSend = button('✅ Send');
    await handleElicitationTap({ deps, env, origin: origin(), data: button('Color: color') });
    const r = await handleElicitationTap({ deps, env, origin: origin(), data: staleSend });
    expect(r).toMatchObject({ handled: false, reason: 'stale_card' });
    expect((await readRow(id)).status).toBe('pending');
  });

  it('Send d’un formulaire complet : la demande est tranchée avec exactement ces valeurs', async () => {
    const id = await question();
    await deliver(id);
    await handleElicitationTap({ deps, env, origin: origin(), data: button('Color: grayscale') });
    await handleElicitationTap({ deps, env, origin: origin(), data: button('Two-sided: Yes') });
    await handleElicitationTap({ deps, env, origin: origin(), data: button('✏️ Copies') });
    const [card] = await db
      .select({ messageId: approvalCardMessages.messageId })
      .from(approvalCardMessages)
      .where(eq(approvalCardMessages.approvalRequestId, id));
    await handleElicitationReply({
      deps,
      origin: origin(),
      replyToMessageId: card!.messageId,
      text: '2',
    });
    const r = await handleElicitationTap({ deps, env, origin: origin(), data: button('✅ Send') });
    expect(r).toEqual({ handled: true, notice: 'Sent.' });
    const row = await readRow(id);
    expect(row.status).toBe('approved');
    expect(row.resolvedBy).toBe('telegram');
    expect(row.response).toEqual({ color: 'grayscale', copies: 2, duplex: true });
    // La carte est réglée : son dernier état ne porte plus de bouton.
    expect(wire.sent.at(-1)).toMatchObject({ kind: 'edit', text: '✅ Answer sent', buttons: [] });
  });

  it('Decline : la demande est refusée ; un geste sur la carte tranchée le dit', async () => {
    const id = await question();
    await deliver(id);
    const decline = button('❌ Decline');
    expect(await handleElicitationTap({ deps, env, origin: origin(), data: decline })).toEqual({
      handled: true,
      notice: 'Declined.',
    });
    expect((await readRow(id)).status).toBe('rejected');
    expect(
      await handleElicitationTap({
        deps,
        env,
        origin: origin(),
        data: elicitationCallbackData(id, { op: 'bool', field: 2, value: true }),
      }),
    ).toEqual({ handled: false, reason: 'already_resolved', notice: 'Already declined.' });
  });

  it('un bouton qui ne désigne plus rien est refusé, avec la raison', async () => {
    const id = await question();
    await deliver(id);
    const r = await handleElicitationTap({
      deps,
      env,
      origin: origin(),
      data: elicitationCallbackData(id, { op: 'choice', field: 0, option: 9 }),
    });
    expect(r).toEqual({
      handled: false,
      reason: 'stale_button',
      notice: 'Not applied: this choice no longer exists.',
    });
    expect(parseElicitationCallbackData(button('✅ Send'))).not.toBeNull();
    expect(
      await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'pending'))),
    ).toHaveLength(1);
  });
});

describe('le brouillon d’une question close @cap:approuver-une-action/moteur', () => {
  it('un geste arrivé après la décision ne réécrit pas le formulaire', async () => {
    const id = await question();
    await db
      .update(approvalRequests)
      .set({ status: 'approved', response: { color: 'color', copies: 1 } })
      .where(eq(approvalRequests.id, id));
    const written = await saveElicitationDraft(db as never, id, {
      values: { color: 'grayscale' },
      awaiting: null,
    });
    expect(written).toBe(false);
    expect((await readRow(id)).draft).toBeNull();
  });
});
