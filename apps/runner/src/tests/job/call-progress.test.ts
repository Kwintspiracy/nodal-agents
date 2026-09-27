// call-progress.test.ts — le battement d'un appel dit ce qu'il produit (#484).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { watchCallProgress, CALL_PROGRESS_PERIOD_MS } from '../../job/call-progress.ts';

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
