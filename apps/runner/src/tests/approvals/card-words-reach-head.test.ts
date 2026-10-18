// card-words-reach-head.test.ts — ce qu'une personne écrit sur la carte d'un
// délégué arrive à la TÊTE du run, cité tel quel, avec QUI l'a écrit.
//
// L'incident (18/10, jobs 039f8666 → 5700457b) : Alfred délègue une
// vérification visuelle à un relecteur ; le relecteur demande une approbation ;
// la personne la refuse avec « arrete la review, imprime c'est bon! ». La note
// n'est allée qu'au relecteur, qui ne pouvait pas imprimer et a échoué ; Alfred
// n'a reçu que « failed » et a délégué de nouveau.
//
// Ce qui est prouvé, en base et dans la requête du modèle :
//   - toute sorte de carte (approbation refusée / approuvée avec note,
//     question, formulaire de serveur MCP), toute profondeur (enfant,
//     petit-enfant), deux canaux réels (le dashboard par la route
//     /api/approve, Telegram par le handler du bouton) ;
//   - la note est dans la file de la tête PENDANT qu'elle attend son délégué,
//     et dans la PREMIÈRE requête de la tête quand elle reprend, après le
//     résultat du délégué, mot pour mot ;
//   - rien de plus quand la carte est sur la tête elle-même, quand la tête a
//     fini (aucune tête relancée), quand la personne n'a rien écrit, et quand
//     deux réponses se croisent (une seule remise) ;
//   - (passe 1 de la revue) la décision ne dépend JAMAIS de la remise : une
//     chaîne de parents rompue (boucle, parent d'une autre entité) laisse la
//     décision écrite, la carte close, le délégué relancé, et le dit à la
//     personne là où elle a répondu (`handOff`, la phrase sur Telegram) ;
//   - (passe 1) le cadre dit QUI a répondu, avec le rôle que les données lui
//     donnent : un membre du dashboard est dit `member`, jamais propriétaire ;
//     une réponse du dashboard sans répondant est refusée.
//
// Mutations vérifiées (chacune rougit les tests nommés) :
//   - la remise retirée de `resolveApprovalDecision` (`words` forcé à null)
//     → tous les tests « reçoit » rougissent, et la requête de la tête ne
//     porte plus la note ;
//   - la garde `is_head` de `writeToRunHeadInbox` retirée → « carte sur la
//     tête » rougit (la tête se l'écrit à elle-même) ;
//   - la garde `not_live` retirée → « la tête a fini » rougit (une tête
//     relancée naît de la file, déclencheur 0141) ;
//   - `lockRunHead` qui s'arrête au parent direct → « petit-enfant » rougit
//     (la note va à l'intermédiaire) ;
//   - `lockRunHead` qui lève au lieu de rendre `found: false` → les deux
//     « chaîne rompue » rougissent (la décision est perdue, la carte reste
//     ouverte) ;
//   - le rôle lu dans `entity_members` remplacé par 'owner' → « un MEMBRE »
//     rougit ;
//   - la phrase retirée de la réponse Telegram → « la personne le lit sur
//     TELEGRAM » rougit.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  approvalRequests,
  conversations,
  entities,
  entityMembers,
  telegramAllowedChats,
  users,
  eq,
} from '@nodal-agents/db';
import { cardWordsNotice, isInboxMessage } from '@nodal-agents/shared';
import type { InboxEntry } from '@nodal-agents/shared';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { resumeDelegated } from '@nodal-agents/orchestration';
import type { JobId } from '@nodal-agents/orchestration';
import type { TelegramUpdate } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { resolveApprovalDecision } from '../../approvals/resolve.ts';
import { PERSON_ON_CARD_MARK } from '../../approvals/card-words.ts';
import { approveRoute } from '../../routes/approve.ts';
import { handleApprovalCallback } from '../../telegram/approval-callback.ts';
import { executeJob } from '../../job/execute.ts';

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      active = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('card-words-reach-head.test: no active LLM client set');
      return active;
    },
  };
});

// Le réseau sortant (réveil du worker, API Telegram) : rien ne part, tout
// répond ok, et ce qui serait parti est gardé pour être lu.
const sent: Array<{ url: string; body: unknown }> = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }),
);

/** Le dernier texte que le bot a répondu au tap (`answerCallbackQuery`). */
function lastCallbackAnswer(): { text?: string; show_alert?: boolean } | null {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    if (sent[i]!.url.includes('answerCallbackQuery')) {
      return sent[i]!.body as { text?: string; show_alert?: boolean };
    }
  }
  return null;
}

