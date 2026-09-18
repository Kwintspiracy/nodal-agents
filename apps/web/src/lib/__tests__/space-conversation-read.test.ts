// space-conversation-read.test.ts — la lecture du fil d'un espace (P2) : des
// lignes RÉELLES écrites en base (job + messages, tool_calls avec carte et
// charge utile P1, llm_calls par tour, un enfant) et ce que l'action rend.
// Bornée à l'entité : le job d'une autre entité n'existe pas.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  toolCalls,
  llmCalls,
  entities,
  users,
  verificationRuns,
  jobDeliveries,
} from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let jobId: string;
let childId: string;
let foreignJobId: string;

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

const actions = () => import('../actions.ts');

const tablePayload = {
  card: 'table',
  tables: [
    {
      columns: ['fact', 'category'],
      header: 'columns',
      rows: [['Quentin aime les tableaux', 'preference']],
      total: 1,
      truncated: false,
      clipped: false,
    },
  ],
};
const sentPayload = { card: 'sent', channel: 'telegram', kind: 'message', target: '4242' };

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '4242',
      task: 'Rappelle-moi ce que j’aime',
      status: 'completed',
      result: 'Tu aimes les tableaux.',
      turn: 2,
      messages: [
        { role: 'user', content: 'Rappelle-moi ce que j’aime' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'La mémoire doit le savoir.' },
            {
              type: 'tool-call',
              toolCallId: 'c_qm',
              toolName: 'query_memory',
              input: { query: 'aime' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c_qm',
              toolName: 'query_memory',
              output: { type: 'json', value: [{ fact: 'Quentin aime les tableaux' }] },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Tu aimes les tableaux.' },
            {
              type: 'tool-call',
              toolCallId: 'c_tg',
              toolName: 'telegram_send_message',
              input: { text: 'Tu aimes les tableaux.' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c_tg',
              toolName: 'telegram_send_message',
              output: { type: 'json', value: { messageId: '9' } },
            },
          ],
        },
      ],
    })
    .returning();
  jobId = job!.id;

  await testDb.insert(toolCalls).values([
    {
      entityId: seed.entityId,
      jobId,
      toolName: 'query_memory',
      toolInput: { query: 'aime' },
      toolOutput: JSON.stringify([{ fact: 'Quentin aime les tableaux', category: 'preference' }]),
      durationMs: 12,
      turn: 1,
      toolCallId: 'c_qm',
      card: 'table',
      presented: tablePayload,
    },
    {
      entityId: seed.entityId,
      jobId,
      toolName: 'telegram_send_message',
      toolInput: { text: 'Tu aimes les tableaux.' },
      toolOutput: JSON.stringify({ messageId: '9' }),
      durationMs: 830,
      turn: 2,
      toolCallId: 'c_tg',
      card: 'sent',
      presented: sentPayload,
    },
  ]);

  await testDb.insert(llmCalls).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId,
      source: 'job',
      turn: 1,
      modelEffective: 'claude-opus-5',
      provider: 'anthropic',
      inputTokens: 1200,
      outputTokens: 40,
      cachedTokens: 1000,
      costUsd: 0.01,
      durationMs: 2100,
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId,
      source: 'job',
      turn: 2,
      modelEffective: 'claude-opus-5',
      provider: 'anthropic',
      inputTokens: 1300,
      outputTokens: 30,
      cachedTokens: 1250,
      costUsd: 0.005,
      durationMs: 1500,
    },
  ]);

  const [child] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'sous-tâche',
      status: 'completed',
      result: 'fait',
      parentJobId: jobId,
    })
    .returning();
  childId = child!.id;

  // P3 — une preuve rouge (deux commandes, la seconde a échoué) sur l'ENFANT,
  // qui doit remonter à la racine ; et un envoi Telegram encore en reprise.
  const seq = '33333333-3333-4333-8333-333333333333';
  await testDb.insert(verificationRuns).values([
    {
      jobId: childId,
      entityId: seed.entityId,
      deliverableType: 'code_project',
      canonicalKey: 'd:/apps/projet',
      sequenceId: seq,
      commandRank: 1,
      command: 'pnpm typecheck',
      exitCode: 0,
      outcomeKind: 'exit',
      durationMs: 1500,
      verdict: 'green',
    },
    {
      jobId: childId,
      entityId: seed.entityId,
      deliverableType: 'code_project',
      canonicalKey: 'd:/apps/projet',
      sequenceId: seq,
      commandRank: 2,
      command: 'pnpm test',
      exitCode: 1,
      outcomeKind: 'exit',
      stdoutTail: '1 failed',
      durationMs: 9000,
      verdict: 'red',
    },
  ]);
  // …et un PETIT-ENFANT avec sa propre preuve, verte : elle doit remonter aussi
  // (revue passe 20 : les enfants directs seuls la laissaient dehors).
  const [grandchild] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'sous-sous-tâche',
      status: 'completed',
      parentJobId: childId,
    })
    .returning();
  await testDb.insert(verificationRuns).values({
    jobId: grandchild!.id,
    entityId: seed.entityId,
    deliverableType: 'code_project',
    canonicalKey: 'd:/apps/projet',
    sequenceId: '44444444-4444-4444-8444-444444444444',
    commandRank: 1,
    command: 'pnpm lint',
    exitCode: 0,
    outcomeKind: 'exit',
    durationMs: 700,
    verdict: 'green',
  });
  await testDb.insert(jobDeliveries).values({
    jobId,
    channel: 'telegram',
    chatId: '4242',
    payload: 'Tu aimes les tableaux.',
    outcome: 'attempted',
    idempotencyKey: `p3-${jobId}`,
    attempts: 2,
  });

  // Un job d'une AUTRE entité : il ne doit pas se lire depuis celle-ci.
  const [otherUser] = await testDb
    .insert(users)
    .values({ email: `other-${Date.now()}@example.com` })
    .returning();
  const [otherEntity] = await testDb
    .insert(entities)
    .values({ userId: otherUser!.id, name: 'Other', slug: `other-${Date.now()}` })
    .returning();
  const [foreign] = await testDb
    .insert(agentJobs)
    .values({ entityId: otherEntity!.id, channel: 'api', task: 'ailleurs', status: 'completed' })
    .returning();
  foreignJobId = foreign!.id;
});

