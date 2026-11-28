// cli-run-limits.test.ts — une session Claude Code ou Codex a les limites du run,
// comptées dans l'unité que leur nom dit, et un arrêt livre ce qu'elle a écrit
// (#1177).
//
// Ce qui était faux : le plafond d'appels d'UNE réponse du modèle (invariant #8)
// était compté sur toute la session, qui est toute la boucle d'une demande, et
// la session était tuée à 15 minutes quel que soit le réglage de l'espace. Tuée
// ou en échec, elle ne livrait rien : ni son dernier texte, ni la limite atteinte.
//
// Tout est réel sauf le binaire : un vrai processus (une fausse CLI qui imprime
// un flux enregistré dans la forme de chaque CLI), la vraie mécanique
// `spawnCliTurn`, les vrais lecteurs de flux Claude et Codex, le vrai
// `runCliRuntimeJob`, une vraie base. Les assertions portent sur la ligne du job
// et sur ce que son résultat livre.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, entities, toolCalls, eq } from '@nodal-agents/db';
import { CLI_SESSION_HOURS_WITHOUT_TIME_LIMIT } from '@nodal-agents/shared';
import type { CliTurnOptions, CliTurnResult } from '../../cli-runtime/provider.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';
import type * as OrchestrationModule from '@nodal-agents/orchestration';
import { spawnCliTurn } from '../../cli-runtime/spawn-turn.ts';
import { countToolUses, finishTurn, newStreamParseState } from '../../cli-runtime/claude-turn.ts';
import {
  finishCodexTurn,
  handleCodexLine,
  newCodexParseState,
} from '../../cli-runtime/codex-turn.ts';

/** Le script de la fausse CLI du cas en cours. */
let script = '';
/** Les limites de temps que chaque tour a reçues. */
const timeoutsSeen: number[] = [];

/** `runClaudeTurn` sans la résolution du binaire : la fausse CLI à sa place. */
async function fakeClaudeTurn(opts: CliTurnOptions): Promise<CliTurnResult> {
  timeoutsSeen.push(opts.timeoutMs);
  const state = newStreamParseState();
  return spawnCliTurn<CliTurnResult>({
    argv: [process.execPath, script],
    env: process.env,
    cwd: opts.cwd,
    stdin: opts.message,
    timeoutMs: opts.timeoutMs,
    processScope: opts.processScope,
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.maxToolCalls !== undefined ? { maxToolCalls: opts.maxToolCalls } : {}),
    onLine: (line, gate) => {
      countToolUses(state, line, opts.onEvent, gate);
    },
    finish: (o) =>
      finishTurn(
        state,
        o.exitCode,
        o.timedOut,
        o.durationMs,
        o.stderr,
        o.toolCapExceeded,
        o.toolCapCalls,
      ),
  });
}

/** `runCodexTurn` sans la résolution du binaire. */
async function fakeCodexTurn(opts: CliTurnOptions): Promise<CliTurnResult> {
  timeoutsSeen.push(opts.timeoutMs);
  const state = newCodexParseState();
  return spawnCliTurn<CliTurnResult>({
    argv: [process.execPath, script],
    env: process.env,
    cwd: opts.cwd,
    stdin: opts.message,
    timeoutMs: opts.timeoutMs,
    processScope: opts.processScope,
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.maxToolCalls !== undefined ? { maxToolCalls: opts.maxToolCalls } : {}),
    onLine: (line, gate) => {
      handleCodexLine(state, line, opts.onEvent, gate);
    },
    finish: (o) =>
      finishCodexTurn(
        state,
        o.exitCode,
        o.timedOut,
        o.durationMs,
        o.stderr,
        o.toolCapExceeded,
        o.toolCapCalls,
      ),
  });
}

vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    resolveRuntime: (runtime: string) =>
      runtime === 'fake-claude'
        ? { provider: 'claude', run: fakeClaudeTurn, toolLabel: 'cli:fake-claude' }
        : runtime === 'fake-codex'
          ? { provider: 'codex', run: fakeCodexTurn, toolLabel: 'cli:fake-codex' }
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
/** L'ancienne constante de l'adaptateur : 15 minutes, quel que soit le réglage. */
const OLD_CONSTANT_MS = 900_000;

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let baseRow: CliRuntimeAgentRow;
let dir = '';

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
  baseRow = {
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
    runtime: 'fake-claude',
    cliPermissions: { mode: 'read' },
    cliDefaults: null,
  };
});

