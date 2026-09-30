// trial.test.ts — les règles qui rendent le banc sûr sur la stack du propriétaire.
//
// Chaque règle est jouée contre un faux runner (horloge, base et lancement
// simulés) mais sur des lignes RÉELLES : l'essai `file` du 30/09 qui s'est
// arrêté sur une approbation. Ce que les tests vérifient, c'est le résultat —
// la ligne écrite, l'arbre annulé, le job jamais lancé — pas des compteurs
// d'appels.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TreeFactsSchema, type TreeFacts } from '../facts';
import { scenarioById } from '../scenarios';
import { busyReason, runTrial, type TrialDeps, type TrialOptions } from '../trial';
import type { ForeignActivity } from '../stack';

const FIX = join(__dirname, 'fixtures');
const load = (name: string): TreeFacts =>
  TreeFactsSchema.parse(
    (JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')) as { facts: unknown }).facts,
  );

const OPTS: TrialOptions = {
  pollMs: 2_000,
  idleWaitMs: 10 * 60_000,
  idlePollMs: 30_000,
  chatQuietMs: 5 * 60_000,
  trigger: 'manual',
  nodalVersion: '0.9.3',
  stackCommit: 'ebef7ed7e02b',
};

const IDLE: ForeignActivity = { jobs: [], lastChatMs: null };

interface World {
  deps: TrialDeps;
  started: string[];
  cancelled: Array<{ entityId: string; rootId: string }>;
  clock: { now: number };
}

/**
 * Un faux monde : `snapshots` est ce que la base rend, lecture après lecture,
 * tant que personne n'a annulé ; `afterCancel` est ce qu'elle rend ensuite.
 */
function world(opts: {
  rootId: string;
  snapshots: TreeFacts[];
  afterCancel?: TreeFacts;
  foreign?: ForeignActivity[];
}): World {
  const clock = { now: Date.parse('2026-09-30T03:00:00Z') };
  const started: string[] = [];
  const cancelled: Array<{ entityId: string; rootId: string }> = [];
  let reads = 0;
  let foreignReads = 0;
  const deps: TrialDeps = {
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    start: async (instruction) => {
      started.push(instruction);
      return { jobId: opts.rootId, close: async () => undefined };
    },
    read: async () => {
      if (cancelled.length > 0 && opts.afterCancel) return opts.afterCancel;
      const s = opts.snapshots[Math.min(reads, opts.snapshots.length - 1)]!;
      reads++;
      return s;
    },
    cancel: async (entityId, rootId) => {
      cancelled.push({ entityId, rootId });
    },
    foreign: async () => {
      const list = opts.foreign ?? [IDLE];
      return list[Math.min(foreignReads++, list.length - 1)]!;
    },
    env: async (startedMs) => ({ workspaceRoots: [], connectorTools: [], startedMs }),
    track: () => undefined,
    log: () => undefined,
  };
  return { deps, started, cancelled, clock };
}

/** L'essai `file` réel, tel qu'il était AVANT l'annulation : l'approbation en attente, les jobs vivants. */
function beforeCancel(after: TreeFacts): TreeFacts {
  return {
    ...after,
    jobs: after.jobs.map((j) => ({
      ...j,
      status: j.id === after.rootId ? 'awaiting_delegation' : 'awaiting_approval',
    })),
    approvals: after.approvals.map((a) => ({ ...a, status: 'pending', resolvedBy: null })),
  };
}

describe('workflow trial safety rules', () => {
  it('an approval raised by a trial is RED, and the whole tree is cancelled at once', async () => {
    const after = load('file-red-approval');
    const w = world({ rootId: after.rootId, snapshots: [beforeCancel(after)], afterCancel: after });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);

    // Annulé dès la première lecture qui voit l'approbation : aucune attente.
    expect(w.cancelled).toEqual([{ entityId: after.entityId, rootId: after.rootId }]);
    expect(w.clock.now - Date.parse('2026-09-30T03:00:00Z')).toBe(0);
    expect(line.verdict).toBe('red');
    expect(line.cancelled).toBe(true);
    expect(line.reasons).toContain('asked an approval (run_command)');
    expect(line.approvals).toBe(1);
    expect(line.rootJobId).toBe(after.rootId);
  });

  it('the bench never answers the approval: the only write is the cancel, which expires it', async () => {
    const after = load('file-red-approval');
    const w = world({ rootId: after.rootId, snapshots: [beforeCancel(after)], afterCancel: after });
    await runTrial(scenarioById('question')!, w.deps, OPTS);
    // La ligne relue après l'annulation : l'approbation est expirée par l'annulation, pas approuvée.
    expect(after.approvals.map((a) => [a.status, a.resolvedBy])).toEqual([
      ['expired', 'system:job_cancelled'],
    ]);
  });

  it('a live job of the owner makes the bench wait, then skip with the reason — nothing is started', async () => {
    const busy: ForeignActivity = {
      jobs: [
        {
          id: '5e3c1a90-0000-4000-8000-000000000000',
          status: 'processing',
          channel: 'telegram',
          agentSlug: 'alfred',
        },
      ],
      lastChatMs: null,
    };
    const after = load('question-green');
    const w = world({ rootId: after.rootId, snapshots: [after], foreign: [busy] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);

    expect(w.started).toEqual([]);
    expect(w.cancelled).toEqual([]);
    expect(line.verdict).toBe('skipped');
    expect(line.reasons).toEqual([
      'the stack was busy for 10 min: 1 job(s) of the owner still live: 5e3c1a90 alfred processing via telegram',
    ]);
    expect(line.rootJobId).toBeNull();
  });

  it('the owner finishing while the bench waits lets the trial run', async () => {
    const busy: ForeignActivity = {
      jobs: [
        {
          id: '5e3c1a90-0000-4000-8000-000000000000',
          status: 'processing',
          channel: 'telegram',
          agentSlug: 'alfred',
        },
      ],
      lastChatMs: null,
    };
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green], foreign: [busy, busy, IDLE] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(w.started).toEqual(["Quelle est la capitale de l'Australie ?"]);
    expect(line.verdict).toBe('green');
    expect(line.startedAt).toBe('2026-09-30T03:01:00.000Z');
  });

  it('a recent chat turn counts as the owner working', () => {
    const now = Date.parse('2026-09-30T03:00:00Z');
    expect(busyReason({ jobs: [], lastChatMs: now - 60_000 }, now, 5 * 60_000)).toBe(
      'a chat turn ran 60 s ago',
    );
    expect(busyReason({ jobs: [], lastChatMs: now - 6 * 60_000 }, now, 5 * 60_000)).toBeNull();
  });

  it('a run that outlives its budget is cancelled and red — the bench leaves nothing alive', async () => {
    const after = load('file-red-approval');
    const live: TreeFacts = { ...beforeCancel(after), approvals: [] };
    const w = world({
      rootId: after.rootId,
      snapshots: [live],
      afterCancel: { ...after, approvals: [] },
    });
    const s = scenarioById('question')!;
    const line = await runTrial(s, w.deps, OPTS);
    expect(w.cancelled).toEqual([{ entityId: after.entityId, rootId: after.rootId }]);
    expect(line.verdict).toBe('red');
    expect(line.reasons[0]).toBe('timed out after 5 min');
    expect(line.cancelled).toBe(true);
  });

  it('a missing prerequisite is RED with its reason, and no job is started', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    const line = await runTrial(scenarioById('print')!, w.deps, OPTS);
    expect(w.started).toEqual([]);
    expect(line.verdict).toBe('red');
    expect(line.reasons).toEqual([
      'no active connector of this workspace offers request_print (no printer connector configured)',
    ]);
  });

  it('a refused run_task is an ERROR line with the server words, never a silent pass', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    w.deps.start = async () => {
      throw new Error(
        'workflow_mcp_failed: run_task refused: mcp_disabled: the MCP server is switched off',
      );
    };
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(line.verdict).toBe('error');
    expect(line.reasons).toEqual([
      'workflow_mcp_failed: run_task refused: mcp_disabled: the MCP server is switched off',
    ]);
  });

  it('a green trial carries the real measures of its tree', async () => {
    const green = load('question-green');
    const w = world({ rootId: green.rootId, snapshots: [green] });
    const line = await runTrial(scenarioById('question')!, w.deps, OPTS);
    expect(line).toMatchObject({
      scenario: 'question',
      scenarioVersion: 1,
      verdict: 'green',
      reasons: [],
      jobs: 1,
      agents: ['alfred'],
      models: ['z-ai/glm-5.3'],
      llmCalls: 2,
      inputTokens: 33722,
      outputTokens: 70,
      costUsd: 0.0358,
      approvals: 0,
      cancelled: false,
      nodalVersion: '0.9.3',
    });
    expect(line.durationMs).toBe(20952);
  });
});
