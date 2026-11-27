// cli-result-boundary.test.ts — what a CLI runtime reports back to Nodal goes through the same boundary.
//
// A Claude Code or Codex agent reads files with the CLI's own tools: what they
// read reaches the CLI's provider without passing through any Nodal code, and
// Nodal cannot mask that. What Nodal records of each call (`tool_calls` rows
// `cli:*`) goes through the tool-result boundary of every other tool: the
// workspace's exact values, then the shapes by the agent's setting. Real
// recorder (`runCliRuntimeJob`), real database, a fake CLI binary that prints
// a stream-json packet.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, connectors, toolCalls, eq } from '@nodal-agents/db';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { REDACTED_TEXT } from '@nodal-agents/shared';
import { fakeAlnum, fakeSecret } from '@nodal-agents/test-kit';
import type { CliTurnOptions, CliTurnResult } from '../../cli-runtime/provider.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';
import type * as OrchestrationModule from '@nodal-agents/orchestration';
import { spawnCliTurn } from '../../cli-runtime/spawn-turn.ts';
import { countToolUses, finishTurn, newStreamParseState } from '../../cli-runtime/claude-turn.ts';

let packetScript = '';

/** `runClaudeTurn` sans la résolution du binaire : la fausse CLI à sa place. */
async function fakeClaudeTurn(opts: CliTurnOptions): Promise<CliTurnResult> {
  const state = newStreamParseState();
  return spawnCliTurn<CliTurnResult>({
    argv: [process.execPath, packetScript],
    env: process.env,
    cwd: opts.cwd,
    stdin: opts.message,
    timeoutMs: opts.timeoutMs,
    processScope: opts.processScope,
    ...(opts.maxToolCalls !== undefined ? { maxToolCalls: opts.maxToolCalls } : {}),
    onLine: (line, gate) => {
      countToolUses(state, line, opts.onEvent, gate);
    },
    finish: ({ exitCode, timedOut, durationMs, stderr, toolCapExceeded }) =>
      finishTurn(state, exitCode, timedOut, durationMs, stderr, toolCapExceeded),
  }) as Promise<CliTurnResult>;
}

vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    resolveRuntime: (runtime: string) =>
      runtime === 'fake-cli'
        ? { provider: 'claude', run: fakeClaudeTurn, toolLabel: 'cli:fake' }
        : null,
  };
});

vi.mock('@nodal-agents/orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationModule>();
  return { ...actual, buildSystemPrompt: async () => 'system prompt (test)' };
});

import { runCliRuntimeJob } from '../../cli-runtime/run-job.ts';
import type { CliRuntimeAgentRow } from '../../cli-runtime/run-job.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let agentRow: CliRuntimeAgentRow;
let dir = '';
let registered = '';
let shaped = '';

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  registered = randomBytes(20).toString('hex');
  shaped = fakeSecret('github', fakeAlnum(36));
  await db
    .insert(connectors)
    .values({ entityId: seed.entityId, name: 'Acme', slug: 'acme', apiKey: encrypt(registered) });
  const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
  agentRow = {
    id: row!.id as CliRuntimeAgentRow['id'],
    name: row!.name,
    slug: row!.slug,
    role: 'agent',
    personality: row!.personality ?? '',
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

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** One CLI turn that reads a file holding both values; the row Nodal records of it. */
async function recordedRead(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'nodal-cli-boundary-'));
  const content = `ACME_KEY=${registered}\nGH_TOKEN=${shaped}\nPORT=8080\n`;
  const packet = [
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'settings.env' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }],
      },
    }),
    JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 's' }),
  ];
  packetScript = join(dir, 'fake-claude.cjs');
  await writeFile(
    packetScript,
    `process.stdout.write(${JSON.stringify(packet.join('\n') + '\n')});\n`,
  );
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'go',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  await runCliRuntimeJob({
    db: db as unknown as Parameters<typeof runCliRuntimeJob>[0]['db'],
    jobId: job!.id,
    job: {
      entityId: seed.entityId,
      chatId: null,
      channel: 'api',
      conversationId: null,
      task: 'go',
      triggerContext: null,
    },
    agentRow,
    workspaces: [{ label: 'ws', path: dir }],
    claimGeneration: 0,
  });
  const rows = await db
    .select({ name: toolCalls.toolName, output: toolCalls.toolOutput })
    .from(toolCalls)
    .where(eq(toolCalls.jobId, job!.id));
  const read = rows.find((r) => r.name === 'cli:Read');
  if (!read) throw new Error(`no cli:Read row: ${JSON.stringify(rows.map((r) => r.name))}`);
  return read.output ?? '';
}

describe('a CLI runtime’s recorded results go through the tool-result boundary @cap:suivre-execution/moteur', () => {
  it('the recorded output holds neither the workspace’s value nor the shaped one', async () => {
    const out = await recordedRead();
    expect(out).toContain('PORT=8080');
    expect(out).toContain(REDACTED_TEXT);
    expect(out).not.toContain(registered);
    expect(out).not.toContain(shaped);
  }, 30_000);

  it('the agent’s switch off: the shape is recorded, the workspace’s value is not', async () => {
    await db.update(agents).set({ maskSecretShapes: false }).where(eq(agents.id, seed.agentId));
    try {
      const out = await recordedRead();
      expect(out).toContain(shaped);
      expect(out).not.toContain(registered);
    } finally {
      await db.update(agents).set({ maskSecretShapes: true }).where(eq(agents.id, seed.agentId));
    }
  }, 30_000);
});
