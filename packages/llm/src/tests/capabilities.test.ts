// capabilities.test.ts — every provider has a complete, documented capability matrix

import { describe, it, expect } from 'vitest';
import { CAPABILITY_MATRIX } from '../providers/registry';
import type { ProviderName, ProviderCapabilities } from '../types';

const PROVIDERS: ProviderName[] = [
  'anthropic',
  'openai',
  'ollama',
  'openai-compatible',
  'google',
  'mistral',
  'groq',
  'openrouter',
  'deepseek',
  'minimax',
  'moonshot',
];

const CAPABILITY_KEYS: (keyof ProviderCapabilities)[] = [
  'toolUse',
  'promptCaching',
  'vision',
  'structuredOutputs',
  'streaming',
];

describe('CAPABILITY_MATRIX', () => {
  it('has an entry for every ProviderName', () => {
    for (const provider of PROVIDERS) {
      expect(CAPABILITY_MATRIX).toHaveProperty(provider);
    }
  });

  it('each entry has all capability flags as booleans', () => {
    for (const provider of PROVIDERS) {
      const caps = CAPABILITY_MATRIX[provider];
      for (const key of CAPABILITY_KEYS) {
        expect(typeof caps[key], `${provider}.${key} should be boolean`).toBe('boolean');
      }
    }
  });

  // Provider-specific assertions based on known reality
  it('Anthropic supports toolUse, promptCaching, vision, streaming — not structuredOutputs', () => {
    const caps = CAPABILITY_MATRIX.anthropic;
    expect(caps.toolUse).toBe(true);
    expect(caps.promptCaching).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.structuredOutputs).toBe(false);
    expect(caps.streaming).toBe(true);
  });

  it('Ollama does NOT support promptCaching (local inference)', () => {
    expect(CAPABILITY_MATRIX.ollama.promptCaching).toBe(false);
  });

  it('Ollama supports toolUse and streaming', () => {
    expect(CAPABILITY_MATRIX.ollama.toolUse).toBe(true);
    expect(CAPABILITY_MATRIX.ollama.streaming).toBe(true);
  });

  it('OpenAI supports toolUse, vision, structuredOutputs, streaming — not promptCaching', () => {
    const caps = CAPABILITY_MATRIX.openai;
    expect(caps.toolUse).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.structuredOutputs).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.promptCaching).toBe(false);
  });

  it('openai-compatible is conservative: no vision, no promptCaching, no structuredOutputs', () => {
    const caps = CAPABILITY_MATRIX['openai-compatible'];
    expect(caps.vision).toBe(false);
    expect(caps.promptCaching).toBe(false);
    expect(caps.structuredOutputs).toBe(false);
    expect(caps.toolUse).toBe(true); // still expected to work
    expect(caps.streaming).toBe(true);
  });

  it('only Anthropic supports promptCaching', () => {
    const providersWithCaching = PROVIDERS.filter((p) => CAPABILITY_MATRIX[p].promptCaching);
    expect(providersWithCaching).toEqual(['anthropic']);
  });

  it('all providers support toolUse (required for orchestration)', () => {
    for (const provider of PROVIDERS) {
      expect(CAPABILITY_MATRIX[provider].toolUse, `${provider} must support toolUse`).toBe(true);
    }
  });

  it('all providers support streaming', () => {
    for (const provider of PROVIDERS) {
      expect(CAPABILITY_MATRIX[provider].streaming, `${provider} must support streaming`).toBe(
        true,
      );
    }
  });

  it('no extra providers beyond ProviderName union', () => {
    const matrixKeys = Object.keys(CAPABILITY_MATRIX) as ProviderName[];
    const sorted = [...matrixKeys].sort();
    const expected = [...PROVIDERS].sort();
    expect(sorted).toEqual(expected);
  });
});
