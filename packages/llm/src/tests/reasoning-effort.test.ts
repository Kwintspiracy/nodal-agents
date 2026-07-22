// reasoning-effort.test.ts — per-agent reasoning effort brick (2026-07-20).
// Every assertion targets the REAL request-body shape each provider sends
// (invariant 5) — the pure body-patch functions the fetch shims apply.

import { describe, it, expect } from 'vitest';
import { buildOpenRouterExtraBody } from '../providers/openrouter.ts';
import { injectMiniMaxThinking } from '../providers/minimax.ts';
import { patchMoonshotRequestBody } from '../providers/moonshot.ts';
import { injectGoogleThinking } from '../providers/google.ts';
import { injectAnthropicReasoning } from '../providers/anthropic.ts';
import { injectOpenAIReasoningEffort } from '../providers/openai.ts';

describe('OpenRouter reasoning effort', () => {
  it('explicit effort overrides the medium default on a reasoning model', () => {
    const body = buildOpenRouterExtraBody('z-ai/glm-5.2', 'high');
    expect(body.reasoning).toEqual({ enabled: true, effort: 'high' });
  });

  it("'max' maps to OpenRouter's 'xhigh'", () => {
    const body = buildOpenRouterExtraBody('moonshotai/kimi-k3', 'max');
    expect(body.reasoning).toEqual({ enabled: true, effort: 'xhigh' });
  });

  it("'off' disables reasoning explicitly", () => {
    const body = buildOpenRouterExtraBody('minimax/minimax-m3', 'off');
    expect(body.reasoning).toEqual({ enabled: false });
  });

  it('Claude routes: no injection on Auto (control without the reasoning flag), injection with effort', () => {
    expect(buildOpenRouterExtraBody('anthropic/claude-opus-4.8').reasoning).toBeUndefined();
    expect(buildOpenRouterExtraBody('anthropic/claude-opus-4.8', 'low').reasoning).toEqual({
      enabled: true,
      effort: 'low',
    });
  });

  it('Auto keeps the pre-feature medium default on reasoning models', () => {
    const body = buildOpenRouterExtraBody('minimax/minimax-m3');
    expect(body.reasoning).toEqual({ enabled: true, effort: 'medium' });
  });
});

describe('MiniMax thinking budget', () => {
  it('a level budget replaces the 8000 default and bumps max_tokens above it', () => {
    const body = injectMiniMaxThinking({ max_tokens: 1000, top_p: 0.9 }, 16_000) as Record<
      string,
      unknown
    >;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16_000 });
    expect(body.max_tokens).toBe(16_000 + 4096);
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBeUndefined();
  });

  it('default budget stays 8000 (Auto — pre-feature body)', () => {
    const body = injectMiniMaxThinking({}) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
  });
});

describe('Moonshot K3 reasoning_effort', () => {
  it('sets the top-level reasoning_effort when not injecting K2 thinking', () => {
    const body = patchMoonshotRequestBody(
      { model: 'kimi-k3', temperature: 0.7 },
      { injectThinking: false, reasoningEffort: 'max' },
    ) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('max');
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('K2 thinking injection still wins the XOR (reasoning_effort dropped)', () => {
    const body = patchMoonshotRequestBody(
      { model: 'kimi-k2.6', reasoning_effort: 'max' },
      { injectThinking: true, reasoningEffort: 'max' },
    ) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe('Google thinking_level', () => {
  it('sets thinkingLevel alongside includeThoughts', () => {
    const body = injectGoogleThinking({}, 'low') as {
      generationConfig: { thinkingConfig: unknown };
    };
    expect(body.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'low',
    });
  });

  it('Auto (no level) keeps the pre-feature shape', () => {
    const body = injectGoogleThinking({}) as { generationConfig: { thinkingConfig: unknown } };
    expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
  });
});

describe('Anthropic reasoning injection', () => {
  it('adaptive-effort (Claude ≥4.6) sets output_config.effort and nothing else', () => {
    const body = injectAnthropicReasoning(
      { max_tokens: 4096, temperature: 0.3 },
      { kind: 'adaptive-effort', levels: ['low', 'medium', 'high', 'max'] },
      'high',
    ) as Record<string, unknown>;
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.3);
  });

  it('budget (Haiku 4.5) sets thinking + the Messages-API constraints', () => {
    const body = injectAnthropicReasoning(
      { max_tokens: 1024, temperature: 0.3, top_p: 0.9 },
      { kind: 'budget', budgets: { low: 4000, medium: 8000, high: 16_000, max: 32_000 } },
      'medium',
    ) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
    expect(body.max_tokens).toBe(8000 + 4096);
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBeUndefined();
  });

  it('never overwrites an explicit caller setting (idempotent)', () => {
    const body = injectAnthropicReasoning(
      { output_config: { effort: 'low' } },
      { kind: 'adaptive-effort', levels: ['low', 'medium', 'high', 'max'] },
      'max',
    ) as Record<string, unknown>;
    expect(body.output_config).toEqual({ effort: 'low' });
  });
});

describe('OpenAI reasoning_effort', () => {
  it('sets the top-level field, preserving an explicit caller value', () => {
    expect(injectOpenAIReasoningEffort({}, 'high')).toEqual({ reasoning_effort: 'high' });
    expect(injectOpenAIReasoningEffort({ reasoning_effort: 'low' }, 'high')).toEqual({
      reasoning_effort: 'low',
    });
  });
});
