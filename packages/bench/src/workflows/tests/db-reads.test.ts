// db-reads.test.ts — ce que le banc lit dans la base, joué sur un vrai schéma.
//
// Les requêtes du banc sont du SQL brut : les prouver sur des objets en mémoire
// ne dirait rien. Ces cas tournent sur PGlite avec le schéma des tests de
// @nodal-agents/db, et vérifient ce que les lectures RENDENT.
//
// Revue Codex de la PR #634 :
//   - constat 2 : un tour de chat d'un agent sous Claude Code ou Codex n'écrit
//     aucun `llm_calls` ; il laisse un `cli_runs` sans job (et, pendant le tour,
//     des `tool_calls` sans job). Le banc le prenait pour une stack au repos.
//   - constat 4 : un job exécuté par Claude Code ou Codex écrit sa consommation
//     dans `cli_runs`, pas dans `llm_calls` ; l'essai mesurait zéro jeton.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { seedMinimal, spinUpTestDb } from '@nodal-agents/db/test-utils';
import { readTreeFacts } from '../facts';
import { readForeignActivity, readLiveBenchRoots } from '../stack';
import { busyReason, measure } from '../trial';

// Le type vient du helper : @electric-sql/pglite n'est pas une dépendance du banc.
let pg: Awaited<ReturnType<typeof spinUpTestDb>>['pg'];
let db: AnyDrizzleDb;
let entityId: string;
let agentId: string;

beforeAll(async () => {
  const t = await spinUpTestDb();
  pg = t.pg;
  db = t.db as unknown as AnyDrizzleDb;
  const seed = await seedMinimal(t.db);
  entityId = seed.entityId;
  agentId = seed.agentId;
  // Le job semé est `pending` : il compterait comme un job vivant du propriétaire.
  await pg.query(`update agent_jobs set status = 'completed'`);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec('delete from cli_runs; delete from tool_calls; delete from llm_calls;');
});

