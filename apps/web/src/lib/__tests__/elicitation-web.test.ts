// elicitation-web.test.ts — une ÉLICITATION (un serveur MCP qui pose une
// question pendant un de ses appels, migration 0145) côté web, sur de VRAIES
// lignes en base.
//
// La règle que tout ce fichier tient : une élicitation n'est PAS une
// approbation. Aucun lecteur ne la dit « approuvée », ne lui offre « Toujours
// autoriser », ni ne la réduit à l'appel de l'outil MCP qui l'a posée.
//
// Lecteurs couverts ici (les autres ont leur test près de leur code) :
//   - `resolveApprovalAction` : transporte `content`, le valide avant le runner ;
//   - `listApprovalsAction`   : rend la question lisible (vue + images, sans octets) ;
//   - `listSidebarRecentApprovalsAction` : dit « <serveur> asked », pas l'outil ;
//   - le fil (`getConversationThreadAction` → job-feed → conversation-thread) :
//     la carte en attente est HORS du groupe replié du run ;
//   - la route des images : octets et type pour son entité, 404 pour une autre.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  approvalRequests,
  approvalRequestAttachments,
  chatMessages,
  conversations,
  entities,
  users,
} from '@nodal-agents/db';

process.env['RUNNER_URL'] = 'http://localhost:3001';
process.env['WORKER_SECRET'] = 'test-bearer-elicit';

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
  requireUserWithEntity: async () => ({ userId: seed.userId, entityId: seed.entityId }),
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

/** Le formulaire que le serveur de test demande : un choix, un entier borné, un booléen. */
const SCHEMA = {
  type: 'object',
  properties: {
    paper: { type: 'string', title: 'Paper', enum: ['A4', 'Letter'] },
    copies: { type: 'integer', title: 'Copies', minimum: 1, maximum: 5 },
    print: { type: 'boolean', title: 'Print', default: false },
  },
  required: ['paper', 'copies', 'print'],
};

