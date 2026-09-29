// call-progress.test.ts — le battement d'un appel dit ce qu'il produit (#484).

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  watchCallProgress,
  CALL_PROGRESS_PERIOD_MS,
  liveCallProgress,
  LIVE_PROGRESS_PERIOD_MS,
} from '../../job/call-progress.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('watchCallProgress (#484) @cap:organiser-equipe/moteur', () => {
  it('says, every period, how long the call has run and what it produced last', () => {
    vi.useFakeTimers();
    const dit: Array<Record<string, unknown>> = [];
    const suivi = watchCallProgress((f) => dit.push(f));

    vi.advanceTimersByTime(CALL_PROGRESS_PERIOD_MS);
    suivi.onProgress({ textChars: 0, reasoningChars: 40, toolInputChars: 0, toolName: null });
    suivi.onProgress({ textChars: 0, reasoningChars: 40, toolInputChars: 12, toolName: 'x' });
    vi.advanceTimersByTime(CALL_PROGRESS_PERIOD_MS);

    expect(dit).toEqual([
      { elapsedMs: 60_000, textChars: 0, reasoningChars: 0, toolInputChars: 0, toolName: null },
      { elapsedMs: 120_000, textChars: 0, reasoningChars: 40, toolInputChars: 12, toolName: 'x' },
    ]);
    expect(suivi.produced()).toEqual({
      textChars: 0,
      reasoningChars: 40,
      toolInputChars: 12,
      toolName: 'x',
    });
  });

  it('says nothing more once stopped', () => {
    vi.useFakeTimers();
    const dit: unknown[] = [];
    const suivi = watchCallProgress((f) => dit.push(f));
    suivi.stop();
    vi.advanceTimersByTime(CALL_PROGRESS_PERIOD_MS * 3);
    expect(dit).toEqual([]);
  });
});

describe('liveCallProgress — ce que la page du run lit pendant l’appel (#444) @cap:suivre-execution/moteur', () => {
  it('pose l’appel dès son début, puis ce que le flux a produit, au plus une fois par période, et NULL à la fin', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T10:00:00.000Z'));
    const ecrit: unknown[] = [];
    const direct = liveCallProgress(
      (v) => {
        ecrit.push(v);
        return Promise.resolve();
      },
      { turn: 8 },
    );

    // Au début : l'appel est là, rien n'est encore venu.
    expect(ecrit).toEqual([
      {
        turn: 8,
        textChars: 0,
        reasoningChars: 0,
        toolInputChars: 0,
        toolName: null,
        callStartedAt: '2026-09-28T10:00:00.000Z',
        lastProgressAt: null,
      },
    ]);

    vi.advanceTimersByTime(2_000);
    direct.onProgress({ textChars: 120, reasoningChars: 0, toolInputChars: 0, toolName: null });
    vi.advanceTimersByTime(1_000);
    direct.onProgress({ textChars: 2_340, reasoningChars: 0, toolInputChars: 0, toolName: null });
    // Rien avant la fin de la période : pas une écriture par morceau.
    expect(ecrit).toHaveLength(1);

    vi.advanceTimersByTime(LIVE_PROGRESS_PERIOD_MS - 3_000);
    expect(ecrit[1]).toEqual({
      turn: 8,
      textChars: 2_340,
      reasoningChars: 0,
      toolInputChars: 0,
      toolName: null,
      callStartedAt: '2026-09-28T10:00:00.000Z',
      lastProgressAt: '2026-09-28T10:00:03.000Z',
    });

    // Une période sans rien de neuf : aucune écriture de plus.
    vi.advanceTimersByTime(LIVE_PROGRESS_PERIOD_MS);
    expect(ecrit).toHaveLength(2);

    await direct.stop();
    expect(ecrit[ecrit.length - 1]).toBeNull();
    vi.advanceTimersByTime(LIVE_PROGRESS_PERIOD_MS * 3);
    expect(ecrit).toHaveLength(3);
  });
});