async function job(opts: { parent?: string; status?: string } = {}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into agent_jobs (entity_id, agent_id, parent_job_id, status, channel, task)
     values ($1, $2, $3, $4, 'mcp', 'x') returning id::text`,
    [entityId, agentId, opts.parent ?? null, opts.status ?? 'completed'],
  );
  return r.rows[0]!.id;
}

const WINDOW = 5 * 60_000;

describe('a chat turn of an agent on a coding CLI counts as the owner working', () => {
  it('nothing recent: the stack is free', async () => {
    const a = await readForeignActivity(db, WINDOW);
    expect(a.lastChatMs).toBeNull();
    expect(busyReason(a, Date.now(), WINDOW)).toBeNull();
  });

  it('a finished CLI chat turn (a cli_runs row with no job) 30 s ago makes the stack busy', async () => {
    await pg.query(
      `insert into cli_runs (entity_id, agent_id, job_id, provider, mode, source, input_tokens, created_at)
       values ($1, $2, null, 'claude', 'read', 'subscription', 12, now() - interval '30 seconds')`,
      [entityId, agentId],
    );
    const a = await readForeignActivity(db, WINDOW);
    expect(a.lastChatMs).not.toBeNull();
    const ago = Date.now() - a.lastChatMs!;
    expect(ago).toBeGreaterThanOrEqual(29_000);
    expect(ago).toBeLessThan(60_000);
    expect(busyReason(a, Date.now(), WINDOW)).toMatch(/^a chat turn ran \d+ s ago$/);
  });

  it('a CLI chat turn still running (its live tool_calls rows, no job) makes the stack busy', async () => {
    await pg.query(
      `insert into tool_calls (entity_id, job_id, tool_name, tool_output, created_at)
       values ($1, null, 'cli:Read', 'x', now() - interval '10 seconds')`,
      [entityId],
    );
    const a = await readForeignActivity(db, WINDOW);
    expect(a.lastChatMs).not.toBeNull();
    expect(busyReason(a, Date.now(), WINDOW)).toMatch(/^a chat turn ran \d+ s ago$/);
  });

  it('a CLI run that belongs to a job is job work, not a chat turn', async () => {
    const j = await job();
    await pg.query(
      `insert into cli_runs (entity_id, agent_id, job_id, provider, mode, source, created_at)
       values ($1, $2, $3, 'codex', 'read', 'subscription', now() - interval '30 seconds')`,
      [entityId, agentId, j],
    );
    expect((await readForeignActivity(db, WINDOW)).lastChatMs).toBeNull();
  });

  it('a CLI chat turn older than the window does not hold the bench', async () => {
    await pg.query(
      `insert into cli_runs (entity_id, agent_id, job_id, provider, mode, source, created_at)
       values ($1, $2, null, 'claude', 'read', 'subscription', now() - interval '10 minutes')`,
      [entityId, agentId],
    );
    expect((await readForeignActivity(db, WINDOW)).lastChatMs).toBeNull();
  });
});

describe('the measures of a trial run by a coding CLI', () => {
  it('reads the cli_runs of the tree, with their cache tokens, beside the API calls', async () => {
    const root = await job();
    const child = await job({ parent: root });
    await pg.query(
      `insert into llm_calls (entity_id, job_id, source, model_effective, provider, input_tokens, output_tokens, cost_usd)
       values ($1, $2, 'job', 'z-ai/glm-5.3', 'openrouter', 1000, 50, 0.01)`,
      [entityId, root],
    );
    await pg.query(
      `insert into cli_runs (entity_id, agent_id, job_id, provider, mode, source, cost_usd,
                             input_tokens, output_tokens, cached_tokens, cache_creation_tokens, model_usage)
       values ($1, $2, $3, 'claude', 'read', 'subscription', 0.5, 10, 300, 5000, 200, $4::jsonb)`,
      [
        entityId,
        agentId,
        child,
        JSON.stringify([
          {
            model: 'claude-opus-4-1-20250805',
            inputTokens: 10,
            outputTokens: 300,
            cachedTokens: 5000,
            cacheCreationTokens: 200,
            costUsd: 0.5,
          },
        ]),
      ],
    );
    await pg.query(
      `insert into cli_runs (entity_id, agent_id, job_id, provider, mode, source, cost_usd,
                             input_tokens, output_tokens, cached_tokens, cache_creation_tokens, model_usage)
       values ($1, $2, $3, 'codex', 'read', 'subscription', null, 100, 20, 900, null, null)`,
      [entityId, agentId, child],
    );

    const facts = await readTreeFacts(db, root);
    expect(facts.cliRuns.map((r) => [r.provider, r.source, r.models])).toEqual([
      ['claude', 'subscription', ['claude-opus-4-1-20250805']],
      ['codex', 'subscription', []],
    ]);
    const m = measure(facts);
    // Entrée comparable à llm_calls (cache compris) : 1000 + (10 + 5000 + 200) + (100 + 900).
    expect(m.inputTokens).toBe(7210);
    expect(m.outputTokens).toBe(370);
    // Seul l'appel d'API est facturé à l'appel ; les runs sous abonnement ne le sont pas.
    expect(m.costUsd).toBe(0.01);
    expect(m.cliRuns).toBe(2);
    expect(m.llmCalls).toBe(1);
    expect(m.models).toEqual([
      'z-ai/glm-5.3',
      'claude-opus-4-1-20250805',
      'codex CLI, model not reported',
    ]);
  });
});

// Passe 3 (Reviewer A) : le filtre qui décide quels essais le banc annule
// (au démarrage et à l'arrêt) n'était prouvé nulle part. Il ne doit JAMAIS
// rendre un job du propriétaire.
describe('the live bench trials, and only them', () => {
  async function root(caller: string | null, status: string): Promise<string> {
    const r = await pg.query<{ id: string }>(
      `insert into agent_jobs (entity_id, agent_id, status, channel, task, trigger_context)
       values ($1, $2, $3, 'mcp', 'x', $4::jsonb) returning id::text`,
      [entityId, agentId, status, caller === null ? null : JSON.stringify({ caller })],
    );
    return r.rows[0]!.id;
  }

  it('returns the bench roots still alive, never a job of the owner', async () => {
    await pg.exec('delete from approval_requests; delete from agent_jobs;');
    const benchLive = await root('nodal-bench/research/v2', 'processing');
    const benchDone = await root('nodal-bench/question/v1', 'completed');
    const benchWithLiveChild = await root('nodal-bench/file/v1', 'completed');
    await job({ parent: benchWithLiveChild, status: 'processing' });
    const benchAsking = await root('nodal-bench/code/v1', 'completed');
    await pg.query(
      `insert into approval_requests (entity_id, job_id, tool_name, tool_input, status)
       values ($1, $2, 'run_command', '{}'::jsonb, 'pending')`,
      [entityId, benchAsking],
    );
    // Le propriétaire : un client MCP à lui, un job sans étiquette, un enfant vivant.
    await root('claude-desktop', 'processing');
    await root('my-nodal-bench/x', 'processing');
    const ownerParent = await root(null, 'awaiting_delegation');
    await job({ parent: ownerParent, status: 'processing' });

    const rows = await readLiveBenchRoots(db);
    expect(rows.map((r) => r.id).sort()).toEqual(
      [benchLive, benchWithLiveChild, benchAsking].sort(),
    );
    expect(rows.every((r) => r.entityId === entityId)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(benchDone);
  });
});
