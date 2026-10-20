// cli-session-resume-boundary.test.ts — une session de CLI ouverte AVANT la
// frontière des handles n'est jamais reprise (#824, décision du propriétaire,
// option B de #828).
//
// Une CLI rejoue elle-même la transcription d'une session reprise : le runner
// ne la voit pas, et une session ancienne peut porter des identifiants de
// conversation bruts. Une session sans la marque `opened_with_handles` repart
// donc à neuf, UNE fois, et la session ouverte est enregistrée marquée ; une
// session marquée est reprise comme avant. Les deux points de lancement (job,
// chat), les deux CLI.
//
// Mutation vérifiée : le filtre `openedWithHandles` retiré de
// `findResumableCliSession` → les cas « sans marque » rougissent (la CLI est
// relancée sur l'ancienne session).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, cliSessions, conversations, and, eq } from '@nodal-agents/db';
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
import { runCliRuntimeChatTurn } from '../../cli-runtime/run-chat.ts';
import type { CliRuntimeAgentRow } from '../../cli-runtime/run-job.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };
let baseAgent: CliRuntimeAgentRow;
let workspace: string;

function finished(text: string, sessionId: string): CliTurnResult {
  return {
    sessionId,
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
  workspace = await mkdtemp(join(tmpdir(), 'nodal-cli-resume-'));
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
});

type Runtime = 'claude-code' | 'codex';
const providerOf = (r: Runtime) => (r === 'codex' ? 'codex' : 'claude');

async function storeSession(
  conversationKey: string,
  runtime: Runtime,
  sessionId: string,
  marked: boolean,
) {
  await db.insert(cliSessions).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    conversationKey,
    provider: providerOf(runtime),
    sessionId,
    openedWithHandles: marked,
  });
}

async function storedSession(conversationKey: string) {
  const [row] = await db
    .select({ sessionId: cliSessions.sessionId, marked: cliSessions.openedWithHandles })
    .from(cliSessions)
    .where(
      and(eq(cliSessions.agentId, seed.agentId), eq(cliSessions.conversationKey, conversationKey)),
    );
  return row;
}

async function newConversation(): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: seed.agentId, origin: 'user' })
    .returning({ id: conversations.id });
  return conv!.id;
}

async function runJobTurn(runtime: Runtime, conversationId: string) {
  await db.update(agents).set({ runtime }).where(eq(agents.id, seed.agentId));
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      conversationId,
      task: 'continue',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  const outcome = await runCliRuntimeJob({
    db: db as unknown as Parameters<typeof runCliRuntimeJob>[0]['db'],
    jobId: job!.id,
    job: {
      entityId: seed.entityId,
      chatId: null,
      channel: 'api',
      conversationId,
      task: 'continue',
      triggerContext: null,
    },
    agentRow: { ...baseAgent, runtime },
    workspaces: [{ label: 'ws0', path: workspace }],
    claimGeneration: 0,
  });
  expect(outcome.status).toBe('completed');
}

async function runChatTurn(runtime: Runtime, conversationId: string) {
  await db.update(agents).set({ runtime }).where(eq(agents.id, seed.agentId));
  const result = await runCliRuntimeChatTurn({
    db: db as unknown as Parameters<typeof runCliRuntimeChatTurn>[0]['db'],
    entityId: seed.entityId,
    agentRow: { ...baseAgent, runtime },
    conversationId,
    message: 'continue',
  });
  expect(result.ok).toBe(true);
}

const PATHS = [
  ['job', runJobTurn],
  ['chat', runChatTurn],
] as const;

describe('a CLI session opened before the handle boundary is never resumed (#824) @cap:reprendre-conversation/moteur', () => {
  for (const [path, run] of PATHS) {
    it.each(['claude-code', 'codex'] as const)(
      `${path} path, %s: an UNMARKED session starts fresh, and the new session is stored marked`,
      async (runtime) => {
        const conversationId = await newConversation();
        await storeSession(conversationId, runtime, 'pre-boundary-session', false);
        fakeRun.mockReset();
        fakeRun.mockResolvedValueOnce(finished('fresh', 'fresh-session'));

        await run(runtime, conversationId);

        expect(fakeRun.mock.calls[0]![0].resumeSessionId).toBeUndefined();
        expect(await storedSession(conversationId)).toEqual({
          sessionId: 'fresh-session',
          marked: true,
        });

        // From then on, it resumes normally.
        fakeRun.mockResolvedValueOnce(finished('again', 'fresh-session'));
        await run(runtime, conversationId);
        expect(fakeRun.mock.calls[1]![0].resumeSessionId).toBe('fresh-session');
      },
      30_000,
    );

    it.each(['claude-code', 'codex'] as const)(
      `${path} path, %s: a MARKED session is resumed as before`,
      async (runtime) => {
        const conversationId = await newConversation();
        await storeSession(conversationId, runtime, 'marked-session', true);
        fakeRun.mockReset();
        fakeRun.mockResolvedValueOnce(finished('resumed', 'marked-session'));

        await run(runtime, conversationId);

        expect(fakeRun.mock.calls[0]![0].resumeSessionId).toBe('marked-session');
        expect(await storedSession(conversationId)).toEqual({
          sessionId: 'marked-session',
          marked: true,
        });
      },
      30_000,
    );
  }
});
