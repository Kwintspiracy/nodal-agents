// run-tree-trial.test.ts — un essai et get_task lisent LE MÊME arbre de run.
//
// Revue de #889, passe 2 : le banc suivait `parent_job_id` seul. La tête que
// la file relance à la fin d'un run (#531 : `relaunched_from_job_id`, aucun
// parent) lui était invisible, alors que get_task (`descendRunTree`) la voit.
// Tant qu'elle vivait, les deux vues divergeaient à chaque lecture, et un essai
// juste finissait rouge en accusant get_task.
//
// Le vrai `runTrial`, sur une vraie base (spinUpTestDb) : les faits sont lus par
// le vrai `readTreeFacts`, l'annulation passe par le vrai `cancelTree`, et la
// vue de l'appelant vient de `readRunState`, la lecture même de get_task. Seuls
// l'horloge, le lancement et l'environnement sont simulés.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as d from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { seedMinimal, spinUpTestDb } from '@nodal-agents/db/test-utils';
import { readTreeFacts } from '../facts';
import { cancelTree } from '../stack';
import { scenarioById } from '../scenarios';
import { CALLER_VIEW_READS, runTrial, type TrialDeps, type TrialOptions } from '../trial';
import type { GetTaskReply } from '../mcp';

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
  await pg.query(`update agent_jobs set status = 'completed'`);
});

afterAll(async () => {
  await pg.close();
});

const OPTS: TrialOptions = {
  pollMs: 2_000,
  idleWaitMs: 10 * 60_000,
  idlePollMs: 30_000,
  chatQuietMs: 5 * 60_000,
  trigger: 'manual',
  nodalVersion: '0.9.8',
  stackCommit: null,
  modelUnderTest: null,
  allowOwnerSends: false,
};

/** Combien de sondages la tête relancée vit : bien plus que les relectures de la vue de l'appelant. */
const SUCCESSOR_LIVES_POLLS = 5 * CALLER_VIEW_READS;

describe('a relaunched successor head is part of the trial run @cap:parler-par-canal-externe/moteur', () => {
  it('while it lives the trial waits, then the trial is green, its facts include it, and get_task agrees', async () => {
    // Mutation exécutée : readTreeFacts revenu à `parent_job_id` seul fait
    // rougir CE test (l'essai s'arrête quand la première tête finit, et
    // get_task dit `running` à chaque relecture).
    const clock = { now: Date.parse('2026-10-31T03:00:00Z') };
    let rootId = '';
    let successorId = '';
    let polls = 0;
    const deps: TrialDeps = {
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
        polls++;
        if (polls === 1) {
          // La tête répond et finit ; sa file la relance (la forme que le
          // déclencheur de 0151 donne à la suite : aucun parent, le lien seul).
          await pg.query(
            `update agent_jobs set status = 'completed', result = 'Canberra.' where id = $1`,
            [rootId],
          );
          const r = await pg.query<{ id: string }>(
            `insert into agent_jobs (entity_id, agent_id, status, channel, task, relaunched_from_job_id)
             values ($1, $2, 'processing', 'mcp', 'la suite', $3) returning id::text`,
            [entityId, agentId, rootId],
          );
          successorId = r.rows[0]!.id;
        }
        if (polls === 1 + SUCCESSOR_LIVES_POLLS)
          await pg.query(`update agent_jobs set status = 'completed' where id = $1`, [successorId]);
      },
      start: async (instruction, caller) => {
        const r = await pg.query<{ id: string }>(
          `insert into agent_jobs (entity_id, agent_id, status, channel, task, trigger_context)
           values ($1, $2, 'processing', 'mcp', $3, $4::jsonb) returning id::text`,
          [entityId, agentId, instruction, JSON.stringify({ type: 'mcp', caller })],
        );
        rootId = r.rows[0]!.id;
        return {
          jobId: rootId,
          // Ce que get_task rend : l'état que `readRunState` lit, sa lecture à lui.
          getTask: async (): Promise<GetTaskReply> => {
            const state = await d.readRunState(db, entityId, rootId);
            return { jobId: rootId, status: state!.status, result: state!.result };
          },
          close: async () => undefined,
        };
      },
      read: (id) => readTreeFacts(db, id),
      cancel: (ent, id) => cancelTree(db, ent, id),
      foreign: async () => ({ jobs: [], lastChatMs: null }),
      env: async (startedMs) => ({
        workspaceRoots: [],
        teamTools: [],
        services: {},
        unlistedMcpServers: [],
        benchPrinter: { kind: 'absent' },
        processStarters: [],
        teamMcpServers: [],
        startedMs,
      }),
      rootModel: async () => 'z-ai/glm-5.3',
      subjects: () => [],
      log: () => undefined,
    };

    const line = await runTrial(scenarioById('question')!, deps, OPTS);

    expect(line.reasons).toEqual([]);
    expect(line.verdict).toBe('green');
    expect(line.cancelled).toBe(false);
    expect(line.answer).toBe('Canberra.');
    // L'essai a attendu la suite : arrêté plus tôt, son nettoyage l'aurait
    // annulée (même arbre), et elle ne serait pas `completed`.
    const facts = await readTreeFacts(db, rootId);
    expect(facts.jobs.map((j) => [j.id, j.relaunchedFromJobId, j.status])).toEqual([
      [rootId, null, 'completed'],
      [successorId, rootId, 'completed'],
    ]);
  });
});