/** Un PNG d'un pixel : de vrais octets, pour que la route rende une vraie image. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const ids = {
  conv: '',
  job: '',
  pending: '',
  answered: '',
  approval: '',
  foreignPending: '',
};

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);

  const [conv] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Print it',
      origin: 'user',
      channel: 'dashboard',
    })
    .returning({ id: conversations.id });
  ids.conv = conv!.id;

  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      conversationId: ids.conv,
      task: 'Imprime ce document',
      status: 'processing',
      messages: [],
    })
    .returning({ id: agentJobs.id });
  ids.job = job!.id;
  // Le tour du dashboard qui a lancé le travail : la demande, puis l'accusé
  // de l'agent qui porte le job — écrit au LANCEMENT (run-chat-turn.ts), donc
  // présent pendant que le run attend sa réponse.
  await testDb.insert(chatMessages).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: ids.conv,
      role: 'user',
      content: 'Imprime ce document',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: ids.conv,
      role: 'assistant',
      content: 'On it.',
      jobId: ids.job,
    },
  ]);

  const [pending] = await testDb
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: ids.job,
      agentId: seed.agentId,
      toolName: 'printer__request_print',
      toolInput: { server: 'printer', message: 'Print 1 page on A4?', requestedSchema: SCHEMA },
      toolCallId: 'call_print_1',
      kind: 'elicitation',
      status: 'pending',
      executedAt: new Date(),
    })
    .returning({ id: approvalRequests.id });
  ids.pending = pending!.id;
  await testDb.insert(approvalRequestAttachments).values([
    {
      approvalRequestId: ids.pending,
      position: 0,
      mimeType: 'image/png',
      data: PNG_1PX,
      byteSize: 70,
      caption: 'Page 1',
    },
    {
      approvalRequestId: ids.pending,
      position: 1,
      mimeType: 'image/png',
      data: PNG_1PX,
      byteSize: 70,
      caption: null,
    },
  ]);

  const [answered] = await testDb
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: ids.job,
      agentId: seed.agentId,
      toolName: 'printer__request_print',
      toolInput: { server: 'printer', message: 'Which tray?', requestedSchema: SCHEMA },
      toolCallId: 'call_print_0',
      kind: 'elicitation',
      status: 'approved',
      response: { paper: 'A4', copies: 2, print: true },
      // Posée AVANT la question en attente : le fil les range dans cet ordre.
      requestedAt: new Date(Date.now() - 60_000),
      resolvedAt: new Date(),
      resolvedBy: 'api',
      executedAt: new Date(),
    })
    .returning({ id: approvalRequests.id });
  ids.answered = answered!.id;

  const [approval] = await testDb
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: ids.job,
      agentId: seed.agentId,
      toolName: 'run_command',
      toolInput: { command: 'ls', purpose: 'look' },
      toolCallId: 'call_cmd',
      kind: 'approval',
      status: 'pending',
    })
    .returning({ id: approvalRequests.id });
  ids.approval = approval!.id;

  // Une autre entité, avec sa propre question et son image.
  const [user2] = await testDb
    .insert(users)
    .values({ email: `other-${Date.now()}@example.com` })
    .returning();
  const [entity2] = await testDb
    .insert(entities)
    .values({ userId: user2!.id, name: 'Other', slug: `other-${Date.now()}` })
    .returning();
  const [job2] = await testDb
    .insert(agentJobs)
    .values({
      entityId: entity2!.id,
      channel: 'api',
      task: 'x',
      status: 'processing',
      messages: [],
    })
    .returning({ id: agentJobs.id });
  const [foreign] = await testDb
    .insert(approvalRequests)
    .values({
      entityId: entity2!.id,
      jobId: job2!.id,
      toolName: 'printer__request_print',
      toolInput: { server: 'printer', message: 'x', requestedSchema: SCHEMA },
      kind: 'elicitation',
      status: 'pending',
      executedAt: new Date(),
    })
    .returning({ id: approvalRequests.id });
  ids.foreignPending = foreign!.id;
  await testDb.insert(approvalRequestAttachments).values({
    approvalRequestId: ids.foreignPending,
    position: 0,
    mimeType: 'image/png',
    data: PNG_1PX,
    byteSize: 70,
  });
});

function runnerReplies(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('resolveApprovalAction sur une élicitation @cap:approuver-une-action/moteur', () => {
  it('Envoyer transporte le contenu jusqu’au runner, tel que la personne l’a rempli', async () => {
    const fetchSpy = runnerReplies({ ok: true, jobId: ids.job, decision: 'approve', answer: null });
    const { resolveApprovalAction } = await import('../actions.ts');
    const r = await resolveApprovalAction({
      approvalRequestId: ids.pending,
      decision: 'approve',
      content: { paper: 'A4', copies: 3, print: true },
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body).toEqual({
      approvalRequestId: ids.pending,
      decision: 'approve',
      content: { paper: 'A4', copies: 3, print: true },
    });
    fetchSpy.mockRestore();
  });

  it('un entier hors bornes est refusé AVANT le runner, avec le champ et la raison', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { resolveApprovalAction } = await import('../actions.ts');
    const r = await resolveApprovalAction({
      approvalRequestId: ids.pending,
      decision: 'approve',
      content: { paper: 'A4', copies: 9, print: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('content_invalid');
      expect(r.message).toContain('copies: must be at most 5');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('Envoyer sans contenu n’est pas une approbation : refusé, rien ne part', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { resolveApprovalAction } = await import('../actions.ts');
    const r = await resolveApprovalAction({ approvalRequestId: ids.pending, decision: 'approve' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('content_required');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('Refuser part sans contenu', async () => {
    const fetchSpy = runnerReplies({ ok: true, jobId: ids.job, decision: 'reject', answer: null });
    const { resolveApprovalAction } = await import('../actions.ts');
    const r = await resolveApprovalAction({ approvalRequestId: ids.pending, decision: 'reject' });
    expect(r.ok).toBe(true);
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body).toEqual({ approvalRequestId: ids.pending, decision: 'reject' });
    fetchSpy.mockRestore();
  });

  it('un contenu sur une approbation ordinaire est refusé, jamais jeté en silence', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { resolveApprovalAction } = await import('../actions.ts');
    const r = await resolveApprovalAction({
      approvalRequestId: ids.approval,
      decision: 'approve',
      content: { paper: 'A4' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('content_not_expected');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('les erreurs de champ du runner sont rendues lisibles', async () => {
    const fetchSpy = runnerReplies(
      { error: 'content_invalid', errors: [{ field: 'copies', reason: 'must be at most 5' }] },
      400,
    );
    const { resolveApprovalAction } = await import('../actions.ts');
    const r = await resolveApprovalAction({
      approvalRequestId: ids.pending,
      decision: 'approve',
      content: { paper: 'A4', copies: 3, print: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('content_invalid');
      expect(r.message).toContain('copies: must be at most 5');
    }
    fetchSpy.mockRestore();
  });
});

describe('les lecteurs web : une élicitation n’est pas une approbation @cap:approuver-une-action/moteur', () => {
  it('listApprovalsAction rend la question (serveur, message, images SANS octets)', async () => {
    const { listApprovalsAction } = await import('../actions.ts');
    const r = await listApprovalsAction({ status: 'all' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.data.find((a) => a.id === ids.pending)!;
    expect(row.kind).toBe('elicitation');
    expect(row.elicitation).not.toBeNull();
    expect(row.elicitation!.server).toBe('printer');
    expect(row.elicitation!.message).toBe('Print 1 page on A4?');
    expect(row.elicitation!.attachments).toEqual([
      { position: 0, mimeType: 'image/png', caption: 'Page 1' },
      { position: 1, mimeType: 'image/png', caption: null },
    ]);
    // Aucun octet d'image dans ce que la page reçoit.
    expect(JSON.stringify(r.data)).not.toContain(PNG_1PX);
    // La réponse donnée se relit.
    const done = r.data.find((a) => a.id === ids.answered)!;
    expect(done.elicitation!.response).toEqual({ paper: 'A4', copies: 2, print: true });
    // Une approbation ordinaire ne porte pas de vue d'élicitation.
    expect(r.data.find((a) => a.id === ids.approval)!.elicitation).toBeNull();
    // Rien de l'autre entité.
    expect(r.data.some((a) => a.id === ids.foreignPending)).toBe(false);
  });

  it('RECENTS dit « printer asked », jamais l’appel de l’outil MCP', async () => {
    const { listSidebarRecentApprovalsAction } = await import('../sidebar-actions.ts');
    const r = await listSidebarRecentApprovalsAction(10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.data.find((a) => a.id === ids.answered)!;
    expect(row.what).toBe('printer asked: Which tray?');
  });

  it('le fil montre la question en attente HORS du groupe replié du run', async () => {
    const { getConversationThreadAction } = await import('../conversation-actions.ts');
    const r = await getConversationThreadAction(ids.conv);
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (!r.ok) return;
    const top = r.data.feed.items;
    const asked = top.filter((i) => i.kind === 'elicitation');
    // Les deux (en attente ET répondue), au niveau du fil, dans l'ordre demandé.
    expect(
      asked.map((i) => (i.kind === 'elicitation' ? i.elicitation.approvalRequestId : '')),
    ).toEqual([ids.answered, ids.pending]);
    const pendingItem = asked[1]!;
    if (pendingItem.kind !== 'elicitation') throw new Error('unreachable');
    expect(pendingItem.elicitation.status).toBe('pending');
    expect(pendingItem.elicitation.attachments).toHaveLength(2);
    // Aucune élicitation ne se cache dans un groupe `run`.
    for (const item of top) {
      if (item.kind === 'run') {
        expect(item.items.some((i) => i.kind === 'elicitation')).toBe(false);
      }
    }
  });
});

describe('GET /api/approvals/<id>/attachments/<n> @cap:approuver-une-action/moteur', () => {
  it('sert l’image de sa propre entité, avec son type et nosniff', async () => {
    const { GET } = await import('../../app/api/approvals/[id]/attachments/[position]/route.ts');
    const res = await GET(new Request('http://localhost/x'), {
      params: Promise.resolve({ id: ids.pending, position: '0' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.toString('base64')).toBe(PNG_1PX);
  });

  it('404 pour l’image d’une autre entité, comme pour une absente', async () => {
    const { GET } = await import('../../app/api/approvals/[id]/attachments/[position]/route.ts');
    const foreign = await GET(new Request('http://localhost/x'), {
      params: Promise.resolve({ id: ids.foreignPending, position: '0' }),
    });
    expect(foreign.status).toBe(404);
    const missing = await GET(new Request('http://localhost/x'), {
      params: Promise.resolve({ id: ids.pending, position: '7' }),
    });
    expect(missing.status).toBe(404);
  });
});