const NOTE = "arrete la review, imprime c'est bon!";
const CHAT_ID = '199791464';
const OPTIONS = ['The repo README', 'A new file in notes'];

const env = {
  WORKER_SECRET: 'test-secret',
  APP_URL: 'http://localhost:3099',
  NODALAI_APPROVAL_GRACE_MS: 0,
} as unknown as RunnerEnv;

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
/** La tête (Alfred), le relais (lead) et le relecteur qui tient la carte. */
let rootAgentId = '';
let leadAgentId = '';
let reviewerAgentId = '';
let reviewerSlug = '';
/** Le propriétaire de l'entité, et un membre invité : deux comptes du dashboard. */
let ownerUserId = '';
let ownerEmail = '';
let memberUserId = '';
let memberEmail = '';

function makeDeps(llmClient?: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  if (llmClient) setActiveLlmClient(llmClient);
  return {
    db: db as RunnerDeps['db'],
    llmClient: llmClient ?? ({} as RunnerDeps['llmClient']),
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  rootAgentId = seed.agentId;
  ownerUserId = seed.userId;
  const [owner] = await db.select().from(users).where(eq(users.id, ownerUserId));
  ownerEmail = owner!.email;
  await db
    .insert(entityMembers)
    .values({ entityId: seed.entityId, userId: ownerUserId, role: 'owner' });
  memberEmail = `invite-${randomUUID().slice(0, 8)}@example.com`;
  const [member] = await db.insert(users).values({ email: memberEmail }).returning();
  memberUserId = member!.id;
  await db
    .insert(entityMembers)
    .values({ entityId: seed.entityId, userId: memberUserId, role: 'member' });
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true, telegramBotToken: '123:fake' })
    .where(eq(agents.id, rootAgentId));
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: rootAgentId,
    chatId: CHAT_ID,
    role: 'owner',
    status: 'active',
  });
  const [seedAgent] = await db.select().from(agents).where(eq(agents.id, rootAgentId));
  reviewerSlug = `reviewer-${randomUUID().slice(0, 8)}`;
  const [reviewer] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Reviewer A',
      slug: reviewerSlug,
      personality: 'You review.',
      llmKeyId: seedAgent!.llmKeyId,
    })
    .returning({ id: agents.id });
  reviewerAgentId = reviewer!.id;
  const [lead] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Lead',
      slug: `lead-${randomUUID().slice(0, 8)}`,
      personality: 'You lead.',
      llmKeyId: seedAgent!.llmKeyId,
    })
    .returning({ id: agents.id });
  leadAgentId = lead!.id;
});

/** Une tête qui attend son délégué : sa demande, puis son appel `assign_*` ouvert. */
async function insertHead(values: Record<string, unknown> = {}): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: rootAgentId, channel: 'telegram', chatId: CHAT_ID })
    .returning({ id: conversations.id });
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: rootAgentId,
      channel: 'api',
      chatId: CHAT_ID,
      conversationId: conv!.id,
      task: 'Imprime la recette',
      status: 'awaiting_delegation',
      messages: [
        { role: 'user', content: 'Imprime la recette' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-1',
              toolName: 'assign_reviewer',
              input: { task: 'vérifie le rendu' },
            },
          ],
        },
      ],
      pendingDelegation: { type: 'single', toolUseId: 'assign-1', toolName: 'assign_reviewer' },
      ...values,
    } as never)
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function insertChild(
  parentJobId: string,
  agentId: string,
  values: Record<string, unknown> = {},
): Promise<string> {
  const [parent] = await db
    .select({ conversationId: agentJobs.conversationId, depth: agentJobs.delegationDepth })
    .from(agentJobs)
    .where(eq(agentJobs.id, parentJobId));
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId,
      channel: 'internal',
      chatId: CHAT_ID,
      conversationId: parent!.conversationId,
      parentJobId,
      delegationDepth: (parent!.depth ?? 0) + 1,
      task: 'vérifie le rendu',
      status: 'awaiting_approval',
      messages: [{ role: 'user', content: 'vérifie le rendu' }],
      ...values,
    } as never)
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function insertCard(
  jobId: string,
  agentId: string,
  values: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId,
      agentId,
      toolName: 'mcp_playwright__browser_run_code_unsafe',
      toolInput: { code: 'await page.screenshot()' },
      toolCallId: 'call-gated',
      status: 'pending',
      ...values,
    } as never)
    .returning({ id: approvalRequests.id });
  return row!.id;
}

