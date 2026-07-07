// @nodal-agents/adapter-gmail — bounded-concurrency helper tests

import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../../helpers/concurrency';

describe('mapWithConcurrency', () => {
  it('preserves result order regardless of completion order', async () => {
    const items = [30, 10, 20, 5, 1];
    const out = await mapWithConcurrency(items, 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual(items);
  });

  it('never runs more than `limit` calls concurrently (audit#2026-07-07 F3)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 23 }, (_, i) => i);

    await mapWithConcurrency(items, 5, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });

    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  it('handles an empty input without invoking fn', async () => {
    let called = false;
    const out = await mapWithConcurrency([], 5, async () => {
      called = true;
      return 1;
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('propagates a rejection from fn', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error('boom');
        return i;
      }),
    ).rejects.toThrow('boom');
  });
});
