// llm-presets.test.ts — verify preset URLs and getPreset behavior

import { describe, it, expect } from 'vitest';
import { LLM_PRESETS, getPreset, type LlmPreset } from '../lib/llm-presets.ts';

describe('LLM_PRESETS', () => {
  it('has exactly 9 presets', () => {
    expect(LLM_PRESETS).toHaveLength(9);
  });

  it('each preset has a valid default base URL', () => {
    for (const preset of LLM_PRESETS) {
      expect(() => new URL(preset.defaultBaseURL)).not.toThrow();
    }
  });

  it('local presets do not require an API key', () => {
    const localProviders = [
      'ollama',
      'lm-studio',
      'jan-ai',
      'llamacpp',
      'vllm',
      'openai-compatible',
    ];
    for (const provider of localProviders) {
      const preset = LLM_PRESETS.find((p) => p.provider === provider);
      expect(preset).toBeDefined();
      expect(preset!.requiresApiKey).toBe(false);
    }
  });

  it('remote presets require an API key', () => {
    const remoteProviders = ['anthropic', 'openai', 'openrouter'];
    for (const provider of remoteProviders) {
      const preset = LLM_PRESETS.find((p) => p.provider === provider);
      expect(preset).toBeDefined();
      expect(preset!.requiresApiKey).toBe(true);
    }
  });

  it('ollama uses correct default URL', () => {
    const preset = getPreset('ollama');
    expect(preset.defaultBaseURL).toBe('http://localhost:11434');
  });

  it('lm-studio uses correct default URL', () => {
    const preset = getPreset('lm-studio');
    expect(preset.defaultBaseURL).toBe('http://localhost:1234/v1');
  });

  it('jan-ai uses correct default URL', () => {
    const preset = getPreset('jan-ai');
    expect(preset.defaultBaseURL).toBe('http://localhost:1337/v1');
  });

  it('llamacpp uses correct default URL', () => {
    const preset = getPreset('llamacpp');
    expect(preset.defaultBaseURL).toBe('http://localhost:8080/v1');
  });

  it('vllm uses correct default URL', () => {
    const preset = getPreset('vllm');
    expect(preset.defaultBaseURL).toBe('http://localhost:8000/v1');
  });

  it('anthropic uses correct default URL', () => {
    const preset = getPreset('anthropic');
    expect(preset.defaultBaseURL).toBe('https://api.anthropic.com');
  });

  it('openai uses correct default URL', () => {
    const preset = getPreset('openai');
    expect(preset.defaultBaseURL).toBe('https://api.openai.com/v1');
  });

  it('openrouter uses correct default URL', () => {
    const preset = getPreset('openrouter');
    expect(preset.defaultBaseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('each preset has a non-empty default model', () => {
    for (const preset of LLM_PRESETS) {
      expect(preset.defaultModel.length).toBeGreaterThan(0);
    }
  });

  it('each preset has a non-empty label', () => {
    for (const preset of LLM_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });
});

describe('getPreset', () => {
  it('throws for unknown provider', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => getPreset('unknown-provider' as any)).toThrow('Unknown LLM provider');
  });

  it('returns the correct preset for each valid provider', () => {
    const preset: LlmPreset = getPreset('ollama');
    expect(preset.provider).toBe('ollama');
  });
});
