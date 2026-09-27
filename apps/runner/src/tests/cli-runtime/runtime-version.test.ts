// runtime-version.test.ts — a CLI-runtime agent is told which Nodal-Agents
// version it runs, like any other agent (#454, Codex review P2).
//
// The CLI paths built their prompt context without `deployment`, so the whole
// `## Runtime` block was left out: an agent on the claude-code or codex runtime
// asked about "the 0.9.2" had nothing to tie it to. Asserted on the REAL
// system prompt the CLI turn receives, on both entry points (job and chat).

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentJobs,
  agentWorkspaces,
  conversations,
  workspaceLocks,
  eq,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { CliTurnResult } from '../../cli-runtime/provider.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';

const fakeRun = vi.fn<(opts: { personality: string }) => Promise<CliTurnResult>>();

vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    resolveRuntime: (runtime: string) =>
      runtime === 'fake-cli'
        ? {
            provider: 'claude',
            run: (opts: { personality: string }) => fakeRun(opts),
            toolLabel: 'cli:fake',
          }
        : null,
  };
});

import { runCliRuntimeJob } from '../../cli-runtime/run-job.ts';
import type { CliRuntimeAgentRow } from '../../cli-runtime/run-job.ts';
import { runCliRuntimeChatTurn } from '../../cli-runtime/run-chat.ts';

const turn = {
  sessionId: 'sess-v',
  finalText: 'ok',
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

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let agentRow: CliRuntimeAgentRow;
let root: string;
let ws: string;
const previous = process.env['NODAL_VERSION'];

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  await db.update(agents).set({ runtime: 'claude-code' }).where(eq(agents.id, seed.agentId));
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
  fakeRun.mockResolvedValue(turn);
  root = await mkdtemp(join(tmpdir(), 'nodal-454-'));
  ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  await db.delete(workspaceLocks);
  await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, seed.agentId));
  await db
    .insert(agentWorkspaces)
    .values({ agentId: seed.agentId, entityId: seed.entityId, label: 'ws', path: ws });
});

afterEach(async () => {
  if (previous === undefined) delete process.env['NODAL_VERSION'];
  else process.env['NODAL_VERSION'] = previous;
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

describe('a CLI-runtime agent knows which Nodal-Agents version it runs (#454)', () => {
  for (const version of ['0.9.4', '3.1.0-rc.1']) {
    it(`job path: the prompt the CLI receives states version ${version}`, async () => {
      process.env['NODAL_VERSION'] = version;
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'api',
          task: 'changelog de ma version ?',
          status: 'processing',
        })
        .returning({ id: agentJobs.id });
      await runCliRuntimeJob({
        db: db as unknown as AnyDrizzleDb,
        jobId: job!.id,
        job: {
          entityId: seed.entityId,
          chatId: null,
          channel: 'api',
          conversationId: null,
          task: 'changelog de ma version ?',
          triggerContext: null,
        },
        agentRow,
        workspaces: [{ label: 'ws', path: ws }],
      });
      expect(fakeRun).toHaveBeenCalled();
      expect(fakeRun.mock.calls[0]![0].personality).toContain(
        `You run Nodal-Agents version ${version}`,
      );
    });
  }

  it('chat path: the prompt the CLI receives states the version', async () => {
    process.env['NODAL_VERSION'] = '0.9.4';
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId })
      .returning({ id: conversations.id });
    const res = await runCliRuntimeChatTurn({
      db: db as unknown as AnyDrizzleDb,
      entityId: seed.entityId,
      agentRow,
      conversationId: conv!.id,
      message: 'quelle version ?',
    });
    expect(res.ok).toBe(true);
    expect(fakeRun.mock.calls[0]![0].personality).toContain('You run Nodal-Agents version 0.9.4');
  });
});
