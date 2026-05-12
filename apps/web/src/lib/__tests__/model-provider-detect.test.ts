import { describe, it, expect } from 'vitest';
import { detectModelProviders, isModelCompatibleWithProvider } from '../model-provider-detect.ts';

describe('detectModelProviders', () => {
  it('returns anthropic for claude-* ids', () => {
    expect(detectModelProviders('claude-opus-4-7')).toEqual(new Set(['anthropic']));
    expect(detectModelProviders('claude-sonnet-4-6-20260217')).toEqual(new Set(['anthropic']));
    expect(detectModelProviders('claude-haiku-4-5-20251001')).toEqual(new Set(['anthropic']));
  });

  it('returns openai for gpt-* / chatgpt-* / o-series ids', () => {
    expect(detectModelProviders('gpt-4o')).toEqual(new Set(['openai']));
    expect(detectModelProviders('gpt-4-turbo')).toEqual(new Set(['openai']));
    expect(detectModelProviders('chatgpt-4o-latest')).toEqual(new Set(['openai']));
    expect(detectModelProviders('o3-mini')).toEqual(new Set(['openai']));
    expect(detectModelProviders('o4')).toEqual(new Set(['openai']));
    expect(detectModelProviders('o1-preview')).toEqual(new Set(['openai']));
  });

  it('returns google for gemini-* ids', () => {
    expect(detectModelProviders('gemini-2.5-pro')).toEqual(new Set(['google']));
    expect(detectModelProviders('gemini-1.5-flash-002')).toEqual(new Set(['google']));
  });

  it('returns google + local providers for gemma-* (open weight + local hosting)', () => {
    const result = detectModelProviders('gemma-3-27b-it');
    expect(result).toContain('google');
    expect(result).toContain('ollama');
    expect(result).toContain('openai-compatible');
  });

  it('returns mistral for mistral-/codestral-/pixtral-/etc', () => {
    expect(detectModelProviders('mistral-large-2411')).toEqual(new Set(['mistral']));
    expect(detectModelProviders('codestral-2501')).toEqual(new Set(['mistral']));
    expect(detectModelProviders('pixtral-12b')).toEqual(new Set(['mistral']));
    expect(detectModelProviders('mixtral-8x22b')).toEqual(new Set(['mistral']));
    expect(detectModelProviders('magistral-medium')).toEqual(new Set(['mistral']));
    expect(detectModelProviders('ministral-3b')).toEqual(new Set(['mistral']));
  });

  it('returns openrouter for any id containing a "/"', () => {
    expect(detectModelProviders('deepseek/deepseek-v4-flash')).toEqual(new Set(['openrouter']));
    expect(detectModelProviders('anthropic/claude-3-opus')).toEqual(new Set(['openrouter']));
    expect(detectModelProviders('meta-llama/llama-3.1-70b-instruct')).toEqual(
      new Set(['openrouter']),
    );
    expect(detectModelProviders('qwen/qwen3-coder-7b')).toEqual(new Set(['openrouter']));
  });

  it('returns local providers for bare llama/qwen/deepseek (no slash)', () => {
    const llama = detectModelProviders('llama-3.1-70b-instruct');
    expect(llama).toContain('ollama');
    expect(llama).toContain('openai-compatible');
    expect(llama).toContain('groq');

    const qwen = detectModelProviders('qwen3-coder');
    expect(qwen).toContain('ollama');
    expect(qwen).toContain('openai-compatible');
  });

  it('returns empty set for unknown / custom ids', () => {
    expect(detectModelProviders('whatever-custom-model')).toEqual(new Set());
    expect(detectModelProviders('my-fine-tuned-thing')).toEqual(new Set());
    expect(detectModelProviders('')).toEqual(new Set());
    expect(detectModelProviders('   ')).toEqual(new Set());
  });

  it('is case-insensitive', () => {
    expect(detectModelProviders('CLAUDE-OPUS-4-7')).toEqual(new Set(['anthropic']));
    expect(detectModelProviders('GPT-4o')).toEqual(new Set(['openai']));
  });
});

describe('isModelCompatibleWithProvider', () => {
  it('is true for an empty model (cannot judge)', () => {
    expect(isModelCompatibleWithProvider('', 'anthropic')).toBe(true);
    expect(isModelCompatibleWithProvider('   ', 'openai')).toBe(true);
  });

  it('is true when local providers host any model id', () => {
    expect(isModelCompatibleWithProvider('claude-opus-4-7', 'ollama')).toBe(true);
    expect(isModelCompatibleWithProvider('gpt-4o', 'openai-compatible')).toBe(true);
    expect(isModelCompatibleWithProvider('custom-thing', 'ollama')).toBe(true);
  });

  it('flags the live-bug case: deepseek/deepseek-v4-flash + anthropic key', () => {
    expect(isModelCompatibleWithProvider('deepseek/deepseek-v4-flash', 'anthropic')).toBe(false);
  });

  it('flags claude model with openai key', () => {
    expect(isModelCompatibleWithProvider('claude-opus-4-7', 'openai')).toBe(false);
  });

  it('flags gpt model with anthropic key', () => {
    expect(isModelCompatibleWithProvider('gpt-4o', 'anthropic')).toBe(false);
  });

  it('accepts the happy paths', () => {
    expect(isModelCompatibleWithProvider('claude-opus-4-7', 'anthropic')).toBe(true);
    expect(isModelCompatibleWithProvider('gpt-4o', 'openai')).toBe(true);
    expect(isModelCompatibleWithProvider('gemini-2.5-pro', 'google')).toBe(true);
    expect(isModelCompatibleWithProvider('mistral-large-2411', 'mistral')).toBe(true);
    expect(isModelCompatibleWithProvider('deepseek/deepseek-v4-flash', 'openrouter')).toBe(true);
  });

  it('does not false-flag unknown models', () => {
    // No detection → treated as compatible with everything (avoids noise on
    // custom or proxy setups the heuristic doesn't recognize).
    expect(isModelCompatibleWithProvider('custom-router-model', 'anthropic')).toBe(true);
    expect(isModelCompatibleWithProvider('custom-router-model', 'openai')).toBe(true);
  });
});
