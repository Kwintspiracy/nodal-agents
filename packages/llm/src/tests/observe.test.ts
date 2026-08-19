// observe.test.ts — the inference-trace observation seam (étape D).
// buildLlmCallObservation is pure: assert real shapes from a REAL-shaped
// AI SDK result object (usage + providerMetadata + response.modelId), the
// error path, and that emitLlmCall never lets an observer break the call.

import { describe, it, expect, vi } from 'vitest';
import { buildLlmCallObservation, emitLlmCall } from '../observe';
import type { LlmCallObservation } from '../observe';

const BASE = {
  kind: 'generateText' as const,
  provider: 'openrouter',
  modelConfigured: 'z-ai/glm-5.2',
  reasoningEffort: 'high',
  meta: { keyId: 'k1', modelRequested: 'z-ai/glm-5.2', chainIndex: 1 },
};

describe('buildLlmCallObservation', () => {
  it('extracts usage, openrouter cost, and the provider-reported model', () => {
    const obs = buildLlmCallObservation({
      ...BASE,
      callArgs: {
        toolChoice: 'required',
        tools: { file_read: {}, return_result: {}, code_task: {} },
      },
      result: {
        usage: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 900 },
        providerMetadata: { openrouter: { usage: { cost: 0.0123 } } },
        response: { modelId: 'z-ai/glm-5.2:nitro' },
      },
      error: null,
      durationMs: 4200,
    });
    expect(obs.usage).toEqual({ inputTokens: 1200, outputTokens: 340, cachedTokens: 900 });
    expect(obs.costUsd).toBeCloseTo(0.0123, 6);
    expect(obs.modelReported).toBe('z-ai/glm-5.2:nitro');
    expect(obs.modelConfigured).toBe('z-ai/glm-5.2');
    expect(obs.toolChoice).toBe('required');
    expect(obs.toolNames).toEqual(['file_read', 'return_result', 'code_task']);
    expect(obs.meta.chainIndex).toBe(1);
    expect(obs.error).toBeNull();
  });

  it('degrades to nulls on a minimal result — never throws on shape drift', () => {
    const obs = buildLlmCallObservation({
      ...BASE,
      callArgs: {},
      result: { text: 'ok' },
      error: null,
      durationMs: 10,
    });
    expect(obs.usage).toBeNull();
    expect(obs.costUsd).toBeNull();
    expect(obs.modelReported).toBeNull();
    expect(obs.toolNames).toBeNull();
    expect(obs.toolChoice).toBeNull();
  });

  it('captures the terminal error with name and message, truncated', () => {
    const obs = buildLlmCallObservation({
      ...BASE,
      callArgs: {},
      result: null,
      error: new Error('Too Many Requests'),
      durationMs: 178_000,
    });
    expect(obs.error).toBe('Error: Too Many Requests');
    expect(obs.usage).toBeNull();
    expect(obs.durationMs).toBe(178_000);
  });

  it('serializes an object toolChoice instead of dropping it', () => {
    const obs = buildLlmCallObservation({
      ...BASE,
      callArgs: { toolChoice: { type: 'tool', toolName: 'return_result' } },
      result: null,
      error: new Error('x'),
      durationMs: 1,
    });
    expect(obs.toolChoice).toContain('return_result');
  });
});

describe('emitLlmCall', () => {
  it('a throwing observer is swallowed with a warning — never propagates', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const obs = buildLlmCallObservation({
      ...BASE,
      callArgs: {},
      result: null,
      error: null,
      durationMs: 1,
    });
    expect(() =>
      emitLlmCall(() => {
        throw new Error('observer bug');
      }, obs),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('delivers the observation to a working observer', () => {
    const seen: LlmCallObservation[] = [];
    const obs = buildLlmCallObservation({
      ...BASE,
      callArgs: {},
      result: { usage: { inputTokens: 1, outputTokens: 2 } },
      error: null,
      durationMs: 5,
    });
    emitLlmCall((o) => seen.push(o), obs);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.usage?.outputTokens).toBe(2);
  });
});
