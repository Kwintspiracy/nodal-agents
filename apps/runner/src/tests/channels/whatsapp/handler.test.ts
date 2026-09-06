// handler.test.ts — handleWhatsAppMessage: H-1 owner-claim / pending-
// authorization state machine, group mention-gating (mentionsSelf), /ask
// routing gated by the TARGET's own whatsapp allowlist, and the
// media-placeholder fallback text. Mirrors
// tests/channels/discord/handler.test.ts's structure for the WhatsApp-shaped
// handler.
//
// No bot-author test here: unlike Discord/Slack's neutral message shapes,
// WhatsAppInboundMessage carries no author/bot flag to re-check — fromMe
// filtering happens entirely in the CORE (packages/delivery's
// mapInboundMessage returns null for fromMe before ever emitting `message`),
// so there is nothing reachable at this layer to assert against.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and } from '@nodal-agents/db';
import { agentJobs, agents, channelAllowedConversations, conversations } from '@nodal-agents/db';
import type { WhatsAppInboundMessage } from '@nodal-agents/delivery';
import { handleWhatsAppMessage } from '../../../channels/whatsapp/handler.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

function dm(
  text: string,
  conversationId: string,
  senderJid = '15550000001@s.whatsapp.net',
  senderName: string | null = 'Bob',
): WhatsAppInboundMessage {
  return {
    conversationId,
    senderJid,
    senderName,
    text,
    timestamp: Date.now(),
    isGroup: false,
    mentionsSelf: false,
  };
}

function groupMessage(
  text: string,
  opts: { mentionsSelf?: boolean; conversationId?: string } = {},
): WhatsAppInboundMessage {
  return {
    conversationId: opts.conversationId ?? 'group-1@g.us',
    senderJid: '15550000007@s.whatsapp.net',
    senderName: 'Alice',
    text,
    timestamp: Date.now(),
    isGroup: true,
    mentionsSelf: opts.mentionsSelf ?? false,
  };
}

