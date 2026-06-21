// openrouter-extra-body.test.ts — unit tests for buildOpenRouterExtraBody
// Pure function: no network calls, no mocking needed.
//
// Asserts that the extraBody produced for each model class is correct:
//  - always includes `usage: { include: true }`
//  - reasoning models get `reasoning: { enabled: true }`
//  - models with providerOrder get `provider: { order, allow_fallbacks: true }`
//  - models without providerOrder produce no `provider` key

import { describe, it, expect } from 'vitest';
import { buildOpenRouterExtraBody } from '../providers/openrouter';

describe('buildOpenRouterExtraBody', () => {
  it('always includes usage:{include:true} for any model', () => {
    const body = buildOpenRouterExtraBody('anthropic/claude-sonnet-4.6');
    expect(body.usage).toEqual({ include: true });
  });

  it('non-reasoning model without providerOrder: only usage key', () => {
    const body = buildOpenRouterExtraBody('anthropic/claude-sonnet-4.6');
    expect(Object.keys(body)).toEqual(['usage']);
  });

  it('reasoning model (minimax/minimax-m3) gets reasoning:{enabled,effort:medium}', () => {
    const body = buildOpenRouterExtraBody('minimax/minimax-m3');
    // Effort is capped at 'medium' so the model can't think past the call timeout.
    expect(body.reasoning).toEqual({ enabled: true, effort: 'medium' });
    expect(body.usage).toEqual({ include: true });
    // MiniMax has no providerOrder
    expect(body.provider).toBeUndefined();
  });

  it('deepseek/deepseek-v4-pro gets provider order + reasoning (it IS a reasoning model)', () => {
    const body = buildOpenRouterExtraBody('deepseek/deepseek-v4-pro');
    expect(body.provider).toEqual({ order: ['deepseek'], allow_fallbacks: true });
    expect(body.usage).toEqual({ include: true });
    expect(body.reasoning).toEqual({ enabled: true, effort: 'medium' });
  });

  it('deepseek/deepseek-v4-flash gets provider order + reasoning (it IS a reasoning model)', () => {
    const body = buildOpenRouterExtraBody('deepseek/deepseek-v4-flash');
    expect(body.provider).toEqual({ order: ['deepseek'], allow_fallbacks: true });
    expect(body.usage).toEqual({ include: true });
    expect(body.reasoning).toEqual({ enabled: true, effort: 'medium' });
  });

  it('z-ai/glm-5.2 is a reasoning model → reasoning:{enabled,effort:medium}', () => {
    const body = buildOpenRouterExtraBody('z-ai/glm-5.2');
    expect(body.reasoning).toEqual({ enabled: true, effort: 'medium' });
  });

  it('moonshotai/kimi-k2.7-code is a reasoning model → reasoning:{enabled,effort:medium}', () => {
    const body = buildOpenRouterExtraBody('moonshotai/kimi-k2.7-code');
    expect(body.reasoning).toEqual({ enabled: true, effort: 'medium' });
  });

  it('unknown/custom model (not in catalog) produces only usage key — no provider, no reasoning', () => {
    const body = buildOpenRouterExtraBody('some/unknown-model-xyz');
    expect(body.usage).toEqual({ include: true });
    expect(body.provider).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  it('deepseek/deepseek-v3.2 (no providerOrder in catalog) has no provider key', () => {
    const body = buildOpenRouterExtraBody('deepseek/deepseek-v3.2');
    expect(body.usage).toEqual({ include: true });
    expect(body.provider).toBeUndefined();
  });
});
