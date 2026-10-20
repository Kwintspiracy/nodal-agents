// cli-turn-handles.test.ts — ce qu'une CLI (Claude Code, Codex) reçoit à lire
// nomme une conversation par son HANDLE, jamais par l'identifiant du canal
// (#824, passe 1 de la revue).
//
// Une CLI ne lit que deux textes du runner : son message (la tâche) et son
// prompt système (où vit la mémoire). Les deux passent par `cliTurnForModel`
// (provider.ts), la frontière du runtime CLI, aux deux seuls points qui
// lancent un tour (run-job.ts, run-chat.ts). Le binding est injecté (aucun
// CLI réel), comme dans inbox-after-cli-turn.test.ts ; le prompt système est
// le VRAI (`buildSystemPrompt`), mémoire comprise.
//
// Mutation vérifiée : `cliTurnForModel` qui rend `opts` sans relecture → les
// deux cas rougissent ; le wrap retiré d'un des deux points de lancement →
// « every launch » rougit.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentJobs,
  agentMemory,
  channelAllowedConversations,
  conversationHandleFor,
  eq,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { CliTurnOptions, CliTurnResult } from '../../cli-runtime/provider.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';

const fakeRun = vi.fn<(opts: CliTurnOptions) => Promise<CliTurnResult>>();

vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    resolveRuntime: (runtime: string) =>
      runtime === 'claude-code' || runtime === 'codex'
        ? {
            provider: runtime === 'codex' ? 'codex' : 'claude',
            run: (opts: CliTurnOptions) => fakeRun(opts),
            toolLabel: `cli:${runtime}`,
          }
        : null,
  };
});

import { runCliRuntimeJob } from '../../cli-runtime/run-job.ts';
import type { CliRuntimeAgentRow } from '../../cli-runtime/run-job.ts';

const WA = '33612000824@s.whatsapp.net';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };
let baseAgent: CliRuntimeAgentRow;
let workspace: string;

function finished(text: string): CliTurnResult {
  return {
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
  } as unknown as CliTurnResult;
}

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  workspace = await mkdtemp(join(tmpdir(), 'nodal-cli-handles-'));
  seed = await seedMinimal(db);
  const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
  if (!row) throw new Error('seed agent missing');
  baseAgent = {
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
    runtime: 'claude-code',
    cliPermissions: { mode: 'read' },
    cliDefaults: null,
  };
  await db.insert(channelAllowedConversations).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'whatsapp',
    conversationId: WA,
    kind: 'private',
    role: 'member',
    status: 'active',
    requesterName: 'Marie',
  });
  await db.insert(agentMemory).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    fact: `Marie se joint sur WhatsApp au ${WA}`,
    source: 'agent',
    importance: 5,
    archived: false,
  });
});

describe('a CLI turn reads conversations by their handle (#824) @cap:parler-par-canal-externe/moteur', () => {
  it.each(['claude-code', 'codex'] as const)(
    '%s: the task and the system prompt (its memory) carry the handle, never the WhatsApp id',
    async (runtime) => {
      await db.update(agents).set({ runtime }).where(eq(agents.id, seed.agentId));
      const task = `Écris à ${WA} que c'est prêt`;
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'api',
          task,
          status: 'processing',
        })
        .returning({ id: agentJobs.id });

      fakeRun.mockReset();
      fakeRun.mockResolvedValueOnce(finished('done'));
      const outcome = await runCliRuntimeJob({
        db: db as unknown as Parameters<typeof runCliRuntimeJob>[0]['db'],
        jobId: job!.id,
        job: {
          entityId: seed.entityId,
          chatId: null,
          channel: 'api',
          conversationId: null,
          task,
          triggerContext: null,
        },
        agentRow: { ...baseAgent, runtime },
        workspaces: [{ label: 'ws0', path: workspace }],
        claimGeneration: 0,
      });
      expect(outcome.status).toBe('completed');

      const handle = await conversationHandleFor(db as unknown as AnyDrizzleDb, {
        entityId: seed.entityId,
        channel: 'whatsapp',
        conversationId: WA,
      });
      const opts = fakeRun.mock.calls[0]![0];
      expect(opts.message).toBe(`Écris à ${handle} que c'est prêt`);
      expect(opts.personality, 'the memory is in the prompt').toContain(
        `Marie se joint sur WhatsApp au ${handle}`,
      );
      expect(JSON.stringify([opts.message, opts.personality])).not.toContain(WA);
    },
    30_000,
  );

  it('a job with no workspace of its own (an internal /api/agent caller): its agent gives it one', async () => {
    await db.update(agents).set({ runtime: 'claude-code' }).where(eq(agents.id, seed.agentId));
    const task = `Préviens ${WA}`;
    const [job] = await db
      .insert(agentJobs)
      .values({ entityId: null, agentId: seed.agentId, channel: 'api', task, status: 'processing' })
      .returning({ id: agentJobs.id });
    fakeRun.mockReset();
    fakeRun.mockResolvedValueOnce(finished('done'));
    await runCliRuntimeJob({
      db: db as unknown as Parameters<typeof runCliRuntimeJob>[0]['db'],
      jobId: job!.id,
      job: {
        entityId: null,
        chatId: null,
        channel: 'api',
        conversationId: null,
        task,
        triggerContext: null,
      },
      agentRow: baseAgent,
      workspaces: [{ label: 'ws0', path: workspace }],
      claimGeneration: 0,
    });
    const handle = await conversationHandleFor(db as unknown as AnyDrizzleDb, {
      entityId: seed.entityId,
      channel: 'whatsapp',
      conversationId: WA,
    });
    expect(fakeRun.mock.calls[0]![0].message).toBe(`Préviens ${handle}`);
  }, 30_000);

  it('every launch of a CLI turn goes through the boundary — the job path AND the chat path', () => {
    for (const file of ['run-job.ts', 'run-chat.ts']) {
      const src = readFileSync(join(__dirname, '..', '..', 'cli-runtime', file), 'utf8');
      const launches = src.match(/binding\.run\(/g) ?? [];
      const wrapped = src.match(/binding\.run\(\s*await cliTurnForModel\(/g) ?? [];
      expect({ file, launches: launches.length, wrapped: wrapped.length }).toEqual({
        file,
        launches: 1,
        wrapped: 1,
      });
    }
  });
});