describe('getSpaceConversationAction', () => {
  it('rend le fil depuis les lignes réelles : demande, tours, cartes persistées, enfant, réponse', async () => {
    const { getSpaceConversationAction } = await actions();
    const r = await getSpaceConversationAction(jobId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.job).toMatchObject({ id: jobId, channel: 'telegram', status: 'completed' });
    const kinds = r.data.feed.items.map((i) => i.kind);
    // Pas d'item `answer` : le résultat du job (« Tu aimes les tableaux. ») EST
    // la prose du dernier tour, et le fil ne la répète plus (P2bis).
    // #135 — le PETIT-ENFANT n'est plus dans le bloc de l'enfant : il est le
    // bloc SUIVANT, au même niveau. Une délégation n'est jamais imbriquée.
    expect(kinds).toEqual(['request', 'turn', 'turn', 'child', 'child']);

    const [request, t1, t2, child, grandchildItem] = r.data.feed.items;
    expect(request).toMatchObject({
      kind: 'request',
      text: 'Rappelle-moi ce que j’aime',
      origin: { channel: 'telegram', chatId: '4242', scheduleName: null },
    });

    // Tour 1 : raisonnement + query_memory (table à UNE ligne → carte seule), jetons du tour 1.
    expect(t1?.kind === 'turn' && t1.model).toBe('claude-opus-5');
    expect(t1?.kind === 'turn' && t1.usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 40,
      cachedTokens: 1000,
      costUsd: 0.01,
    });
    const t1Blocks = t1?.kind === 'turn' ? t1.blocks : [];
    expect(t1Blocks.map((b) => b.kind)).toEqual(['steps', 'card']);
    const stepsBlock = t1Blocks[0];
    expect(stepsBlock?.kind === 'steps' && stepsBlock.steps[0]).toEqual({
      kind: 'reasoning',
      text: 'La mémoire doit le savoir.',
    });
    const tableCard = t1Blocks[1];
    expect(tableCard?.kind === 'card' && tableCard.step.card).toBe('table');
    expect(tableCard?.kind === 'card' && tableCard.step.presented).toEqual(tablePayload);
    expect(tableCard?.kind === 'card' && tableCard.step.durationMs).toBe(12);

    // Tour 2 : prose puis l'envoi Telegram, charge utile persistée telle quelle.
    const t2Blocks = t2?.kind === 'turn' ? t2.blocks : [];
    expect(t2Blocks.map((b) => b.kind)).toEqual(['prose', 'card']);
    expect(t2Blocks[0]?.kind === 'prose' && t2Blocks[0].text).toBe('Tu aimes les tableaux.');
    expect(t2Blocks[1]?.kind === 'card' && t2Blocks[1].step.presented).toEqual(sentPayload);

    expect(child?.kind === 'child' && child.job.id).toBe(childId);
    expect(child?.kind === 'child' && child.job.status).toBe('completed');
    // Le petit-enfant dit qui l'a délégué : l'ENFANT, pas la tête du fil.
    expect(grandchildItem?.kind === 'child' && grandchildItem.job.task).toBe('sous-sous-tâche');
    expect(grandchildItem?.kind === 'child' && grandchildItem.from.slug).toBe(
      child?.kind === 'child' ? child.job.agentSlug : null,
    );
    // Et le fil de l'enfant ne le porte plus : remonté, pas recopié.
    const nestedChildren =
      child?.kind === 'child'
        ? (child.job.feed?.items.filter((i) => i.kind === 'child') ?? [])
        : [];
    expect(nestedChildren).toEqual([]);
    expect(r.data.feed.items.some((i) => i.kind === 'answer')).toBe(false);

    expect(r.data.feed.totals).toMatchObject({
      turns: 2,
      toolCalls: 2,
      inputTokens: 2500,
      outputTokens: 70,
      cachedTokens: 2250,
      costUsd: 0.015,
      models: ['claude-opus-5'],
    });
  });

  it('une demande qui contient un secret garde sa frontière : la tâche est rédigée comme les messages', async () => {
    // Passe 18 : les messages passent par redactTranscriptForDisplay, la tâche
    // comparée doit passer par la même — sinon la frontière tombe à 0 et
    // l'historique redevient « ce job ».
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // secrets:allow (fixture : clé factice pour éprouver la rédaction)
    const task = `Utilise la clé ${secret} pour lister les modèles`;
    const [j] = await testDb
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '4242',
        task,
        status: 'completed',
        result: 'Trois modèles.',
        messages: [
          { role: 'user', content: 'Bonjour' },
          { role: 'assistant', content: 'Bonjour Quentin.' },
          { role: 'user', content: task },
          { role: 'assistant', content: 'Trois modèles.' },
        ],
      })
      .returning();
    const { getSpaceConversationAction } = await actions();
    const r = await getSpaceConversationAction(j!.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // « Trois modèles. » est déjà la prose du tour : pas de second item.
    expect(r.data.feed.items.map((i) => i.kind)).toEqual(['history', 'request', 'turn']);
    const request = r.data.feed.items[1];
    expect(request?.kind === 'request' && request.text).not.toContain(secret);
    expect(request?.kind === 'request' && request.text).toContain('[secret masqué]');
    // L'en-tête de la page non plus ne montre pas le secret.
    expect(r.data.job.task).not.toContain(secret);
    expect(r.data.feed.items.some((i) => i.kind === 'note')).toBe(false);
  });

  it('#150 : la CARTE d’un appel est masquée comme sa sortie brute, forme intacte', async () => {
    // Le fil rédigeait `tool_output` et laissait passer `presented`, bâtie sur
    // la MÊME sortie : le jeton s'affichait masqué en vue brute et en clair sur
    // la carte, qui est justement ce que `ToolBlock` rend en premier.
    const secret = 'sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210'; // secrets:allow (fixture : clé factice pour éprouver la rédaction)
    const lecture = {
      card: 'read',
      path: '/srv/app/.env',
      excerpt: `ANTHROPIC_API_KEY=${secret}\nPORT=3000`,
      chars: 64,
      truncated: false,
    };
    const ecriture = {
      card: 'files',
      files: [{ path: `/srv/app/sauvegarde-${secret}.env`, action: 'written', bytes: 64 }],
      total: 1,
      truncated: false,
    };
    const [j] = await testDb
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '4242',
        task: 'Sauvegarde la configuration',
        status: 'completed',
        result: 'Configuration sauvegardée.',
        turn: 1,
        messages: [
          { role: 'user', content: 'Sauvegarde la configuration' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'c_read',
                toolName: 'file_read',
                input: { path: '/srv/app/.env' },
              },
              {
                type: 'tool-call',
                toolCallId: 'c_write',
                toolName: 'file_write',
                input: { path: '/srv/app/sauvegarde.env' },
              },
              {
                type: 'tool-call',
                toolCallId: 'c_nu',
                toolName: 'file_read',
                input: { path: '/srv/app/vide.txt' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'c_read',
                toolName: 'file_read',
                output: { type: 'text', value: 'lu' },
              },
              {
                type: 'tool-result',
                toolCallId: 'c_write',
                toolName: 'file_write',
                output: { type: 'text', value: 'écrit' },
              },
              {
                type: 'tool-result',
                toolCallId: 'c_nu',
                toolName: 'file_read',
                output: { type: 'text', value: 'vide' },
              },
            ],
          },
          { role: 'assistant', content: 'Configuration sauvegardée.' },
        ],
      })
      .returning();

    await testDb.insert(toolCalls).values([
      {
        entityId: seed.entityId,
        jobId: j!.id,
        toolName: 'file_read',
        toolInput: { path: '/srv/app/.env' },
        toolOutput: `ANTHROPIC_API_KEY=${secret}`,
        durationMs: 5,
        turn: 1,
        toolCallId: 'c_read',
        card: 'read',
        presented: lecture,
      },
      {
        entityId: seed.entityId,
        jobId: j!.id,
        toolName: 'file_write',
        toolInput: { path: '/srv/app/sauvegarde.env' },
        toolOutput: 'ok',
        durationMs: 7,
        turn: 1,
        toolCallId: 'c_write',
        card: 'files',
        presented: ecriture,
      },
      {
        // Une ligne SANS charge utile : la rédaction ne doit rien casser.
        entityId: seed.entityId,
        jobId: j!.id,
        toolName: 'file_read',
        toolInput: { path: '/srv/app/vide.txt' },
        toolOutput: 'vide',
        durationMs: 3,
        turn: 1,
        toolCallId: 'c_nu',
        card: null,
        presented: null,
      },
    ]);

    const { getSpaceConversationAction } = await actions();
    const r = await getSpaceConversationAction(j!.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const steps = r.data.feed.items.flatMap((i) =>
      i.kind === 'turn'
        ? i.blocks.flatMap((b) =>
            b.kind === 'card' ? [b.step] : b.kind === 'steps' ? b.steps : [],
          )
        : [],
    );
    const parCall = new Map(
      steps.flatMap((s) => (s.kind === 'tool' && s.toolCallId ? [[s.toolCallId, s] as const] : [])),
    );

    // La carte `read` : l'extrait masqué, tout le reste de la charge intact.
    const lue = parCall.get('c_read');
    expect(lue?.kind === 'tool' && lue.presented).toEqual({
      card: 'read',
      path: '/srv/app/.env',
      excerpt: 'ANTHROPIC_API_KEY=[secret masqué] (sk-)\nPORT=3000',
      chars: 64,
      truncated: false,
    });
    // La carte `files` : le secret masqué DANS le chemin, l'action et les
    // comptes inchangés.
    const ecrite = parCall.get('c_write');
    expect(ecrite?.kind === 'tool' && ecrite.presented).toEqual({
      card: 'files',
      files: [
        { path: '/srv/app/sauvegarde-[secret masqué] (sk-).env', action: 'written', bytes: 64 },
      ],
      total: 1,
      truncated: false,
    });
    // Et la vue brute, masquée elle aussi — les deux disent la même chose.
    expect(lue?.kind === 'tool' && lue.outputText).toBe('ANTHROPIC_API_KEY=[secret masqué] (sk-)');
    // Nulle part dans ce que l'écran reçoit.
    expect(JSON.stringify(r.data.feed)).not.toContain(secret);

    // La ligne sans charge utile vit toujours, sa carte reste absente.
    const nue = parCall.get('c_nu');
    expect(nue?.kind === 'tool' && nue.presented).toBeNull();
    expect(nue?.kind === 'tool' && nue.outputText).toBe('vide');
  });

  it('18/09 : un run qui a PRODUIT porte son récapitulatif de livraison, compté sur ses lignes', async () => {
    // La page d'un run montre « Delivered » en haut ; ce bloc est posé par la
    // MÊME fonction que le fil d'une conversation (`afterJobItems`), sur les
    // lignes d'audit du travail et de ses délégués, plus sa preuve. On écrit
    // donc de vraies lignes et on lit les COMPTES rendus, pas des appels.
    const [j] = await testDb
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        task: 'Écris le digest de la semaine',
        status: 'completed',
        result: 'Digest écrit.',
        completedAt: new Date(),
        messages: [
          { role: 'user', content: 'Écris le digest de la semaine' },
          { role: 'assistant', content: 'Digest écrit.' },
        ],
      })
      .returning();
    const runId = j!.id;
    // Un délégué qui écrit un SECOND fichier : ses lignes comptent dans le
    // récapitulatif de la racine, et sa preuve verte aussi (T24).
    const [delegate] = await testDb
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: 'écris l’annexe',
        status: 'completed',
        parentJobId: runId,
      })
      .returning();
    await testDb.insert(toolCalls).values([
      {
        entityId: seed.entityId,
        jobId: runId,
        toolName: 'file_write',
        toolInput: { path: 'digest.md', content: 'une ligne\ndeux lignes\n' },
        toolOutput: JSON.stringify({ ok: true }),
        durationMs: 20,
        turn: 1,
        toolCallId: 'c_w1',
        card: 'files',
        presented: {
          card: 'files',
          files: [{ path: 'digest.md', action: 'written', bytes: 22 }],
          total: 1,
          truncated: false,
        },
      },
      {
        entityId: seed.entityId,
        jobId: delegate!.id,
        toolName: 'file_write',
        toolInput: { path: 'annexe.md', content: 'annexe\n' },
        toolOutput: JSON.stringify({ ok: true }),
        durationMs: 15,
        turn: 1,
        toolCallId: 'c_w2',
        card: 'files',
        presented: {
          card: 'files',
          files: [{ path: 'annexe.md', action: 'written', bytes: 7 }],
          total: 1,
          truncated: false,
        },
      },
      // Un fichier seulement LU ne se livre pas : il ne doit pas compter.
      {
        entityId: seed.entityId,
        jobId: runId,
        toolName: 'file_list',
        toolInput: { path: '.' },
        toolOutput: JSON.stringify({ ok: true }),
        durationMs: 4,
        turn: 1,
        toolCallId: 'c_l1',
        card: 'files',
        presented: {
          card: 'files',
          files: [{ path: 'brouillon.md', action: 'listed' }],
          total: 1,
          truncated: false,
        },
      },
    ]);
    await testDb.insert(verificationRuns).values({
      jobId: delegate!.id,
      entityId: seed.entityId,
      deliverableType: 'office_file',
      canonicalKey: 'digest.md',
      sequenceId: '55555555-5555-4555-8555-555555555555',
      commandRank: 1,
      command: 'pnpm lint:md',
      exitCode: 0,
      outcomeKind: 'exit',
      durationMs: 300,
      verdict: 'green',
    });

    const { getSpaceConversationAction } = await actions();
    const r = await getSpaceConversationAction(runId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const produced = r.data.feed.items.find((i) => i.kind === 'produced');
    expect(produced, 'le fil du run porte son récapitulatif de livraison').toBeDefined();
    if (produced?.kind !== 'produced') return;
    expect(produced.jobId).toBe(runId);
    // Deux fichiers écrits, celui de la racine et celui du délégué ; le
    // fichier seulement listé n'en est pas un.
    expect(produced.summary.filePaths).toEqual(['digest.md', 'annexe.md']);
    expect(produced.summary.files).toBe(2);
    // La preuve du délégué remonte : une commande, verte.
    expect(produced.summary.tests).toEqual({ passed: 1, total: 1 });
    expect(produced.summary.verdict).toBe('green');
    expect(produced.summary.checks).toEqual([{ command: 'pnpm lint:md', ok: true }]);
    // Le délégué paraît comme relecteur du travail, avec ce qu'il a rendu.
    expect(produced.summary.reviews.map((x) => x.ok)).toEqual([true]);
  });

  it('18/09 : le verdict rendu par un DÉLÉGUÉ remonte au run, comme sur le détail Code', async () => {
    // Le même travail — une demande de relecture déléguée à un relecteur — se
    // lisait de deux façons : ouvert depuis Code il montrait le verdict, ouvert
    // depuis son dossier il disait « aucune relecture ». Les deux chargeurs
    // lisent maintenant les mêmes lignes.
    const [j] = await testDb
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'Peer review de la PR #185 de ce dépôt',
        status: 'completed',
        result: 'Relecture rendue.',
        completedAt: new Date(),
        messages: [{ role: 'user', content: 'Peer review de la PR #185 de ce dépôt' }],
      })
      .returning();
    const [reviewer] = await testDb
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: 'relis la PR',
        status: 'completed',
        parentJobId: j!.id,
      })
      .returning();
    await testDb.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId: reviewer!.id,
      toolName: 'review_verdict',
      toolInput: {},
      toolOutput: JSON.stringify({
        verdict: 'request_changes',
        summary: 'Two majors closed, one minor left.',
        findings: [{ file: 'apps/web/src/lib/actions.ts', line: 13398, severity: 'major' }],
      }),
      durationMs: 5,
      turn: 1,
      toolCallId: 'c_rv',
      card: null,
      presented: null,
    });

    const { getSpaceConversationAction } = await actions();
    const r = await getSpaceConversationAction(j!.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.verdicts).toHaveLength(1);
    expect(r.data.verdicts[0]).toMatchObject({
      jobId: reviewer!.id,
      verdict: 'request_changes',
      summary: 'Two majors closed, one minor left.',
    });
    expect(r.data.verdicts[0]?.findings[0]?.line).toBe(13398);
  });

  it('un travail SANS relecture n’en invente pas', async () => {
    const { getSpaceConversationAction } = await actions();
    const sans = await getSpaceConversationAction(jobId);
    expect(sans.ok).toBe(true);
    if (!sans.ok) return;
    expect(sans.data.verdicts).toEqual([]);
  });

  it("P3 : la preuve d'un délégué remonte à la racine, et la file d'envoi se lit telle quelle", async () => {
    const { getSpaceConversationAction } = await actions();
    const r = await getSpaceConversationAction(jobId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Deux séquences : celle de l'enfant (rouge) ET celle du petit-enfant (verte).
    expect(r.data.verification.sequences).toHaveLength(2);
    const s0 = r.data.verification.sequences.find((x) => x.jobId === childId)!;
    expect(s0.verdict).toBe('red');
    const s1 = r.data.verification.sequences.find((x) => x.jobId !== childId)!;
    expect(s1.verdict).toBe('green');
    expect(s1.runs.map((x) => x.command)).toEqual(['pnpm lint']);
    expect(s0.runs.map((x) => [x.commandRank, x.command, x.verdict])).toEqual([
      [1, 'pnpm typecheck', 'green'],
      [2, 'pnpm test', 'red'],
    ]);
    expect(r.data.verification.unconfigured).toEqual([]);
    expect(r.data.deliveries).toHaveLength(1);
    expect(r.data.deliveries[0]).toMatchObject({
      channel: 'telegram',
      chatId: '4242',
      outcome: 'attempted',
      attempts: 2,
    });
  });

  it("ne lit pas le job d'une autre entité, ni un id qui n'est pas un uuid", async () => {
    const { getSpaceConversationAction } = await actions();
    const foreign = await getSpaceConversationAction(foreignJobId);
    expect(foreign.ok).toBe(false);
    expect(!foreign.ok && foreign.code).toBe('not_found');
    const bad = await getSpaceConversationAction('pas-un-uuid');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.code).toBe('validation_failed');
  });
});
