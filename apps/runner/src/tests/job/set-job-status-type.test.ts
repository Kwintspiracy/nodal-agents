// set-job-status-type.test.ts — `setJobStatus` n'écrit jamais un statut
// terminal, et c'est le COMPILATEUR qui le refuse (#944, revue Reviewer A de
// #956, passe 2).
//
// La cascade d'un délégué en ligne écrivait `setJobStatus(db, id, 'cancelled')` :
// un job fini sans passer par une porte, donc sans `job.finished` — et le motif
// du test d'architecture ne voyait pas la forme abrégée `{ status, … }`. Un
// statut terminal ne s'écrit que par une porte (`completeJob`, `failJob`,
// `cancelRootJob`, `cancelJobs`), qui l'annonce au flux.
//
// LA PREUVE EST LE TYPECHECK (`pnpm typecheck`, qui lit aussi ce fichier) :
// chaque `@ts-expect-error` ci-dessous exige que l'appel NE compile PAS. Si
// `setJobStatus` reprenait un statut terminal, la directive deviendrait inutile
// et le typecheck rougirait. Les appels ne sont jamais exécutés.

import { describe, it, expect } from 'vitest';
import { setJobStatus } from '../../job/state.ts';
import type { NonTerminalJobStatus, TerminalJobStatus } from '../../job/state.ts';

type Db = Parameters<typeof setJobStatus>[0];

/** Jamais appelée : elle n'existe que pour le compilateur. */
function terminalWritesDoNotCompile(db: Db): Array<Promise<boolean>> {
  return [
    // @ts-expect-error — terminal : par `cancelJobs`, jamais par setJobStatus.
    setJobStatus(db, 'job', 'cancelled'),
    // @ts-expect-error — terminal : par `completeJob` (finalizeJobSuccess).
    setJobStatus(db, 'job', 'completed'),
    // @ts-expect-error — terminal : par `failJob`.
    setJobStatus(db, 'job', 'failed'),
    // @ts-expect-error — ni glissé par la bande, dans `extra`.
    setJobStatus(db, 'job', 'processing', { status: 'cancelled' }),
    // Un statut vivant, lui, compile.
    setJobStatus(db, 'job', 'awaiting_approval'),
  ];
}

describe('setJobStatus refuse un statut terminal à la compilation (#944) @cap:suivre-execution/moteur', () => {
  it('les statuts que setJobStatus accepte et ceux des portes ne se recouvrent pas', () => {
    // Le côté exécution de la même règle : un statut ne peut pas être des deux.
    const live: NonTerminalJobStatus[] = [
      'pending',
      'processing',
      'awaiting_approval',
      'awaiting_delegation',
    ];
    const terminal: TerminalJobStatus[] = ['completed', 'failed', 'cancelled'];
    expect(live.filter((s) => (terminal as string[]).includes(s))).toEqual([]);
    expect(typeof terminalWritesDoNotCompile).toBe('function');
  });
});