async function jobRow(jobId: string) {
  const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
  return row!;
}

async function inboxOf(jobId: string): Promise<InboxEntry[]> {
  return (await jobRow(jobId)).inbox;
}

async function jobsOfConversation(conversationId: string): Promise<number> {
  const rows = await db
    .select({ id: agentJobs.id })
    .from(agentJobs)
    .where(eq(agentJobs.conversationId, conversationId));
  return rows.length;
}

/**
 * Le dashboard : la vraie route POST /api/approve, appelée comme le web
 * l'appelle, avec le compte de la session (`responderUserId`), ou sans
 * (`null`) pour prouver le refus.
 */
async function answerFromDashboard(
  body: Record<string, unknown>,
  responderUserId: string | null = ownerUserId,
): Promise<Response> {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('callerTrusted' as never, true as never);
    await next();
  });
  app.post('/api/approve', (c) => approveRoute(c, makeDeps(), env));
  return app.request('/api/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(responderUserId === null ? body : { ...body, responderUserId }),
  });
}

function telegramTap(data: string): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: 'cbq-1',
      data,
      from: { id: 42, first_name: 'Q' },
      message: { message_id: 555, chat: { id: Number(CHAT_ID), type: 'private' } },
    },
  };
}

describe('les mots de la personne sur une carte vont à la tête du run @cap:approuver-une-action/moteur', () => {
  it('un refus avec note, depuis le dashboard : la tête la reçoit pendant qu’elle attend', async () => {
    const head = await insertHead();
    const child = await insertChild(head, reviewerAgentId);
    const card = await insertCard(child, reviewerAgentId);

    const res = await answerFromDashboard({
      approvalRequestId: card,
      decision: 'reject',
      notes: NOTE,
    });
    expect(res.status).toBe(200);
    // La route dit à l'appelant que les mots sont arrivés à la tête.
    expect(((await res.json()) as { handOff: unknown }).handOff).toEqual({
      kind: 'delivered',
      headJobId: head,
    });

    // La carte : la décision et la note, comme avant.
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, card));
    expect(row!.status).toBe('rejected');
    expect(row!.notes).toBe(NOTE);
    // Le délégué repart, pour lire son [REJECTED] — inchangé.
    expect((await jobRow(child)).status).toBe('pending');

    // La tête attend toujours, et sa file porte les mots de la personne.
    const headRow = await jobRow(head);
    expect(headRow.status).toBe('awaiting_delegation');
    expect(headRow.inbox).toHaveLength(1);
    const entry = headRow.inbox[0]!;
    expect(entry.content).toBe(
      `${PERSON_ON_CARD_MARK} · by: owner user:${ownerEmail} · agent: ${reviewerSlug} · ` +
        `job: ${child} · ` +
        'tool: mcp_playwright__browser_run_code_unsafe · card: approval · decision: rejected · via: api\n' +
        `note:\n${NOTE}`,
    );
    expect(entry.fromApprovalRequestId).toBe(card);
    expect(entry.fromJobId).toBe(child);
    // Le délégué, lui, n'a rien dans sa file : il a son résultat d'outil.
    expect(await inboxOf(child)).toEqual([]);
  });

  it('une approbation avec note sur un PETIT-enfant : la tête, pas l’intermédiaire', async () => {
    const head = await insertHead();
    const lead = await insertChild(head, leadAgentId, { status: 'awaiting_delegation' });
    const grandchild = await insertChild(lead, reviewerAgentId);
    const card = await insertCard(grandchild, reviewerAgentId);

    const r = await resolveApprovalDecision(makeDeps(), env, {
      approvalRequestId: card,
      decision: 'approve',
      resolvedBy: 'api',
      answeredBy: { userId: ownerUserId },
      notes: 'vas-y, mais une seule capture',
    });
    expect(r.ok).toBe(true);

    expect(await inboxOf(lead)).toEqual([]);
    const inbox = await inboxOf(head);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.content).toContain(`job: ${grandchild}`);
    expect(inbox[0]!.content).toContain(
      'decision: approved · via: api\nnote:\nvas-y, mais une seule capture',
    );
  });

  it('une question répondue d’un bouton TELEGRAM : la réponse choisie va à la tête', async () => {
    const head = await insertHead();
    const child = await insertChild(head, reviewerAgentId);
    const card = await insertCard(child, reviewerAgentId, {
      toolName: 'ask_user',
      toolInput: { question: 'Where should I write it?', options: OPTIONS },
      kind: 'question',
    });

    const r = await handleApprovalCallback({
      update: telegramTap(`apr:${card}:o1`),
      receivingAgentId: rootAgentId,
      botToken: '123:fake',
      deps: makeDeps(),
      env,
    });
    expect(r.handled).toBe(true);

    const inbox = await inboxOf(head);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.content).toContain(
      'tool: ask_user · card: question · decision: answered · via: telegram',
    );
    // Qui : la conversation autorisée d'où vient le tap, et son rôle en base.
    expect(inbox[0]!.content).toContain(` · by: owner telegram:${CHAT_ID} · `);
    expect(inbox[0]!.content.endsWith(`\nanswer:\n${OPTIONS[1]}`)).toBe(true);
  });

  it('une réponse LIBRE du dashboard : ses mots, tels quels', async () => {
    const head = await insertHead();
    const child = await insertChild(head, reviewerAgentId);
    const card = await insertCard(child, reviewerAgentId, {
      toolName: 'ask_user',
      toolInput: { question: 'Where should I write it?', options: OPTIONS },
      kind: 'question',
    });

    const res = await answerFromDashboard({
      approvalRequestId: card,
      decision: 'approve',
      answer: 'Nulle part, imprime directement',
      free: true,
    });
    expect(res.status).toBe(200);

    const inbox = await inboxOf(head);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.content.endsWith('\nanswer:\nNulle part, imprime directement')).toBe(true);
  });

  it('le formulaire d’un serveur MCP : ses valeurs vont à la tête', async () => {
    const head = await insertHead();
    // Une élicitation est posée PENDANT un appel : le délégué tourne.
    const child = await insertChild(head, reviewerAgentId, { status: 'processing' });
    const card = await insertCard(child, reviewerAgentId, {
      kind: 'elicitation',
      toolName: 'mcp_docs__render',
      toolInput: {
        server: 'docs',
        message: 'How many copies?',
        requestedSchema: {
          type: 'object',
          properties: { copies: { type: 'number' } },
          required: ['copies'],
        },
      },
    });

    const res = await answerFromDashboard({
      approvalRequestId: card,
      decision: 'approve',
      content: { copies: 2 },
    });
    expect(res.status).toBe(200);

    const inbox = await inboxOf(head);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.content).toContain('card: elicitation · decision: sent · via: api');
    expect(inbox[0]!.content.endsWith('\nform:\n{"copies":2}')).toBe(true);
  });

  it('une carte sur la TÊTE elle-même : rien de plus dans sa file, elle a son résultat d’outil', async () => {
    const head = await insertHead({ status: 'awaiting_approval', pendingDelegation: null });
    const card = await insertCard(head, rootAgentId);

    const r = await resolveApprovalDecision(makeDeps(), env, {
      approvalRequestId: card,
      decision: 'reject',
      resolvedBy: 'api',
      answeredBy: { userId: ownerUserId },
      notes: NOTE,
    });
    expect(r.ok).toBe(true);
    expect(await inboxOf(head)).toEqual([]);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, card));
    expect(row!.notes).toBe(NOTE);
  });

  it('la tête a FINI : rien n’est écrit, aucune tête ne naît de sa file', async () => {
    const head = await insertHead({ status: 'completed', result: 'fait' });
    const child = await insertChild(head, reviewerAgentId);
    const card = await insertCard(child, reviewerAgentId);
    const conversationId = (await jobRow(head)).conversationId!;
    const before = await jobsOfConversation(conversationId);

    const r = await resolveApprovalDecision(makeDeps(), env, {
      approvalRequestId: card,
      decision: 'reject',
      resolvedBy: 'api',
      answeredBy: { userId: ownerUserId },
      notes: NOTE,
    });
    expect(r.ok).toBe(true);
    expect(await inboxOf(head)).toEqual([]);
    expect(await jobsOfConversation(conversationId)).toBe(before);
    // La décision est écrite, et le délégué la lira dans son résultat.
    expect((await jobRow(child)).status).toBe('pending');
  });

  it('un clic seul, sans un mot : rien à citer', async () => {
    const head = await insertHead();
    const child = await insertChild(head, reviewerAgentId);
    const card = await insertCard(child, reviewerAgentId);

    const r = await handleApprovalCallback({
      update: telegramTap(`apr:${card}:r`),
      receivingAgentId: rootAgentId,
      botToken: '123:fake',
      deps: makeDeps(),
      env,
    });
    expect(r.handled).toBe(true);
    expect(await inboxOf(head)).toEqual([]);
  });

  it('deux réponses qui se croisent : une seule décision, une seule remise', async () => {
    const head = await insertHead();
    const child = await insertChild(head, reviewerAgentId);
    const card = await insertCard(child, reviewerAgentId);

    const results = await Promise.all([
      resolveApprovalDecision(makeDeps(), env, {
        approvalRequestId: card,
        decision: 'reject',
        resolvedBy: 'api',
        answeredBy: { userId: ownerUserId },
        notes: 'première',
      }),
      resolveApprovalDecision(makeDeps(), env, {
        approvalRequestId: card,
        decision: 'reject',
        resolvedBy: 'api',
        answeredBy: { userId: ownerUserId },
        notes: 'seconde',
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, card));
    const inbox = await inboxOf(head);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.content.endsWith(`\nnote:\n${row!.notes}`)).toBe(true);
  });
});

