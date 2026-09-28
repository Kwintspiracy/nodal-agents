// tool-cap-audit.test.ts — après le cap d'appels d'un runtime CLI, l'appel
// admis qui finit en retard garde sa ligne d'audit (revue Codex de #568,
// passe 3).
//
// Le 50e appel, lent, est ouvert AVANT le cap ; le 51e l'ouvre et le déclenche ;
// le résultat du 50e arrive ensuite, dans le même paquet stdout. L'enregistreur
// de `run-job.ts` n'écrit la ligne `tool_calls` qu'au résultat : jeter tout ce
// qui suit le cap perdait la trace d'un appel qui a pu écrire dans le dossier.
//
// Tout est réel sauf le binaire : un vrai processus (une fausse CLI qui écrit
// un flux stream-json), la vraie mécanique `spawnCliTurn` et sa porte, le vrai
// lecteur Claude, le vrai enregistreur de `runCliRuntimeJob`, une vraie base.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, toolCalls, eq } from '@nodal-agents/db';
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
import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';

const BUDGET = DEFAULT_LIMITS.maxToolCallsPerTurn;

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let agentRow: CliRuntimeAgentRow;
let dir = '';

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
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

const open = (id: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] },
  });
const result = (id: string, content: string) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });

describe('runtime CLI : l appel admis qui finit après le cap garde sa ligne d audit @cap:suivre-execution/moteur', () => {
  it('le 50e appel, ouvert avant le cap et fini après, a sa ligne tool_calls ; le 51e n en a aucune', async () => {
    dir = await mkdtemp(join(tmpdir(), 'nodal-cap-audit-'));
    const ids = Array.from({ length: BUDGET + 1 }, (_, i) => `toolu_${i}`);
    const call50 = ids[BUDGET - 1]!;
    const call51 = ids[BUDGET]!;
    // Les 49 premiers finissent tout de suite ; le 50e est lent ; le 51e ouvre
    // et déclenche le cap ; puis, dans le MÊME paquet, le résultat du 50e.
    const packet = [
      ...ids.slice(0, BUDGET - 1).flatMap((id) => [open(id), result(id, `ok ${id}`)]),
      open(call50),
      open(call51),
      result(call50, 'wrote src/slow.ts'),
      result(call51, 'ran anyway'),
      JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 's' }),
    ];
    packetScript = join(dir, 'fake-claude.cjs');
    await writeFile(
      packetScript,
      [
        `process.stdout.write(${JSON.stringify(packet.join('\n') + '\n')});`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
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

    const outcome = await runCliRuntimeJob({
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
    });

    expect(outcome.status).toBe('failed');
    const rows = await db
      .select({ id: toolCalls.toolCallId, output: toolCalls.toolOutput })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, job!.id));
    const byId = new Map(rows.map((r) => [r.id, r.output]));
    // Les 50 appels admis ont chacun leur ligne, le lent compris.
    expect(rows).toHaveLength(BUDGET);
    expect(byId.get(call50)).toBe('wrote src/slow.ts');
    // Le 51e n'en a aucune.
    expect(byId.has(call51)).toBe(false);
  }, 30_000);
});
