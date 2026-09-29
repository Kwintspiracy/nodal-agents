// conversation-runs.test.ts — voir et arrêter, depuis un message, ce qu'un
// message PRÉCÉDENT de la même conversation a lancé (#567).
//
// Le scénario de l'incident du 28/09, sur deux canaux : un message lance un run
// qui délègue à ComfyArtist ; le délégué attend une approbation et une réponse
// à sa question ; un message POSTÉRIEUR (un job de tête neuf) demande l'arrêt.
// Avant, ce job neuf n'avait que `list_tasks` — son propre tableau, vide — et
// répondait « rien ne tourne ». Ici on vérifie les lignes en base, pas des
// comptes d'appels : le délégué est `cancelled`, ses demandes `expired`, et
// rien d'une autre conversation n'a bougé.

import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agentTasks, agents, approvalRequests, eq, inArray } from '@nodal-agents/db';
import { listConversationRunsTool, stopConversationRunTool } from '../builtin/conversation-runs';
import type { ToolContext } from '../types';

let db: TestDb;
let entityId: string;
let rootAgentId: string;
let artistAgentId: string;
let artistSlug: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  const seed = await seedMinimal(db);
  entityId = seed.entityId;
  rootAgentId = seed.agentId;
  artistSlug = `comfy-artist-${Date.now()}`;
  const [artist] = await db
    .insert(agents)
    .values({ entityId, name: 'ComfyArtist', slug: artistSlug, personality: 'Draws.' })
    .returning({ id: agents.id });
  artistAgentId = artist!.id;
});

type Channel = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'dashboard';

// Chaque job naît une seconde après le précédent : l'ordre des runs listés est
// celui des messages, jamais un départage au hasard des identifiants.
let clock = Date.parse('2026-09-28T03:00:00Z');

async function insertJob(values: {
  channel: Channel | 'task-board' | 'cron';
  conversationId: string | null;
  status: string;
  task: string;
  parentJobId?: string;
  agentId?: string;
}): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId: values.agentId ?? rootAgentId,
      channel: values.channel,
      task: values.task,
      status: values.status,
      conversationId: values.conversationId ?? undefined,
      parentJobId: values.parentJobId,
      createdAt: new Date((clock += 1000)),
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

/**
 * Une conversation sur `channel` au moment du second « arrête » de l'incident :
 *  - message 1 → `head1`, en attente de son délégué `child1` (ComfyArtist), qui
 *    attend une approbation ET une réponse à sa question ; une tâche du tableau
 *    de `head1` n'a pas encore tourné ;
 *  - message 0 → `zombieHead`, déclaré mort par le faucheur, dont le délégué
 *    `zombieChild` tourne encore ;
 *  - message 2 → `caller`, le job neuf qui reçoit « arrête ».
 */
async function seedConversation(channel: Channel) {
  const conversationId = randomUUID();
  const zombieHead = await insertJob({
    channel,
    conversationId,
    status: 'failed',
    task: 'Je relance la recherche',
  });
  const zombieChild = await insertJob({
    channel,
    conversationId,
    status: 'processing',
    task: 'research, again',
    parentJobId: zombieHead,
    agentId: artistAgentId,
  });
  const head1 = await insertJob({
    channel,
    conversationId,
    status: 'awaiting_delegation',
    task: 'Fais-moi un portrait',
  });
  const child1 = await insertJob({
    channel,
    conversationId,
    status: 'awaiting_approval',
    task: 'Generate the portrait with ComfyUI',
    parentJobId: head1,
    agentId: artistAgentId,
  });
  const [approval] = await db
    .insert(approvalRequests)
    .values({
      entityId,
      jobId: child1,
      agentId: artistAgentId,
      toolName: 'run_command',
      toolInput: { command: 'python main.py' },
      kind: 'approval',
    })
    .returning({ id: approvalRequests.id });
  const [question] = await db
    .insert(approvalRequests)
    .values({
      entityId,
      jobId: child1,
      agentId: artistAgentId,
      toolName: 'ask_user',
      toolInput: { question: 'Which style?', options: ['oil', 'ink'] },
      kind: 'question',
    })
    .returning({ id: approvalRequests.id });
  const [task] = await db
    .insert(agentTasks)
    .values({
      entityId,
      orchestratorId: rootAgentId,
      title: 'Upscale the portrait',
      status: 'todo',
      assignedAgentId: artistAgentId,
      rootJobId: head1,
    })
    .returning({ id: agentTasks.id });
  const caller = await insertJob({
    channel,
    conversationId,
    status: 'processing',
    task: 'Arrête !!!',
  });
  return {
    conversationId,
    zombieHead,
    zombieChild,
    head1,
    child1,
    approvalId: approval!.id,
    questionId: question!.id,
    taskId: task!.id,
    caller,
  };
}