// ─── Passe 1 de la revue : la décision d'abord, et QUI a répondu ──────────────

describe('la décision ne dépend jamais de la remise, et le cadre dit qui a répondu @cap:approuver-une-action/moteur', () => {
  it('une chaîne de parents en BOUCLE : la décision est écrite, la remise manque et se dit', async () => {
    const a = await insertHead({ status: 'awaiting_delegation' });
    const b = await insertChild(a, reviewerAgentId);
    // a ← b ← a : aucune tête au sommet.
    await db.update(agentJobs).set({ parentJobId: b }).where(eq(agentJobs.id, a));
    const card = await insertCard(b, reviewerAgentId);

    const res = await answerFromDashboard({
      approvalRequestId: card,
      decision: 'reject',
      notes: NOTE,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { handOff: { kind: string; reason?: string } };
    expect(body.handOff.kind).toBe('no_head');
    expect(body.handOff.reason).toContain('does not end');

    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, card));
    expect(row!.status).toBe('rejected');
    expect(row!.notes).toBe(NOTE);
    expect((await jobRow(b)).status).toBe('pending');
    expect(await inboxOf(a)).toEqual([]);
    expect(await inboxOf(b)).toEqual([]);
  });

  it('un parent d’une AUTRE entité : la décision est écrite, rien ne traverse', async () => {
    const [other] = await db
      .insert(entities)
      .values({ userId: ownerUserId, name: 'Other', slug: `other-${randomUUID().slice(0, 8)}` })
      .returning({ id: entities.id });
    const foreignHead = await insertHead({ entityId: other!.id });
    const child = await insertChild(foreignHead, reviewerAgentId);
    const card = await insertCard(child, reviewerAgentId);

    const r = await resolveApprovalDecision(makeDeps(), env, {
      approvalRequestId: card,
      decision: 'reject',
      resolvedBy: 'api',
      answeredBy: { userId: ownerUserId },
      notes: NOTE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.handOff).toEqual({
      kind: 'no_head',
      reason: `job ${foreignHead} (in the parent chain of ${child}) is not in this entity`,
    });
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, card));
    expect(row!.status).toBe('rejected');
    expect(await inboxOf(foreignHead)).toEqual([]);
  });

  it('la tête a fini : la personne le lit sur TELEGRAM, là où elle a répondu', async () => {
    const head = await insertHead({ status: 'completed', result: 'fait' });
    const child = await insertChild(head, reviewerAgentId);
    const card = await insertCard(child, reviewerAgentId, {
      toolName: 'ask_user',
      toolInput: { question: 'Where should I write it?', options: OPTIONS },
      kind: 'question',
    });
    sent.length = 0;

    const r = await handleApprovalCallback({
      update: telegramTap(`apr:${card}:o0`),
      receivingAgentId: rootAgentId,
      botToken: '123:fake',
      deps: makeDeps(),
      env,
    });
    expect(r.handled).toBe(true);
    const notice = cardWordsNotice({ kind: 'head_finished', headJobId: head, status: 'completed' });
    expect(notice).not.toBeNull();
    expect(lastCallbackAnswer()).toEqual(
      expect.objectContaining({ text: `✅ ${OPTIONS[0]}\n${notice}`, show_alert: true }),
    );
  });

  it('un MEMBRE qui répond du dashboard est dit membre, jamais propriétaire', async () => {
    const head = await insertHead();
    const child = await insertChild(head, reviewerAgentId);
    const card = await insertCard(child, reviewerAgentId);

    const res = await answerFromDashboard(
      { approvalRequestId: card, decision: 'reject', notes: 'imprime' },
      memberUserId,
    );
    expect(res.status).toBe(200);
    const inbox = await inboxOf(head);
    expect(inbox).toHaveLength(1);
    expect(
      inbox[0]!.content.startsWith(`${PERSON_ON_CARD_MARK} · by: member user:${memberEmail} · `),
    ).toBe(true);
    expect(inbox[0]!.content).not.toContain('owner');
  });

  it('une réponse du dashboard SANS répondant est refusée, la carte reste ouverte', async () => {
    const head = await insertHead();
    const child = await insertChild(head, reviewerAgentId);
    const card = await insertCard(child, reviewerAgentId);

    const res = await answerFromDashboard(
      { approvalRequestId: card, decision: 'reject', notes: NOTE },
      null,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'responder_required' });
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, card));
    expect(row!.status).toBe('pending');
    expect(await inboxOf(head)).toEqual([]);
  });
});

