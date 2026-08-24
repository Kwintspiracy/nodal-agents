// watchdog.test.ts — la sirène du lanceur : quand sonne-t-elle, et surtout
// quand NE sonne-t-elle pas.
//
// L'incident fondateur (23/08) : Postgres mort sous une stack « healthy »,
// zéro alerte. Le contrat à figer n'est pas « ça sonde » — c'est la politique
// de transition : une sonde ratée isolée reste silencieuse, deux d'affilée
// déclenchent UNE annonce (pas une par tick), et le retour à la santé
// s'annonce aussi. Chaque test pilote la sonde à la main et compte les
// annonces réellement émises.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startHealthWatchdog, type HealthProbeResult, type HealthState } from '../lib/watchdog.ts';

const INTERVAL = 1000;

/** File de résultats de sonde : chaque tick consomme le suivant (le dernier se répète). */
function scriptedProbe(script: HealthProbeResult[]): () => Promise<HealthProbeResult> {
  let i = 0;
  return async () => {
    const result = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return result;
  };
}

const OK: HealthProbeResult = { state: 'healthy', detail: '' };
const DB_DOWN: HealthProbeResult = { state: 'degraded', detail: 'database unreachable' };
const GONE: HealthProbeResult = { state: 'unreachable', detail: 'runner is not answering' };

let transitions: Array<{ state: HealthState; detail: string }>;
let stopFns: Array<() => void>;

function watch(probe: () => Promise<HealthProbeResult>, failureThreshold = 2) {
  const wd = startHealthWatchdog({
    probe,
    intervalMs: INTERVAL,
    failureThreshold,
    onTransition: (state, detail) => transitions.push({ state, detail }),
  });
  stopFns.push(wd.stop);
  return wd;
}

async function ticks(n: number) {
  for (let k = 0; k < n; k++) {
    await vi.advanceTimersByTimeAsync(INTERVAL);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  transitions = [];
  stopFns = [];
});

afterEach(() => {
  for (const stop of stopFns) stop();
  vi.useRealTimers();
});

describe('startHealthWatchdog', () => {
  it('une sonde ratée ISOLÉE ne sonne pas — deux d’affilée, si, et UNE seule fois', async () => {
    watch(scriptedProbe([OK, DB_DOWN, DB_DOWN, DB_DOWN, DB_DOWN]));

    await ticks(2); // OK puis 1er échec
    expect(transitions, 'la sirène a sonné sur un échec isolé').toEqual([]);

    await ticks(1); // 2e échec consécutif → annonce
    expect(transitions).toEqual([{ state: 'degraded', detail: 'database unreachable' }]);

    await ticks(2); // la panne persiste → pas de répétition
    expect(transitions, 'la même panne a été annoncée plusieurs fois').toHaveLength(1);
  });

  it('un échec isolé suivi d’un retour OK remet le compteur à zéro', async () => {
    watch(scriptedProbe([DB_DOWN, OK, DB_DOWN, OK, DB_DOWN, OK]));

    await ticks(6);
    expect(transitions, 'des échecs jamais consécutifs ont fini par sonner').toEqual([]);
  });

  it('le retour à la santé est annoncé — une fois', async () => {
    watch(scriptedProbe([DB_DOWN, DB_DOWN, OK, OK, OK]));

    await ticks(5);
    expect(transitions).toEqual([
      { state: 'degraded', detail: 'database unreachable' },
      { state: 'healthy', detail: 'services are answering again' },
    ]);
  });

  it('degraded puis unreachable = DEUX pannes distinctes, chacune annoncée', async () => {
    watch(scriptedProbe([DB_DOWN, DB_DOWN, GONE, GONE]));

    await ticks(4);
    expect(transitions).toEqual([
      { state: 'degraded', detail: 'database unreachable' },
      { state: 'unreachable', detail: 'runner is not answering' },
    ]);
  });

  it('stop() arrête la boucle — plus aucune sonde ni annonce ensuite', async () => {
    let calls = 0;
    const wd = watch(async () => {
      calls += 1;
      return DB_DOWN;
    });

    await ticks(2);
    expect(transitions).toHaveLength(1);
    const callsAtStop = calls;

    wd.stop();
    await ticks(3);
    expect(calls, 'la sonde a continué après stop()').toBe(callsAtStop);
    expect(transitions).toHaveLength(1);
  });

  it('une sonde GELÉE ne s’empile pas : les ticks suivants passent leur tour', async () => {
    let calls = 0;
    let release!: (r: HealthProbeResult) => void;
    watch(() => {
      calls += 1;
      return new Promise<HealthProbeResult>((resolve) => {
        release = resolve;
      });
    });

    await ticks(4); // 4 ticks, mais la 1re sonde n'a jamais répondu
    expect(calls, 'des sondes se sont empilées sur une sonde en vol').toBe(1);

    release(OK);
    await ticks(1);
    expect(calls).toBe(2);
  });
});
