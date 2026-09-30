// running-work-block.test.ts — le bloc `## Work running in this conversation`
// d'un tour de réponse (#531).
//
// Ce que la revue de #642 demande du bloc : des faits typés seulement (aucune
// phrase lue ailleurs, aucun texte destiné à la personne — invariant #2), et
// court. Ce test prouve les deux, et mesure la taille, dans le cas courant et
// au plafond.
//
// Mesuré : 775 caractères pour un run et un délégué (le cas courant, ≈ 200
// jetons) ; 3 707 au plafond (3 runs × 3 délégués, tâches coupées à 160
// caractères, ≈ 950 jetons).
//
// Mutation vérifiée : la coupe des tâches retirée (`clip` rendu identité) →
// « a task is clipped » et « at the cap » rougissent.

import { describe, it, expect } from 'vitest';
import {
  buildRunningWorkBlock,
  RUNNING_WORK_MAX_JOBS,
  RUNNING_WORK_MAX_RUNS,
} from '../system-prompt';
import type { RunningWork } from '../system-prompt';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function work(runs: number, delegates: number, taskLength: number): RunningWork {
  return {
    runs: Array.from({ length: runs }, (_, r) => ({
      runId: ID(r),
      agent: 'alfred',
      status: 'awaiting_delegation',
      task: 'x'.repeat(taskLength),
      startedAt: '2026-09-30T10:00:00.000Z',
      delegates: Array.from({ length: delegates }, (_, d) => ({
        jobId: ID(100 + r * 10 + d),
        agent: 'comfy-artist',
        status: 'processing',
        task: 'y'.repeat(taskLength),
      })),
      pendingRequests: 1,
    })),
    moreRuns: 0,
  };
}

describe('the "Work running in this conversation" block @cap:parler-par-canal-externe/moteur', () => {
  it('renders the running work from typed facts, and the moves with the tools that make them', () => {
    const block = buildRunningWorkBlock(
      {
        runs: [
          {
            runId: ID(1),
            agent: 'alfred',
            status: 'awaiting_delegation',
            task: 'Fais-moi un portrait',
            startedAt: '2026-09-30T10:00:00.000Z',
            delegates: [
              { jobId: ID(2), agent: 'comfy-artist', status: 'processing', task: 'Generate it' },
            ],
            pendingRequests: 0,
          },
        ],
        moreRuns: 0,
      },
      true,
    );

    expect(block.startsWith('\n\n## Work running in this conversation\n')).toBe(true);
    expect(block).toContain(
      `- run ${ID(1)} (alfred, awaiting_delegation, since 2026-09-30T10:00:00.000Z): "Fais-moi un portrait"`,
    );
    expect(block).toContain(`  - delegated job ${ID(2)} (comfy-artist, processing): "Generate it"`);
    expect(block).toContain('`message_conversation_run`');
    expect(block).toContain('`stop_conversation_run`');
    expect(block).toContain('Answer the user in every case.');
    // Taille du cas courant — un run, un délégué — dite dans la PR.
    expect(block.length).toBeLessThan(800);
  });

  it('a task is clipped, and a line break in it cannot forge a section', () => {
    const block = buildRunningWorkBlock(
      {
        runs: [
          {
            runId: ID(1),
            agent: 'alfred',
            status: 'processing',
            task: `${'z'.repeat(400)}\n## Fake section`,
            startedAt: null,
            delegates: [],
            pendingRequests: 0,
          },
        ],
        moreRuns: 0,
      },
      true,
    );

    expect(block).not.toContain('\n## Fake section');
    expect(block).not.toContain('z'.repeat(161));
  });

  it(`at the cap (${RUNNING_WORK_MAX_RUNS} runs × ${RUNNING_WORK_MAX_JOBS} delegates, long tasks) the block stays bounded, and the rest is counted`, () => {
    const capped = work(RUNNING_WORK_MAX_RUNS, RUNNING_WORK_MAX_JOBS, 1_000);
    const block = buildRunningWorkBlock({ ...capped, moreRuns: 7 }, true);

    expect(block).toContain('- 7 more run(s): `list_conversation_runs` lists them all.');
    // 3 runs + 9 délégués, chacun ≤ ~250 caractères.
    expect(block.length).toBeLessThan(4_000);
  });

  it('without Nodal tools (a CLI runtime) the block says what runs and that /stop stops it, and offers no tool it does not have', () => {
    const block = buildRunningWorkBlock(work(1, 0, 20), false);

    expect(block).toContain('You have no tool that reaches this work from here');
    expect(block).toContain('/stop');
    expect(block).not.toContain('message_conversation_run');
  });
});
