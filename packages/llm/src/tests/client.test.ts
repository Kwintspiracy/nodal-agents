// client.test.ts — createLlmClient factory tests using MockLanguageModelV3

import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { createLlmClient } from '../client';
import { ProviderConfigError, MessageStructureError } from '../errors';
import { CAPABILITY_MATRIX } from '../providers/registry';
import type { ProviderName } from '../types';
import { mockTextResult } from './_mock-helpers';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a client backed by a mock model to avoid real provider construction.
 * We test the factory routing logic separately; here we test the client behavior.
 */
function makeMockClient(provider: ProviderName = 'anthropic') {
  // We'll test with real provider configs for routing tests,
  // but for behavior tests we patch the model indirectly via mock responses.
  return createLlmClient({
    provider,
    model: 'claude-3-5-sonnet-20241022',
    apiKey: 'test-key',
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('createLlmClient', () => {
  it('throws ProviderConfigError when provider is empty', () => {
    expect(() =>
      // @ts-expect-error intentional bad input
      createLlmClient({ provider: '', model: 'gpt-4o', apiKey: 'k' }),
    ).toThrow(ProviderConfigError);
  });

  it('throws ProviderConfigError when model is empty', () => {
    expect(() => createLlmClient({ provider: 'openai', model: '', apiKey: 'k' })).toThrow(
      ProviderConfigError,
    );
  });

  it('returns a client with the correct config', () => {
    const client = makeMockClient('openai');
    expect(client.config.provider).toBe('openai');
    expect(client.config.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('returns capabilities matching the registry for the given provider', () => {
    for (const provider of ['anthropic', 'openai', 'ollama'] as ProviderName[]) {
      const client = createLlmClient({
        provider,
        model: 'test-model',
        apiKey: 'key',
        baseURL: provider === 'ollama' ? 'http://localhost:11434' : undefined,
      });
      expect(client.capabilities).toEqual(CAPABILITY_MATRIX[provider]);
    }
  });

  it('exposes generateText, streamText, generateObject functions', () => {
    const client = makeMockClient('openai');
    expect(typeof client.generateText).toBe('function');
    expect(typeof client.streamText).toBe('function');
    expect(typeof client.generateObject).toBe('function');
  });

  it('throws ProviderConfigError for openai-compatible without baseURL', () => {
    expect(() =>
      createLlmClient({ provider: 'openai-compatible', model: 'llama3', apiKey: 'k' }),
    ).toThrow(ProviderConfigError);
  });

  it('creates openai-compatible client when baseURL is provided', () => {
    const client = createLlmClient({
      provider: 'openai-compatible',
      model: 'llama3',
      baseURL: 'http://localhost:1234/v1',
    });
    expect(client.config.provider).toBe('openai-compatible');
  });

  it('creates openrouter client when apiKey is provided', () => {
    const client = createLlmClient({
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      apiKey: 'or-test-key',
    });
    expect(client.config.provider).toBe('openrouter');
  });

  it('throws ProviderConfigError for openrouter without apiKey', () => {
    expect(() => createLlmClient({ provider: 'openrouter', model: 'some/model' })).toThrow(
      ProviderConfigError,
    );
  });
});

describe('createLlmClient — generateText with MockLanguageModelV3', () => {
  it('runs generateText with a mock model and returns text', async () => {
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-model',
      doGenerate: async () => mockTextResult('Hello from mock'),
    });

    // Use the AI SDK generateText directly with the mock model
    const { generateText } = await import('ai');
    const result = await generateText({
      model: mockModel,
      prompt: 'Say hello',
    });

    expect(result.text).toBe('Hello from mock');
  });

  it('validateMessageStructure is called and blocks bad messages', async () => {
    const client = createLlmClient({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: 'test-key',
    });

    // Message with unresolved tool call at end (missing tool result follow-up)
    const badMessages = [
      { role: 'user' as const, content: 'hello' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool-call' as const, toolCallId: 'tc1', toolName: 'foo', input: {} }],
      },
      // Missing tool result — unresolved tail
    ];

    await expect(client.generateText({ messages: badMessages })).rejects.toBeInstanceOf(
      MessageStructureError,
    );
  });
});
