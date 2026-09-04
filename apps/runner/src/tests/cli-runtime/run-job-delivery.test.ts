// run-job-delivery.test.ts — la bascule du runtime CLI sur la porte terminale
// et l'outbox (plan « Vérifier & Corriger », T11).
//
// Ce que ces tests prouvent, en lignes RÉELLES de `job_deliveries` et en
// messages réellement reçus par un adaptateur simulé :
//
//   - le résultat part SANS attendre le tick (drain immédiat après commit) ;
//   - une course perdue (job fini par un autre chemin pendant le tour) ne
//     livre RIEN — l'ancien code envoyait quand même ;
//   - un chat hors allowlist finit `rejected`, le job `completed` ;
//   - un crash entre le commit et le drain laisse une ligne `prepared` que
//     le drain suivant livre UNE fois ;
//   - sans chatId, aucune ligne d'outbox.
//
// Le binding CLI et l'adaptateur de canal sont injectés : aucun processus,
// aucun réseau.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentJobs,
  codeProjects,
  jobDeliverableVerificationState,
  jobDeliveries,
  telegramAllowedChats,
  workspaceLocks,
  and,
  eq,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { CliTurnResult } from '../../cli-runtime/provider.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';
import type * as OrchestrationModule from '@nodal-agents/orchestration';
import type * as DeliveryModule from '@nodal-agents/delivery';
import type * as OutboxModule from '../../delivery/outbox.ts';

const fakeRun = vi.fn<(opts: unknown) => Promise<CliTurnResult>>();
const sendText =
  vi.fn<
    (creds: Record<string, string>, chatId: string, text: string) => Promise<{ messageId: string }>
  >();
/** Le drain, remplaçable par test — par défaut le vrai. */
type DrainFn = typeof OutboxModule.drainDeliveries;
const drainImpl =
  vi.fn<(db: AnyDrizzleDb, opts: Parameters<DrainFn>[1], real: DrainFn) => ReturnType<DrainFn>>();

vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    resolveRuntime: (runtime: string) =>
      runtime === 'fake-cli'
        ? { provider: 'claude', run: (opts: unknown) => fakeRun(opts), toolLabel: 'cli:fake' }
        : null,
  };
});

vi.mock('@nodal-agents/orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationModule>();
  return { ...actual, buildSystemPrompt: async () => 'system prompt (test)' };
});

// Le registre d'adaptateurs : un seul faux adaptateur, quel que soit le canal.
// Le reste du paquet (canaux actifs, transport) reste réel.
vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof DeliveryModule>();
  return {
    ...actual,
    getAdapter: () => ({
      sendText: (creds: Record<string, string>, chatId: string, text: string) =>
        sendText(creds, chatId, text),
    }),
  };
});

vi.mock('../../delivery/outbox.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof OutboxModule>();
  return {
    ...actual,
    drainDeliveries: (db: AnyDrizzleDb, opts: Parameters<typeof actual.drainDeliveries>[1]) =>
      drainImpl(db, opts, actual.drainDeliveries),
  };
});

import { runCliRuntimeJob } from '../../cli-runtime/run-job.ts';
import type { CliRuntimeAgentRow } from '../../cli-runtime/run-job.ts';
import { drainDeliveries as realDrain } from '../../delivery/outbox.ts';

const BOT_TOKEN = 'test-telegram-token';
const CHAT = 'chat-t11';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let ws: string;
let agentRow: CliRuntimeAgentRow;

const greenTurn = (text = 'voilà le résultat'): CliTurnResult =>
  ({
    sessionId: 'sess-fake',
    finalText: text,
    isError: false,
    errorDetail: null,
    usage: null,
    modelUsage: null,
    costUsd: null,
    numTurns: 1,
    durationMs: 5,
    exitCode: 0,
    timedOut: false,
    rateLimit: null,
    permissionDenials: 0,
    unknownEventTypes: [],
  }) as unknown as CliTurnResult;

beforeAll(async () => {
  const spun = await spinUpTestDb();
  db = spun.db;
  seed = await seedMinimal(db);
  await db.update(agents).set({ telegramBotToken: BOT_TOKEN }).where(eq(agents.id, seed.agentId));
  const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
  if (!row) throw new Error('seed agent missing');
  agentRow = {
    id: row.id as CliRuntimeAgentRow['id'],
    name: row.name,
    slug: row.slug,
    role: 'agent',
    personality: row.personality ?? '',
    entityId: seed.entityId as CliRuntimeAgentRow['entityId'],
    model: 'test-model',
    active: true,
    orchestratorMode: null,
    memoryTokenBudget: 4000,
    runtime: 'fake-cli',
    cliPermissions: { mode: 'read' },
    cliDefaults: null,
  };
});

beforeEach(async () => {
  fakeRun.mockReset();
  sendText.mockReset();
  sendText.mockResolvedValue({ messageId: '42' });
  drainImpl.mockReset();
  drainImpl.mockImplementation((d, opts, real) => real(d, opts));
  root = await mkdtemp(join(tmpdir(), 'nodal-t11-'));
  ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, 'package.json'), '{}');
  await db.delete(workspaceLocks);
  await db.delete(jobDeliveries);
  await db.delete(jobDeliverableVerificationState);
  await db.delete(codeProjects);
  await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
});

afterEach(async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

async function allowChat(chatId: string): Promise<void> {
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId,
    role: 'member',
    status: 'active',
  });
}