function ctxFor(jobId: string): ToolContext {
  return {
    jobId,
    agentId: rootAgentId,
    entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

async function statusOf(ids: string[]): Promise<Record<string, string | null>> {
  const rows = await db
    .select({ id: agentJobs.id, status: agentJobs.status })
    .from(agentJobs)
    .where(inArray(agentJobs.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

async function requestState(id: string) {
  const [row] = await db
    .select({ status: approvalRequests.status, resolvedBy: approvalRequests.resolvedBy })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id));
  return row;
}

describe('a later message sees and stops the runs of its conversation @cap:parler-par-canal-externe/moteur', () => {
  it.each(['telegram', 'discord'] as const)(
    '%s: the whole tree is listed, the caller’s own run and other conversations are not',
    async (channel) => {
      const conv = await seedConversation(channel);
      const other = await seedConversation(channel === 'telegram' ? 'slack' : 'whatsapp');

      const out = await listConversationRunsTool.execute({}, ctxFor(conv.caller));

      expect(out.runs.map((r) => r.run_id)).toEqual([conv.zombieHead, conv.head1]);
      const [zombie, run1] = out.runs;
      // Tête morte, délégué vivant : le run est vivant, et il est listé.
      expect(zombie).toMatchObject({
        head_status: 'failed',
        live_jobs: [{ job_id: conv.zombieChild, agent: artistSlug, delegated: true }],
      });
      expect(run1!.live_jobs.map((j) => [j.job_id, j.status])).toEqual([
        [conv.head1, 'awaiting_delegation'],
        [conv.child1, 'awaiting_approval'],
      ]);
      expect(run1!.open_tasks).toEqual([
        {
          task_id: conv.taskId,
          title: 'Upscale the portrait',
          status: 'todo',
          assigned_to: artistSlug,
        },
      ]);
      expect(
        run1!.pending_requests.map((p) => ({ id: p.request_id, kind: p.kind, job: p.job_id })),
      ).toEqual([
        { id: conv.approvalId, kind: 'approval', job: conv.child1 },
        { id: conv.questionId, kind: 'question', job: conv.child1 },
      ]);
      const listed = JSON.stringify(out);
      expect(listed).not.toContain(conv.caller);
      for (const id of [other.head1, other.child1, other.zombieHead, other.zombieChild]) {
        expect(listed).not.toContain(id);
      }
    },
  );

  it.each(['telegram', 'discord'] as const)(
    '%s: stopping one run cancels its delegate and closes its approval and question, nothing else',
    async (channel) => {
      const conv = await seedConversation(channel);
      const other = await seedConversation('slack');

      const out = await stopConversationRunTool.execute(
        { run_id: conv.head1 },
        ctxFor(conv.caller),
      );

      expect(out.stopped).toEqual([
        {
          run_id: conv.head1,
          cancelled_job_ids: expect.arrayContaining([conv.head1, conv.child1]) as string[],
          cancelled_task_ids: [conv.taskId],
          closed_request_ids: expect.arrayContaining([
            conv.approvalId,
            conv.questionId,
          ]) as string[],
        },
      ]);
      expect(await statusOf([conv.head1, conv.child1])).toEqual({
        [conv.head1]: 'cancelled',
        [conv.child1]: 'cancelled',
      });
      expect(await requestState(conv.approvalId)).toEqual({
        status: 'expired',
        resolvedBy: 'system:job_cancelled',
      });
      expect(await requestState(conv.questionId)).toEqual({
        status: 'expired',
        resolvedBy: 'system:job_cancelled',
      });
      const [task] = await db
        .select({ status: agentTasks.status })
        .from(agentTasks)
        .where(eq(agentTasks.id, conv.taskId));
      expect(task?.status).toBe('cancelled');

      // Le reste n'a pas bougé : l'autre run de la conversation, l'appelant,
      // et l'autre conversation.
      expect(await statusOf([conv.zombieChild, conv.caller, other.head1, other.child1])).toEqual({
        [conv.zombieChild]: 'processing',
        [conv.caller]: 'processing',
        [other.head1]: 'awaiting_delegation',
        [other.child1]: 'awaiting_approval',
      });
      expect((await requestState(other.approvalId))?.status).toBe('pending');
    },
  );

  it('with no run_id, every run of the conversation stops — the zombie delegate too — and a later list is empty', async () => {
    const conv = await seedConversation('telegram');
    const other = await seedConversation('discord');

    const out = await stopConversationRunTool.execute({}, ctxFor(conv.caller));

    expect(out.stopped.map((s) => s.run_id)).toEqual([conv.zombieHead, conv.head1]);
    expect(out.stopped[0]!.cancelled_job_ids).toEqual([conv.zombieChild]);
    expect(
      await statusOf([conv.zombieHead, conv.zombieChild, conv.head1, conv.child1, conv.caller]),
    ).toEqual({
      // La tête terminée garde son statut : seul ce qui vivait est annulé.
      [conv.zombieHead]: 'failed',
      [conv.zombieChild]: 'cancelled',
      [conv.head1]: 'cancelled',
      [conv.child1]: 'cancelled',
      [conv.caller]: 'processing',
    });
    expect(await statusOf([other.zombieChild, other.child1])).toEqual({
      [other.zombieChild]: 'processing',
      [other.child1]: 'awaiting_approval',
    });

    // Le tour « arrête » se termine ; un troisième message demande ce qui
    // tourne encore. Le périmètre entier est lu, donc « rien » est vrai.
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, conv.caller));
    const third = await insertJob({
      channel: 'telegram',
      conversationId: conv.conversationId,
      status: 'processing',
      task: 'Tout est arrêté ?',
    });
    expect((await listConversationRunsTool.execute({}, ctxFor(third))).runs).toEqual([]);
  });

  it.each(['claude-code', 'codex'] as const)(
    'the stop result says how EACH cancelled job stops, by its runtime: nodal head, %s delegate',
    async (cliRuntime) => {
      const [cliAgent] = await db
        .insert(agents)
        .values({
          entityId,
          name: `Coder ${cliRuntime}`,
          slug: `coder-${cliRuntime}-${Date.now()}`,
          personality: 'Codes.',
          runtime: cliRuntime,
        })
        .returning({ id: agents.id });
      const conversationId = randomUUID();
      const head = await insertJob({
        channel: 'telegram',
        conversationId,
        status: 'awaiting_delegation',
        task: 'Répare le build',
      });
      const delegate = await insertJob({
        channel: 'telegram',
        conversationId,
        status: 'processing',
        task: 'Fix the failing test',
        parentJobId: head,
        agentId: cliAgent!.id,
      });
      const caller = await insertJob({
        channel: 'telegram',
        conversationId,
        status: 'processing',
        task: 'Arrête',
      });

      const out = await stopConversationRunTool.execute({ run_id: head }, ctxFor(caller));

      const cliName = cliRuntime === 'codex' ? 'Codex' : 'Claude Code';
      const byJob = [...out.how_each_job_stops].sort((a, b) =>
        a.job_id === head ? -1 : b.job_id === head ? 1 : 0,
      );
      expect(byJob).toEqual([
        {
          job_id: head,
          runtime: 'nodal',
          how:
            'Stops before its next model call; a model call in progress is interrupted within ' +
            'seconds. Tool calls of the step already under way may still complete.',
        },
        {
          job_id: delegate,
          runtime: cliRuntime,
          how:
            `Its ${cliName} process is killed within seconds, wherever it is in its work; a ` +
            'turn not yet started never starts.',
        },
      ]);
      // Rien dans la réponse ne promet qu'un appel en cours « finit d'abord » à
      // un job dont le processus est tué.
      expect(JSON.stringify(out)).not.toMatch(/finishes first/);
    },
  );

  it('a run of ANOTHER conversation is refused, and left running', async () => {
    const conv = await seedConversation('telegram');
    const other = await seedConversation('discord');

    await expect(
      stopConversationRunTool.execute({ run_id: other.head1 }, ctxFor(conv.caller)),
    ).rejects.toThrow(/is not a run of this conversation/);
    // Un délégué n'est pas un run : on arrête un run par sa tête.
    await expect(
      stopConversationRunTool.execute({ run_id: conv.child1 }, ctxFor(conv.caller)),
    ).rejects.toThrow(/is not a run of this conversation/);
    expect(await statusOf([other.head1, other.child1])).toEqual({
      [other.head1]: 'awaiting_delegation',
      [other.child1]: 'awaiting_approval',
    });
  });

  it('the caller’s own run is never stopped by the tool', async () => {
    const conv = await seedConversation('telegram');
    await expect(
      stopConversationRunTool.execute({ run_id: conv.caller }, ctxFor(conv.caller)),
    ).rejects.toThrow(/your own current run/);
    expect(await statusOf([conv.caller])).toEqual({ [conv.caller]: 'processing' });
  });

  it('a job that is no turn of a conversation says it has no scope, instead of an empty list', async () => {
    const cronJob = await insertJob({
      channel: 'cron',
      conversationId: null,
      status: 'processing',
      task: 'nightly digest',
    });
    await expect(listConversationRunsTool.execute({}, ctxFor(cronJob))).rejects.toThrow(
      /not a turn of a conversation/,
    );
  });
});
