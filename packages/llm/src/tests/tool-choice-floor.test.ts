// tool-choice-floor.test.ts — runtime relax of forced tool_choice (T1)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isUnsupportedToolChoiceError, generateWithToolChoiceFloor } from '../tool-choice-floor';

describe('isUnsupportedToolChoiceError', () => {
  it('matches the OpenRouter "no endpoints support tool_choice value" error', () => {
    const err = new Error("No endpoints found that support the provided 'tool_choice' value.");
    expect(isUnsupportedToolChoiceError(err)).toBe(true);
  });

  it('matches a "tool_choice ... not supported" message', () => {
    expect(
      isUnsupportedToolChoiceError(new Error("Invalid value for 'tool_choice': not supported")),
    ).toBe(true);
  });

  it('matches when the detail is in responseBody, not message', () => {
    const err = Object.assign(new Error('Bad Request'), {
      responseBody: JSON.stringify({ error: 'tool_choice value unsupported by provider' }),
    });
    expect(isUnsupportedToolChoiceError(err)).toBe(true);
  });

  it('finds it down the cause chain', () => {
    const inner = new Error('no endpoints found ... tool_choice value');
    const outer = new Error('wrapper', { cause: inner });
    expect(isUnsupportedToolChoiceError(outer)).toBe(true);
  });

  it('does NOT match an unrelated 400 (no tool_choice mention)', () => {
    expect(isUnsupportedToolChoiceError(new Error('Invalid value for max_tokens'))).toBe(false);
  });

  it('does NOT match a quota/rate-limit error', () => {
    expect(isUnsupportedToolChoiceError(new Error('rate limit exceeded'))).toBe(false);
  });

  it('does NOT match a tool_choice mention without an unsupported keyword', () => {
    // tool_choice present but it's a benign mention — must not relax blindly.
    expect(isUnsupportedToolChoiceError(new Error('tool_choice was set to required'))).toBe(false);
  });
});

describe('generateWithToolChoiceFloor', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rejectErr = () =>
    new Error("No endpoints found that support the provided 'tool_choice' value.");

  it("retries once with 'auto' when a forced value is rejected, and returns the result", async () => {
    const run = vi.fn(async (override?: 'auto') => {
      if (override !== 'auto') throw rejectErr();
      return 'served-with-auto';
    });
    const result = await generateWithToolChoiceFloor(run, 'required', 'openrouter/some-model');
    expect(result).toBe('served-with-auto');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toBeUndefined(); // first call: original (forced)
    expect(run.mock.calls[1]?.[0]).toBe('auto'); // retry: relaxed
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT relax when tool_choice was already auto (propagates the error)', async () => {
    const run = vi.fn(async () => {
      throw rejectErr();
    });
    await expect(generateWithToolChoiceFloor(run, 'auto', 'x/y')).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does NOT relax when no tool_choice was set (propagates)', async () => {
    const run = vi.fn(async () => {
      throw rejectErr();
    });
    await expect(generateWithToolChoiceFloor(run, undefined, 'x/y')).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('propagates an unrelated error without relaxing', async () => {
    const run = vi.fn(async () => {
      throw new Error('rate limit exceeded');
    });
    await expect(generateWithToolChoiceFloor(run, 'required', 'x/y')).rejects.toThrow('rate limit');
    expect(run).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('passes the result straight through on first success (no retry)', async () => {
    const run = vi.fn(async () => 'ok');
    const result = await generateWithToolChoiceFloor(run, 'required', 'x/y');
    expect(result).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