/** A fresh agent with an empty allowlist slate, for H-1/F-1 tests. */
async function freshBot(): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'WhatsApp Auth Bot',
      slug: `whatsapp-auth-bot-${Date.now()}-${Math.floor(performance.now())}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning({ id: agents.id });
  return row!.id;
}

/**
 * Bring an agent to "has an ACTIVE owner" — the state a single bootstrap DM
 * used to reach by itself.
 *
 * Since CHANNEL-001 the first DM only RECORDS an owner claim (owner/pending)
 * and creates no job: a bot handle is public, so the claim has to be confirmed
 * by a human in the dashboard before it carries any authority. Tests that need
 * an established owner therefore do both halves explicitly — claim, then
 * approve — which is exactly what a real setup now does.
 */
/** Insert an already-approved owner row, for tests not about authorization. */
async function seedActiveOwner(agentId: string, conversationId: string): Promise<void> {
  await db.insert(channelAllowedConversations).values({
    entityId: seed.entityId,
    agentId,
    channel: 'whatsapp',
    conversationId,
    kind: 'private',
    role: 'owner',
    status: 'active',
  });
}

async function claimOwner(agentId: string, message: WhatsAppInboundMessage): Promise<void> {
  await call(agentId, message);
  await db
    .update(channelAllowedConversations)
    .set({ status: 'active' })
    .where(
      and(
        eq(channelAllowedConversations.agentId, agentId),
        eq(channelAllowedConversations.conversationId, message.conversationId),
        eq(channelAllowedConversations.role, 'owner'),
      ),
    );
}

const call = (agentId: string, message: WhatsAppInboundMessage) =>
  handleWhatsAppMessage({
    message,
    receivingAgentId: agentId,
    receivingAgentEntityId: seed.entityId,
    tx: db as unknown as Parameters<typeof handleWhatsAppMessage>[0]['tx'],
  });

describe('handleWhatsAppMessage — no_content guard', () => {
  it('skips an empty-text, non-media message', async () => {
    const agentId = await freshBot();
    const result = await call(agentId, dm('', 'dm-empty-1'));
    expect(result).toEqual({ skipped: 'no_content' });
  });

  it('still processes an empty-text message flagged mediaPlaceholder, with a placeholder task', async () => {
    const agentId = await freshBot();
    // This test is about the media placeholder, not authorization: give the
    // conversation an approved owner row so it is allowed to create a job at
    // all (since CHANNEL-001 a first DM no longer authorizes itself).
    await seedActiveOwner(agentId, 'dm-media-1');
    const result = await call(agentId, {
      ...dm('', 'dm-media-1'),
      mediaPlaceholder: true,
    });
    expect(result.jobId).toBeDefined();
    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.task).toContain('Média WhatsApp reçu');
  });
});

describe('handleWhatsAppMessage — H-1 owner-claim / pending authorization', () => {
  // CHANNEL-001. This used to read "first DM claims ownership AND creates a
  // job" — trust on first use. A bot handle is public, so whoever DMed first
  // became the owner, including a stranger who got there before the person who
  // had just pasted the token.
  it('first DM with no owner records a PENDING owner claim and creates NO job', async () => {
    const agentId = await freshBot();
    const result = await call(agentId, dm('hi', 'dm-owner-1'));

    // No job: an unconfirmed claim has no authority.
    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    // No owner to card — the claimant is told where the decision is made.
    expect(result.pendingAuth).toMatchObject({
      ownerConversationId: null,
      requesterConversationId: 'dm-owner-1',
    });
    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.chatId, 'dm-owner-1'));
    expect(jobs).toHaveLength(0);

    const rows = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'whatsapp',
      conversationId: 'dm-owner-1',
      kind: 'private',
      role: 'owner',
      status: 'pending',
    });
  });

  it('a SECOND claimant cannot take the owner slot while a claim is pending', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('me first', 'dm-race-a'));
    const second = await call(agentId, dm('no, me', 'dm-race-b'));

    // The slot is held by the pending claim; the latecomer gets nothing at all.
    expect(second.jobId).toBeUndefined();
    expect(second.skipped).toBe('awaiting_authorization');

    const owners = await db
      .select()
      .from(channelAllowedConversations)
      .where(
        and(
          eq(channelAllowedConversations.agentId, agentId),
          eq(channelAllowedConversations.role, 'owner'),
        ),
      );
    expect(owners).toHaveLength(1);
    expect(owners[0]?.conversationId).toBe('dm-race-a');
  });

  it('once the owner claim is approved, that conversation creates jobs', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('hi', 'dm-approved-1'));
    const result = await call(agentId, dm('do something', 'dm-approved-1'));
    expect(result.jobId).toBeDefined();
  });

  it('an unknown DM when an owner exists creates NO job and returns a pendingAuth notice intent to the owner', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('owner here', 'dm-owner-2'));
    const result = await call(agentId, dm('let me in', 'dm-stranger-2'));

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    expect(result.pendingAuth).toMatchObject({
      ownerConversationId: 'dm-owner-2',
      requesterConversationId: 'dm-stranger-2',
      requesterName: 'Bob',
    });

    const [pending] = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.conversationId, 'dm-stranger-2'));
    expect(pending?.status).toBe('pending');
    expect(pending?.role).toBe('member');

    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.chatId, 'dm-stranger-2'));
    expect(jobs).toHaveLength(0);
  });

  it('a repeat DM from an already-pending conversation does NOT re-ask the owner (no spam)', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('owner here', 'dm-owner-3'));
    await call(agentId, dm('let me in', 'dm-stranger-3')); // first ask
    const again = await call(agentId, dm('please?', 'dm-stranger-3')); // repeat

    expect(again.jobId).toBeUndefined();
    expect(again.skipped).toBe('awaiting_authorization');
    expect(again.pendingAuth).toBeUndefined();
  });

  it('an active member conversation creates a job', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('owner here', 'dm-owner-4'));
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId,
      channel: 'whatsapp',
      conversationId: 'dm-member-4',
      kind: 'private',
      role: 'member',
      status: 'active',
    });
    const result = await call(agentId, dm('hello', 'dm-member-4'));
    expect(result.jobId).toBeDefined();
  });
});

describe('handleWhatsAppMessage — group mention gating (mentionsSelf)', () => {
  it('ignores a group message that does not mention the bot', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('bootstrap owner', 'dm-owner-guild-1'));
    const result = await call(agentId, groupMessage('just chatting'));
    expect(result).toEqual({ skipped: 'group_filter' });
  });

  it('processes a group message that mentions the bot, prefixing the sender name', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('bootstrap owner', 'dm-owner-guild-2'));
    // This test is about mention gating, not H-1 — pre-authorize the group
    // itself (mirrors discord/handler.test.ts's pattern).
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId,
      channel: 'whatsapp',
      conversationId: 'group-2@g.us',
      kind: 'group',
      role: 'member',
      status: 'active',
    });
    const result = await call(
      agentId,
      groupMessage('@bot what time is it', { mentionsSelf: true, conversationId: 'group-2@g.us' }),
    );
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.channel).toBe('whatsapp');
    expect(job?.chatId).toBe('group-2@g.us');
    expect(job?.task).toContain('[Message from Alice]');
    expect(job?.task).toContain('@bot what time is it');
  });

  it('a group message when the bot has no owner yet is skipped (no_owner_group)', async () => {
    const agentId = await freshBot();
    const result = await call(
      agentId,
      groupMessage('@bot hello', { mentionsSelf: true, conversationId: 'group-3@g.us' }),
    );
    expect(result).toEqual({ skipped: 'no_owner_group' });
  });
});

describe('handleWhatsAppMessage — /ask routing gated by the TARGET agent allowlist', () => {
  it('routes /ask <slug> <text> to the named agent when the conversation is already active for it', async () => {
    const receiverId = await freshBot();
    await claimOwner(receiverId, dm('bootstrap receiver owner', 'dm-ask-1'));

    const [otherAgent] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Ask Target',
        slug: `whatsapp-ask-target-${Date.now()}`,
        personality: 'I am the target.',
      })
      .returning();
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: otherAgent!.id,
      channel: 'whatsapp',
      conversationId: 'dm-ask-1',
      kind: 'private',
      role: 'member',
      status: 'active',
    });

    const result = await call(
      receiverId,
      dm(`/ask ${otherAgent!.slug} what is the time`, 'dm-ask-1'),
    );
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.agentId).toBe(otherAgent!.id);
    expect(job?.task).toBe('what is the time');
  });

  it('/ask bypasses the group mention gate even without mentionsSelf', async () => {
    const receiverId = await freshBot();
    await claimOwner(receiverId, dm('bootstrap receiver owner', 'dm-ask-group-1'));
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: receiverId,
      channel: 'whatsapp',
      conversationId: 'group-ask-1@g.us',
      kind: 'group',
      role: 'member',
      status: 'active',
    });

    const result = await call(
      receiverId,
      groupMessage(`/ask ${'unknown-slug-xyz'} hi`, {
        mentionsSelf: false,
        conversationId: 'group-ask-1@g.us',
      }),
    );
    // Reached the /ask branch (not group_filter) — resolves to unknown agent.
    expect(result).toEqual({ skipped: 'ask_unknown_agent' });
  });

  it('/ask to a sibling the conversation has never talked to: NO job, pending member created, owner notified', async () => {
    const receiverId = await freshBot();
    await claimOwner(receiverId, dm('bootstrap receiver owner', 'dm-ask-2'));

    const targetAgentId = await freshBot();
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: targetAgentId,
      channel: 'whatsapp',
      conversationId: 'dm-ask-target-owner',
      kind: 'private',
      role: 'owner',
      status: 'active',
    });
    const [targetRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, targetAgentId));

    const result = await call(receiverId, dm(`/ask ${targetRow!.slug} please help`, 'dm-ask-2'));

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    expect(result.pendingAuth).toMatchObject({
      ownerConversationId: 'dm-ask-target-owner',
      requesterConversationId: 'dm-ask-2',
    });

    const [pendingRow] = await db
      .select()
      .from(channelAllowedConversations)
      .where(
        and(
          eq(channelAllowedConversations.agentId, targetAgentId),
          eq(channelAllowedConversations.conversationId, 'dm-ask-2'),
        ),
      );
    expect(pendingRow?.role).toBe('member');
    expect(pendingRow?.status).toBe('pending');

    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.agentId, targetAgentId));
    expect(jobs).toHaveLength(0);
  });

  it('skips /ask <unknown-slug> rather than blindly creating a job', async () => {
    const receiverId = await freshBot();
    await claimOwner(receiverId, dm('bootstrap receiver owner', 'dm-ask-3'));
    const result = await call(receiverId, dm('/ask not-a-real-agent please help', 'dm-ask-3'));
    expect(result).toEqual({ skipped: 'ask_unknown_agent' });
  });

  it('skips /ask with no text after the slug', async () => {
    const receiverId = await freshBot();
    await claimOwner(receiverId, dm('bootstrap receiver owner', 'dm-ask-4'));
    const result = await call(receiverId, dm('/ask some-slug', 'dm-ask-4'));
    expect(result).toEqual({ skipped: 'ask_no_text' });
  });
});

describe('handleWhatsAppMessage — /new dans un GROUPE (P6, revue Codex passe 28)', () => {
  /** Autorise le groupe, pour que le test porte sur `/new` et pas sur H-1. */
  async function groupeAutorise(agentId: string, conversationId: string): Promise<void> {
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId,
      channel: 'whatsapp',
      conversationId,
      kind: 'group',
      role: 'member',
      status: 'active',
    });
  }

  const filsDe = (agentId: string, conversationId: string) =>
    db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, agentId),
          eq(conversations.channel, 'whatsapp'),
          eq(conversations.chatId, conversationId),
        ),
      );

  const jobDe = async (jobId: string) => {
    const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
    if (!row) throw new Error('job introuvable');
    return row;
  };

  it('/new NU passe le filtre SANS mention et ouvre une DEUXIÈME conversation', async () => {
    // Baileys ne donne aucune porte de mention en amont : le filtre de groupe
    // rejetait `/new` avant la résolution du fil.
    const agentId = await freshBot();
    await seedActiveOwner(agentId, 'dm-owner-new-1');
    await groupeAutorise(agentId, 'group-new-1@g.us');

    const premier = await call(
      agentId,
      groupMessage('on parle de ça', { mentionsSelf: true, conversationId: 'group-new-1@g.us' }),
    );
    const ancien = await jobDe(premier.jobId!);

    // Sans mention : `/new` doit passer par le filtre seul.
    const nouveau = await call(
      agentId,
      groupMessage('/new', { conversationId: 'group-new-1@g.us' }),
    );
    const job = await jobDe(nouveau.jobId!);

    expect(job.conversationId).not.toBe(ancien.conversationId);
    expect(await filsDe(agentId, 'group-new-1@g.us')).toHaveLength(2);
    // Un `/new` NU reste exactement `/new` : pas de préfixe, pour que le tour
    // soit reconnu comme la commande d'ouverture (`openedByCommand`).
    expect(job.task).toBe('/new');
  });

  it('/new suivi d’un texte : tâche préfixée avec le TEXTE, dans le fil neuf', async () => {
    const agentId = await freshBot();
    await seedActiveOwner(agentId, 'dm-owner-new-2');
    await groupeAutorise(agentId, 'group-new-2@g.us');

    const premier = await call(
      agentId,
      groupMessage('on parle de ça', { mentionsSelf: true, conversationId: 'group-new-2@g.us' }),
    );
    const ancien = await jobDe(premier.jobId!);

    const nouveau = await call(
      agentId,
      groupMessage('/new rédige', { conversationId: 'group-new-2@g.us' }),
    );
    const job = await jobDe(nouveau.jobId!);

    expect(job.task).toBe('[Message from Alice]: rédige');
    expect(job.conversationId).not.toBe(ancien.conversationId);
  });
});