async function newJob(chatId: string | null, status = 'processing'): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId,
      task: 'fais quelque chose',
      status,
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function runJob(jobId: string, chatId: string | null, mode: 'read' | 'write' = 'read') {
  return runCliRuntimeJob({
    db: db as unknown as AnyDrizzleDb,
    jobId,
    job: {
      entityId: seed.entityId,
      chatId,
      channel: 'telegram',
      conversationId: null,
      task: 'go',
      triggerContext: null,
    },
    agentRow: { ...agentRow, cliPermissions: { mode } },
    workspaces: [{ label: 'ws', path: ws }],
  });
}

const deliveriesOf = (jobId: string) =>
  db
    .select({
      outcome: jobDeliveries.outcome,
      receipt: jobDeliveries.receipt,
      attempts: jobDeliveries.attempts,
      payload: jobDeliveries.payload,
      chatId: jobDeliveries.chatId,
      channel: jobDeliveries.channel,
    })
    .from(jobDeliveries)
    .where(eq(jobDeliveries.jobId, jobId));

const jobRow = async (jobId: string) => {
  const [row] = await db
    .select({
      status: agentJobs.status,
      completedAt: agentJobs.completedAt,
      result: agentJobs.result,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('job not found');
  return row;
};

describe('run-job : porte terminale + outbox', () => {
  it('livré sans attendre le tick : prepared commis avec le statut, puis confirmed par le drain immédiat', async () => {
    await allowChat(CHAT);
    const jobId = await newJob(CHAT);
    fakeRun.mockResolvedValueOnce(greenTurn('le texte final'));

    const t0 = Date.now();
    const outcome = await runJob(jobId, CHAT);
    const elapsed = Date.now() - t0;

    expect(outcome).toEqual({ status: 'completed', result: 'le texte final' });
    expect(elapsed).toBeLessThan(2000);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[1]).toBe(CHAT);
    expect(sendText.mock.calls[0]?.[2]).toBe('le texte final');

    const rows = await deliveriesOf(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'confirmed',
      receipt: { messageId: '42' },
      attempts: 1,
      payload: 'le texte final',
      chatId: CHAT,
      channel: 'telegram',
    });
    const job = await jobRow(jobId);
    expect(job.status).toBe('completed');
    expect(job.completedAt).not.toBeNull();
    expect(job.result).toBe('le texte final');
  });

  it('course perdue : le job est fini par un autre chemin PENDANT le tour ⇒ rien ne part, rien n’est écrit', async () => {
    await allowChat(CHAT);
    const jobId = await newJob(CHAT);
    fakeRun.mockImplementationOnce(async () => {
      // Un autre chemin (annulation, reaper) termine le job pendant que la CLI tourne.
      await db.update(agentJobs).set({ status: 'failed' }).where(eq(agentJobs.id, jobId));
      return greenTurn('trop tard');
    });

    const outcome = await runJob(jobId, CHAT);

    expect(outcome).toEqual({ status: 'failed', error: 'already_handled' });
    expect(sendText).not.toHaveBeenCalled();
    expect(await deliveriesOf(jobId)).toEqual([]);
    expect((await jobRow(jobId)).status).toBe('failed');
  });

  it('refus allowlist ⇒ ligne rejected, job completed, aucun envoi', async () => {
    const jobId = await newJob(CHAT); // pas d'allowlist pour CHAT
    fakeRun.mockResolvedValueOnce(greenTurn());

    const outcome = await runJob(jobId, CHAT);

    expect(outcome.status).toBe('completed');
    expect(sendText).not.toHaveBeenCalled();
    const rows = await deliveriesOf(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('rejected');
    expect(rows[0]?.receipt).toMatchObject({ messageId: null, reason: 'allowlist_refused' });
    expect((await jobRow(jobId)).status).toBe('completed');
  });

  it('crash entre le commit et le drain ⇒ la ligne prepared survit, le drain suivant livre UNE fois', async () => {
    await allowChat(CHAT);
    const jobId = await newJob(CHAT);
    fakeRun.mockResolvedValueOnce(greenTurn('à relivrer'));
    drainImpl.mockImplementationOnce(() => {
      throw new Error('processus mort avant le drain');
    });

    const outcome = await runJob(jobId, CHAT);

    // Le job est commis ; la livraison attend.
    expect(outcome.status).toBe('completed');
    expect((await jobRow(jobId)).status).toBe('completed');
    expect(sendText).not.toHaveBeenCalled();
    const before = await deliveriesOf(jobId);
    expect(before).toHaveLength(1);
    expect(before[0]?.outcome).toBe('prepared');

    // Le tick suivant.
    const drained = await realDrain(db as unknown as AnyDrizzleDb, {});
    expect(drained.sent).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[2]).toBe('à relivrer');
    const after = await deliveriesOf(jobId);
    expect(after).toHaveLength(1);
    expect(after[0]?.outcome).toBe('confirmed');
    expect(after[0]?.attempts).toBe(1);
  });

  it('sans chatId ⇒ zéro ligne job_deliveries, job completed', async () => {
    const jobId = await newJob(null);
    fakeRun.mockResolvedValueOnce(greenTurn());

    const outcome = await runJob(jobId, null);

    expect(outcome.status).toBe('completed');
    expect(await deliveriesOf(jobId)).toEqual([]);
    expect(sendText).not.toHaveBeenCalled();
    expect(
      await db
        .select({ id: jobDeliveries.id })
        .from(jobDeliveries)
        .where(and(eq(jobDeliveries.jobId, jobId), eq(jobDeliveries.chatId, ''))),
    ).toEqual([]);
  });
});