// ─── La tête LIT la note : sa requête au modèle ───────────────────────────────

type MockTurn = {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
};

function mockLlm(responses: MockTurn[], prompts: unknown[]): RunnerDeps['llmClient'] {
  let i = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const r = responses[i] ?? responses[responses.length - 1]!;
      i += 1;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (r.text) content.push({ type: 'text', text: r.text });
      for (const tc of r.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }
      const calls = (r.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: calls
          ? { unified: 'tool-calls' as const, raw: 'tool-calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return {
    config: { provider: 'anthropic', model: 'mock' } as RunnerDeps['llmClient']['config'],
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) =>
      (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text) : '',
    )
    .join('');
}

describe('la tête lit les mots de la personne à sa reprise @cap:approuver-une-action/moteur', () => {
  it('sa PREMIÈRE requête porte le résultat du délégué, PUIS la note, mot pour mot', async () => {
    const head = await insertHead();
    const child = await insertChild(head, reviewerAgentId);
    const card = await insertCard(child, reviewerAgentId);

    const answered = await resolveApprovalDecision(makeDeps(), env, {
      approvalRequestId: card,
      decision: 'reject',
      resolvedBy: 'api',
      answeredBy: { userId: ownerUserId },
      notes: NOTE,
    });
    expect(answered.ok).toBe(true);

    // Le relecteur, en lecture seule, ne peut pas imprimer : il échoue, et
    // son issue remonte à la tête par le chemin ordinaire.
    await db
      .update(agentJobs)
      .set({ status: 'failed', error: 'cannot print' })
      .where(eq(agentJobs.id, child));
    await resumeDelegated(
      head as JobId,
      child as JobId,
      { status: 'failed', summary: '', error: 'cannot print' },
      db,
    );

    const prompts: unknown[] = [];
    const deps = makeDeps(
      mockLlm(
        [
          {
            text: 'Recette imprimée.',
            toolCalls: [
              { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
            ],
          },
        ],
        prompts,
      ),
    );
    await executeJob(head as JobId, deps, env);

    const first = prompts[0] as Array<{ role: string; content: unknown }>;
    expect(first, 'la tête n’a fait aucune requête').toBeDefined();
    const toolAt = first.findIndex(
      (m) =>
        m.role === 'tool' &&
        JSON.stringify(m.content).includes('assign-1') &&
        JSON.stringify(m.content).includes('cannot print'),
    );
    const noteAt = first.findIndex((m) => m.role === 'user' && textOf(m.content).includes(NOTE));
    expect(toolAt, 'le résultat du délégué manque').toBeGreaterThanOrEqual(0);
    expect(noteAt, 'la note de la personne manque à la requête de la tête').toBeGreaterThan(toolAt);
    expect(textOf(first[noteAt]!.content)).toContain(`note:\n${NOTE}`);

    // La file est vidée, et la note vit dans la transcription de la tête.
    const row = await jobRow(head);
    expect(row.inbox).toEqual([]);
    const kept = (row.messages as unknown[]).filter(isInboxMessage);
    expect(kept.map((m) => textOf((m as { content: unknown }).content))).toEqual([
      expect.stringContaining(`note:\n${NOTE}`),
    ]);
  });
});
