// elicitation.test.ts — la QUESTION qu'un serveur MCP pose pendant un de ses
// appels (élicitation, 0145), côté runner, sur de VRAIES lignes en base.
//
// La règle que tout ce fichier tient : une élicitation n'est PAS une
// approbation. Elle ne suspend pas le job, ne le relance pas, n'est jamais
// relue comme un appel à exécuter, et sa réponse est un formulaire validé.
//
// Ce qui est relu : la ligne `approval_requests` (statut, `response`,
// `resolved_by`, `executed_at`), ses images, la ligne du job, et ce que la
// capacité rend AU SERVEUR (`accept` + contenu, `decline`, `cancel`).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq } from '@nodal-agents/db';
import { approvalRequests, approvalRequestAttachments, agentJobs } from '@nodal-agents/db';
import type { UserInputRequest } from '@nodal-agents/tools';
import { resolveApprovalDecision } from '../../approvals/resolve.ts';
import { createRequestUserInput, expireOrphanedElicitations } from '../../approvals/elicitation.ts';
import { expireStaleApprovals } from '../../cron/reset-orphans.ts';
import { reviveJobIfApprovalResolvedDuringSuspend } from '../../job/execute.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

let db: TestDb;
let seed: { entityId: string; agentId: string; jobId: string };

const testEnv = {
  NODALAI_APPROVAL_GRACE_MS: 0,
} as unknown as RunnerEnv;

function makeDeps(): RunnerDeps {
  return {
    db: db as unknown as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: {} as RunnerDeps['embeddingClient'],
    registry: {} as RunnerDeps['registry'],
    authProvider: {} as RunnerDeps['authProvider'],
    close: async () => {},
  };
}

const ORDER_FORM = {
  type: 'object',
  properties: {
    color: { type: 'string', title: 'Color', enum: ['color', 'grayscale'] },
    copies: { type: 'integer', title: 'Copies', minimum: 1, maximum: 5 },
    duplex: { type: 'boolean', title: 'Two-sided' },
  },
  required: ['color', 'copies'],
};

// 1×1 PNG.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function request(over: Partial<UserInputRequest> = {}): UserInputRequest {
  return {
    serverSlug: 'printer',
    toolName: 'printer__request_print',
    toolCallId: 'call-print-1',
    message: 'How should "report.pdf" be printed?',
    requestedSchema: ORDER_FORM,
    attachments: [],
    actions: { accept: null, decline: null },
    signal: new AbortController().signal,
    ...over,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** La ligne d'élicitation EN ATTENTE de ce job, dès qu'elle existe. */
async function pendingElicitation(): Promise<typeof approvalRequests.$inferSelect> {
  for (let i = 0; i < 200; i++) {
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.jobId, seed.jobId),
          eq(approvalRequests.kind, 'elicitation'),
          eq(approvalRequests.status, 'pending'),
        ),
      );
    if (row) return row;
    await sleep(10);
  }
  throw new Error('no pending elicitation appeared');
}

async function readRow(id: string) {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  return row!;
}

async function jobStatus(): Promise<string | null> {
  const [row] = await db
    .select({ status: agentJobs.status })
    .from(agentJobs)
    .where(eq(agentJobs.id, seed.jobId));
  return row?.status ?? null;
}

function ask(opts: { isLost?: () => Promise<boolean>; timeoutMs?: number } = {}) {
  return createRequestUserInput(
    makeDeps(),
    { jobId: seed.jobId, agentId: seed.agentId, entityId: seed.entityId },
    {
      isLost: opts.isLost ?? (async () => false),
      timeoutMs: opts.timeoutMs ?? 60_000,
      pollMs: 10,
    },
  );
}

/** Une ligne d'élicitation posée à la main, pour les lecteurs. */
async function insertElicitation(over: Partial<typeof approvalRequests.$inferInsert> = {}) {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      agentId: seed.agentId,
      toolName: 'printer__request_print',
      toolInput: { server: 'printer', message: 'How?', requestedSchema: ORDER_FORM },
      toolCallId: 'call-print-1',
      kind: 'elicitation',
      status: 'pending',
      executedAt: new Date(),
      ...over,
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const minimal = await seedMinimal(db);
  seed = { entityId: minimal.entityId, agentId: minimal.agentId, jobId: minimal.jobId };
});

beforeEach(async () => {
  await db.delete(approvalRequests).where(eq(approvalRequests.jobId, seed.jobId));
  await db.update(agentJobs).set({ status: 'processing' }).where(eq(agentJobs.id, seed.jobId));
});