afterEach(async () => {
  timeoutsSeen.length = 0;
  await db.update(entities).set({ maxRunHours: 0 }).where(eq(entities.id, seed.entityId));
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  dir = '';
});

/**
 * La fausse CLI : elle imprime `lines`, puis attend `holdMs` (une session qui
 * travaille encore) et sort avec `exitCode`.
 */
async function writeFakeCli(lines: string[], holdMs = 0, exitCode = 0): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'nodal-cli-limits-'));
  script = join(dir, 'fake-cli.cjs');
  await writeFile(
    script,
    [
      `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')});`,
      `setTimeout(() => process.exit(${String(exitCode)}), ${String(holdMs)});`,
    ].join('\n'),
  );
}

async function runJob(runtime: string) {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'build it',
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
      task: 'build it',
      triggerContext: null,
    },
    agentRow: { ...baseRow, runtime },
    workspaces: [{ label: 'ws', path: dir }],
    // Une ligne insérée `processing` porte la prise 0 : ce run la tient.
    claimGeneration: 0,
  });
  const [row] = await db
    .select({ status: agentJobs.status, error: agentJobs.error, result: agentJobs.result })
    .from(agentJobs)
    .where(eq(agentJobs.id, job!.id));
  return { outcome, row: row!, jobId: job!.id };
}

/** Les lignes d'audit du job (écrites sans être attendues en mode lecture : on les attend ici). */
async function toolCallRowsOf(jobId: string, expected: number): Promise<number> {
  let n = 0;
  await vi.waitFor(
    async () => {
      const rows = await db
        .select({ id: toolCalls.toolCallId })
        .from(toolCalls)
        .where(eq(toolCalls.jobId, jobId));
      n = rows.length;
      expect(n).toBe(expected);
    },
    { timeout: 5_000 },
  );
  return n;
}

async function setRunHours(hours: number): Promise<void> {
  await db.update(entities).set({ maxRunHours: hours }).where(eq(entities.id, seed.entityId));
}

// ── Les flux, dans la forme de chaque CLI ───────────────────────────────────

interface Stream {
  /** Une session qui écrit du texte, puis `calls` appels répartis sur `responses` réponses, puis finit. */
  work(calls: number, responses: number, finalText: string): string[];
  /** Le début d'une session qui écrit `text` et n'émet pas sa fin. */
  started(text: string): string[];
}

const claude: Stream = {
  work(calls, responses, finalText) {
    const per = Math.ceil(calls / responses);
    const lines = [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-c' })];
    for (let i = 0; i < calls; i += 1) {
      const id = `toolu_${String(i)}`;
      const msg = `msg_${String(Math.floor(i / per))}`;
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: { id: msg, content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
        }),
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
        }),
      );
    }
    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_last', content: [{ type: 'text', text: finalText }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: finalText,
        session_id: 'sess-c',
      }),
    );
    return lines;
  },
  started(text) {
    return [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-c' }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_0', content: [{ type: 'text', text }] },
      }),
    ];
  },
};

const codex: Stream = {
  // `codex exec --json` ne nomme aucune réponse : `responses` n'a pas de forme
  // dans son flux, les appels se suivent.
  work(calls, _responses, finalText) {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-x' }),
      JSON.stringify({ type: 'turn.started' }),
    ];
    for (let i = 0; i < calls; i += 1) {
      const id = `item_${String(i)}`;
      lines.push(
        JSON.stringify({
          type: 'item.started',
          item: { id, type: 'command_execution', command: 'ls', status: 'in_progress' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id,
            type: 'command_execution',
            command: 'ls',
            aggregated_output: 'ok',
            exit_code: 0,
            status: 'completed',
          },
        }),
      );
    }
    lines.push(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_msg', type: 'agent_message', text: finalText },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
    );
    return lines;
  },
  started(text) {
    return [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-x' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text },
      }),
    ];
  },
};

const RUNTIMES = [
  { name: 'Claude Code', runtime: 'fake-claude', stream: claude },
  { name: 'Codex', runtime: 'fake-codex', stream: codex },
] as const;

