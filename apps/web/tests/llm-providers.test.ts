/**
 * Unit tests for src/lib/llm-providers.ts
 *
 * getConfiguredLlmProviders() reads from env — we set env vars in beforeEach
 * and clear them after to avoid cross-test pollution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => {
  process.env['DATABASE_URL'] = 'postgres://placeholder:5432/placeholder';
  process.env['AUTH_MODE'] = 'local-trust';
  process.env['RUNNER_URL'] = 'http://localhost:3001';
});

afterEach(() => {
  delete process.env['LLM_PROVIDER'];
  delete process.env['LLM_MODEL'];
  delete process.env['LLM_BASE_URL'];
  vi.resetModules();
});

describe('getConfiguredLlmProviders', () => {
  it('returns empty array when LLM_PROVIDER is not set', async () => {
    delete process.env['LLM_PROVIDER'];
    delete process.env['LLM_MODEL'];
    const { getConfiguredLlmProviders } = await import('../src/lib/llm-providers.ts');
    expect(getConfiguredLlmProviders()).toEqual([]);
  });

  it('returns empty array when LLM_MODEL is not set', async () => {
    process.env['LLM_PROVIDER'] = 'anthropic';
    delete process.env['LLM_MODEL'];
    const { getConfiguredLlmProviders } = await import('../src/lib/llm-providers.ts');
    expect(getConfiguredLlmProviders()).toEqual([]);
  });

  it('returns a single provider for openai-compatible / local LLM', async () => {
    process.env['LLM_PROVIDER'] = 'openai-compatible';
    process.env['LLM_MODEL'] = 'google/gemma-4-31b';
    process.env['LLM_BASE_URL'] = 'http://localhost:1234/v1';
    const { getConfiguredLlmProviders } = await import('../src/lib/llm-providers.ts');
    const providers = getConfiguredLlmProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: 'openai-compatible:google/gemma-4-31b',
      providerSlug: 'openai-compatible',
      model: 'google/gemma-4-31b',
      label: 'Local LLM · google/gemma-4-31b',
    });
  });

  it('returns a single provider for anthropic', async () => {
    process.env['LLM_PROVIDER'] = 'anthropic';
    process.env['LLM_MODEL'] = 'claude-sonnet-4-6-20260217';
    const { getConfiguredLlmProviders } = await import('../src/lib/llm-providers.ts');
    const providers = getConfiguredLlmProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: 'anthropic:claude-sonnet-4-6-20260217',
      label: 'Anthropic · claude-sonnet-4-6-20260217',
    });
  });
});

describe('prettyProviderName', () => {
  it('maps known slugs to friendly names', async () => {
    const { prettyProviderName } = await import('../src/lib/provider-names.ts');
    expect(prettyProviderName('openai-compatible')).toBe('Local LLM');
    expect(prettyProviderName('anthropic')).toBe('Anthropic');
    expect(prettyProviderName('openai')).toBe('OpenAI');
    expect(prettyProviderName('ollama')).toBe('Ollama');
    expect(prettyProviderName('openrouter')).toBe('OpenRouter');
    expect(prettyProviderName('google')).toBe('Google');
    expect(prettyProviderName('mistral')).toBe('Mistral');
    expect(prettyProviderName('groq')).toBe('Groq');
  });

  it('returns the slug unchanged for unknown providers', async () => {
    const { prettyProviderName } = await import('../src/lib/provider-names.ts');
    expect(prettyProviderName('some-future-provider')).toBe('some-future-provider');
  });
});