describe('la question d’un serveur MCP, posée et attendue sans suspendre @cap:approuver-une-action/moteur', () => {
  it('pose la ligne (kind, outil, appel, formulaire, images) déjà marquée exécutée', async () => {
    const before = Date.now();
    const answer = ask({ timeoutMs: 600_000 })(
      request({
        attachments: [
          { mimeType: 'image/png', data: PNG_1PX, byteSize: 70, caption: 'Page 1 preview' },
        ],
        actions: { accept: 'Print', decline: null },
      }),
    );
    const row = await pendingElicitation();
    expect(row.kind).toBe('elicitation');
    expect(row.toolName).toBe('printer__request_print');
    expect(row.toolCallId).toBe('call-print-1');
    expect(row.toolInput).toEqual({
      server: 'printer',
      message: 'How should "report.pdf" be printed?',
      requestedSchema: ORDER_FORM,
      // Les libellés des boutons, gardés avec la question.
      actions: { accept: 'Print', decline: null },
    });
    // L'appel auquel elle appartient est EN COURS : jamais un appel à rejouer.
    expect(row.executedAt).toBeInstanceOf(Date);
    expect(row.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 600_000 - 1000);
    const images = await db
      .select()
      .from(approvalRequestAttachments)
      .where(eq(approvalRequestAttachments.approvalRequestId, row.id));
    expect(images).toEqual([
      expect.objectContaining({
        position: 0,
        mimeType: 'image/png',
        data: PNG_1PX,
        byteSize: 70,
        caption: 'Page 1 preview',
      }),
    ]);
    // Le job n'est pas suspendu par sa question.
    expect(await jobStatus()).toBe('processing');

    await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: row.id,
      decision: 'reject',
      resolvedBy: 'api',
    });
    await answer;
  });

  it('Envoyer : le serveur reçoit accept et le contenu validé, la ligne le garde', async () => {
    const answer = ask()(request());
    const row = await pendingElicitation();
    const resolved = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: row.id,
      decision: 'approve',
      resolvedBy: 'api',
      content: { color: 'grayscale', copies: 2, duplex: true },
    });
    expect(resolved).toMatchObject({ ok: true, resumed: 'in_process' });
    expect(await answer).toEqual({
      action: 'accept',
      content: { color: 'grayscale', copies: 2, duplex: true },
    });
    const stored = await readRow(row.id);
    expect(stored.status).toBe('approved');
    expect(stored.response).toEqual({ color: 'grayscale', copies: 2, duplex: true });
  });

  it('Refuser : le serveur reçoit decline, sans contenu', async () => {
    const answer = ask()(request());
    const row = await pendingElicitation();
    await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: row.id,
      decision: 'reject',
      resolvedBy: 'api',
    });
    expect(await answer).toEqual({ action: 'decline' });
    const stored = await readRow(row.id);
    expect(stored.status).toBe('rejected');
    expect(stored.response).toBeNull();
  });

  it('personne ne répond à temps : cancel, et la ligne dit pourquoi', async () => {
    const answer = await ask({ timeoutMs: 120 })(request());
    expect(answer).toEqual({ action: 'cancel' });
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, seed.jobId));
    expect(row!.status).toBe('expired');
    expect(row!.resolvedBy).toBe('system:timeout');
  });

  it('le run perd son job (annulé) : cancel, `system:job_cancelled`', async () => {
    let lost = false;
    const answer = ask({ isLost: async () => lost })(request());
    const row = await pendingElicitation();
    lost = true;
    expect(await answer).toEqual({ action: 'cancel' });
    expect((await readRow(row.id)).resolvedBy).toBe('system:job_cancelled');
  });

  it('le serveur retire sa question : cancel, `system:server_cancelled`', async () => {
    const controller = new AbortController();
    const answer = ask()(request({ signal: controller.signal }));
    const row = await pendingElicitation();
    controller.abort();
    expect(await answer).toEqual({ action: 'cancel' });
    const stored = await readRow(row.id);
    expect(stored.status).toBe('expired');
    expect(stored.resolvedBy).toBe('system:server_cancelled');
  });

  it('un formulaire hors du protocole est refusé au serveur, et aucune ligne n’attend', async () => {
    await expect(
      ask()(
        request({
          requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } },
        }),
      ),
    ).rejects.toThrow(/cannot be shown.*nested/);
    const rows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, seed.jobId));
    expect(rows).toEqual([]);
  });
});