describe.each(RUNTIMES)(
  'une session $name a les limites du run @cap:suivre-execution/moteur',
  ({ runtime, stream }) => {
    it('120 appels d outils sur dix réponses : la session finit, sa réponse est le résultat', async () => {
      await writeFakeCli(stream.work(120, 10, 'All 120 steps done.'));
      const { outcome, row, jobId } = await runJob(runtime);

      expect(outcome).toEqual({ status: 'completed', result: 'All 120 steps done.' });
      expect(row.status).toBe('completed');
      expect(row.result).toBe('All 120 steps done.');
      // Chaque appel a sa ligne d'audit : aucun n'a été coupé.
      expect(await toolCallRowsOf(jobId, 120)).toBe(120);
    }, 30_000);

    it('la limite de temps est celle du réglage de l espace, au-delà de l ancienne constante', async () => {
      await setRunHours(1.5);
      await writeFakeCli(stream.work(3, 3, 'Done.'));
      const { row } = await runJob(runtime);

      expect(row.status).toBe('completed');
      expect(timeoutsSeen).toEqual([1.5 * 3_600_000]);
      expect(timeoutsSeen[0]).toBeGreaterThan(OLD_CONSTANT_MS);
    }, 30_000);

    it('sans limite de temps dans l espace, la session reçoit la borne dite sous le réglage', async () => {
      await setRunHours(0);
      await writeFakeCli(stream.work(1, 1, 'Done.'));
      await runJob(runtime);

      expect(timeoutsSeen).toEqual([CLI_SESSION_HOURS_WITHOUT_TIME_LIMIT * 3_600_000]);
    }, 30_000);

    it('une limite de temps plus basse arrête la session, qui livre son dernier texte et la limite', async () => {
      // 0,0005 h = 1,8 s ; la session travaille encore 20 s.
      await setRunHours(0.0005);
      await writeFakeCli(stream.started('Step 1 of 3 is written in src/a.ts.'), 20_000);
      const { outcome, row } = await runJob(runtime);

      expect(outcome).toEqual({ status: 'failed', error: 'run_time_exceeded' });
      expect(row.status).toBe('failed');
      expect(row.error).toBe('run_time_exceeded');
      expect(row.result).toMatch(
        /^Step 1 of 3 is written in src\/a\.ts\.\n\n\[stopped: run budget — 0 h 01 min of work, ceiling 0 h 00 min, turn 1\]$/,
      );
    }, 30_000);

    it('une session qui sort en erreur livre son dernier texte et la cause', async () => {
      await writeFakeCli(stream.started('I could not finish: the build is red.'), 0, 1);
      const { outcome, row } = await runJob(runtime);

      expect(outcome.status).toBe('failed');
      expect(row.status).toBe('failed');
      expect(row.error).toMatch(/^cli_runtime_error: cli_stream_incomplete/);
      expect(row.result).toBe(
        'I could not finish: the build is red.\n\n[stopped: CLI session error — cli_runtime_error]',
      );
    }, 30_000);
  },
);

describe('le plafond d appels d UNE réponse du modèle, sur la session Claude Code @cap:suivre-execution/moteur', () => {
  it('une réponse qui ouvre plus d appels que le plafond est arrêtée, le plafond nommé, le texte d avant livré', async () => {
    const lines = [
      ...claude.started('Reading the project first.'),
      // La réponse suivante ouvre 51 appels : le 51e la fait tuer.
      ...Array.from({ length: BUDGET + 1 }, (_, i) =>
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_runaway',
            content: [{ type: 'tool_use', id: `toolu_r${String(i)}`, name: 'Read', input: {} }],
          },
        }),
      ),
    ];
    await writeFakeCli(lines, 20_000);
    const { outcome, row } = await runJob('fake-claude');

    expect(outcome).toEqual({ status: 'failed', error: 'tool_call_limit_exceeded' });
    expect(row.error).toBe('tool_call_limit_exceeded');
    expect(row.result).toBe(
      'Reading the project first.\n\n' +
        `[stopped: tool call limit — ${String(BUDGET + 1)} tool calls in one model response, ` +
        `ceiling ${String(BUDGET)}, turn 1]`,
    );
  }, 30_000);
});
