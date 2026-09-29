// shell-turn.test.ts — la veille du frein se fige à la fin du tour (revue
// Nodal de #551, passe 3). Une lecture partie pendant le tour et revenue après
// `stop()` ne change plus ce qui a arrêté le tour : le verdict et la note le
// lisent une fois, et il ne doit pas bouger entre les deux, ni transformer une
// erreur de la CLI en arrêt du frein.

import { describe, it, expect } from 'vitest';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { watchBrakeDuringTurn } from '../../cli-runtime/shell-turn.ts';

/** Une base dont la lecture du frein répond « serré » après `ms`. */
const slowBrakedDb = (ms: number): AnyDrizzleDb =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            new Promise((resolve) => setTimeout(() => resolve([{ autoRunPaused: true }]), ms)),
        }),
      }),
    }),
  }) as unknown as AnyDrizzleDb;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('watchBrakeDuringTurn @cap:executer-une-commande/moteur', () => {
  it('a brake read still in flight when the turn ends does not change what stopped it', async () => {
    const watch = watchBrakeDuringTurn(
      slowBrakedDb(30),
      'entity',
      { kind: 'shell', tools: ['Bash'] },
      {
        everyMs: 60_000,
      },
    );
    watch.stop();
    await wait(80);
    expect(watch.stoppedBy()).toBeNull();
    expect(watch.signal?.aborted).toBe(false);
  });

  it('while the turn runs, the same read stops it', async () => {
    const watch = watchBrakeDuringTurn(
      slowBrakedDb(30),
      'entity',
      { kind: 'shell', tools: ['Bash'] },
      {
        everyMs: 60_000,
      },
    );
    await wait(80);
    watch.stop();
    expect(watch.stoppedBy()).toBe('auto_run_paused');
    expect(watch.signal?.aborted).toBe(true);
  });
});