describe('resolveApprovalDecision — une élicitation @cap:approuver-une-action/moteur', () => {
  beforeEach(async () => {
    // Le pire cas pour « ne relance rien » : un job suspendu pour une AUTRE
    // raison. Résoudre l'élicitation ne doit pas le faire repartir.
    await db
      .update(agentJobs)
      .set({ status: 'awaiting_approval' })
      .where(eq(agentJobs.id, seed.jobId));
  });

  it('envoyer sans contenu est refusé, la ligne reste ouverte', async () => {
    const row = await insertElicitation();
    const r = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: row.id,
      decision: 'approve',
      resolvedBy: 'api',
    });
    expect(r).toEqual({ ok: false, code: 'content_required' });
    expect((await readRow(row.id)).status).toBe('pending');
  });

  it('un contenu hors du formulaire est refusé, champ par champ', async () => {
    const row = await insertElicitation();
    const r = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: row.id,
      decision: 'approve',
      resolvedBy: 'api',
      content: { color: 'sepia', copies: 9 },
    });
    expect(r).toMatchObject({
      ok: false,
      code: 'content_invalid',
      errors: [
        { field: 'color', reason: 'is not one of the offered choices' },
        { field: 'copies', reason: 'must be at most 5' },
      ],
    });
    const stored = await readRow(row.id);
    expect(stored.status).toBe('pending');
    expect(stored.response).toBeNull();
  });

  it('un contenu valide est gardé, et le job n’est PAS relancé', async () => {
    const row = await insertElicitation();
    const r = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: row.id,
      decision: 'approve',
      resolvedBy: 'api',
      content: { color: 'color', copies: 1 },
    });
    expect(r).toMatchObject({ ok: true, resumed: 'in_process', answer: null });
    expect((await readRow(row.id)).response).toEqual({ color: 'color', copies: 1 });
    expect(await jobStatus()).toBe('awaiting_approval');
  });

  it('une option de question sur une élicitation est refusée', async () => {
    const row = await insertElicitation();
    const r = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: row.id,
      decision: 'approve',
      resolvedBy: 'telegram',
      answer: 'color',
    });
    expect(r).toEqual({ ok: false, code: 'answer_not_expected' });
  });

  it('un contenu sur une approbation ordinaire est refusé, jamais jeté', async () => {
    const [row] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'run_command',
        toolInput: { command: 'ls' },
        kind: 'approval',
        status: 'pending',
      })
      .returning();
    const r = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: row!.id,
      decision: 'approve',
      resolvedBy: 'api',
      content: { color: 'color' },
    });
    expect(r).toEqual({ ok: false, code: 'content_not_expected' });
    expect((await readRow(row!.id)).status).toBe('pending');
  });
});

describe('les lecteurs du runner : une élicitation n’est pas un appel qui attend @cap:approuver-une-action/moteur', () => {
  beforeEach(async () => {
    await db
      .update(agentJobs)
      .set({ status: 'awaiting_approval' })
      .where(eq(agentJobs.id, seed.jobId));
  });

  it('une élicitation tranchée, même sans executed_at, ne réveille pas un job suspendu', async () => {
    // Sans `executed_at` : le filtre sur `kind` doit tenir seul.
    await insertElicitation({ status: 'approved', executedAt: null, response: { copies: 1 } });
    await reviveJobIfApprovalResolvedDuringSuspend(db as unknown as RunnerDeps['db'], seed.jobId);
    expect(await jobStatus()).toBe('awaiting_approval');
  });

  it('le balayage TTL ferme une élicitation échue sans relancer le job', async () => {
    const row = await insertElicitation({ expiresAt: new Date(Date.now() - 60_000) });
    await expireStaleApprovals(db as unknown as RunnerDeps['db']);
    const stored = await readRow(row.id);
    expect(stored.status).toBe('expired');
    expect(stored.resolvedBy).toBe('system:ttl_expired');
    expect(await jobStatus()).toBe('awaiting_approval');
  });

  it('au démarrage, les questions du processus précédent sont fermées, pas les approbations', async () => {
    const orphan = await insertElicitation();
    const [gate] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'run_command',
        toolInput: { command: 'ls' },
        kind: 'approval',
        status: 'pending',
      })
      .returning();
    const closed = await expireOrphanedElicitations(db as unknown as RunnerDeps['db']);
    expect(closed).toBe(1);
    const stored = await readRow(orphan.id);
    expect(stored.status).toBe('expired');
    expect(stored.resolvedBy).toBe('system:runner_restarted');
    expect((await readRow(gate!.id)).status).toBe('pending');
  });
});
