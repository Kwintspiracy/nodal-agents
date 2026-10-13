// provider-transport-wiring.test.ts — every provider speaks through
// providerFetch (#608)
//
// The other tests of this package route providerFetch back to the global
// fetch they stub, so a provider that lost its `fetch: providerFetch` would
// still pass them all, and quietly go back to sharing a connection. Here the
// transport itself is replaced by a recorder: a provider whose request does
// not reach it fails this test.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ProviderName } from '../types';

const seen: string[] = [];

vi.mock('../transport', () => ({
  providerFetch: async (input: RequestInfo | URL): Promise<Response> => {
    seen.push(String(input));
    // A refusal every SDK reads as a plain API error.
    return new Response(JSON.stringify({ error: { message: 'recorded' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  },
}));

const { createLlmClient } = await import('../client');
const { createEmbeddingClient } = await import('../embeddings');
const { generateImageWithProvider } = await import('../providers/image-models');
const { createOpenRouterSpeech } = await import('../providers/speech-models');

beforeEach(() => {
  seen.length = 0;
});

const LOCAL = 'http://127.0.0.1:9/v1';

const PROVIDERS: Array<{ provider: ProviderName; model: string; baseURL?: string }> = [
  { provider: 'anthropic', model: 'claude-sonnet-5' },
  { provider: 'openai', model: 'gpt-5' },
  { provider: 'ollama', model: 'llama3', baseURL: 'http://127.0.0.1:9/api' },
  { provider: 'openai-compatible', model: 'local-model', baseURL: LOCAL },
  { provider: 'google', model: 'gemini-3-flash' },
  { provider: 'mistral', model: 'mistral-large-latest' },
  { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  { provider: 'openrouter', model: 'z-ai/glm-5.3' },
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'minimax', model: 'MiniMax-M3' },
  { provider: 'moonshot', model: 'kimi-k2.7' },
];

describe('provider transport wiring (#608) @cap:choisir-modele/moteur', () => {
  it.each(PROVIDERS)('$provider sends its model call through providerFetch', async (cfg) => {
    const client = createLlmClient({ ...cfg, apiKey: 'k' });

    await client
      .generateText({ messages: [{ role: 'user', content: 'hi' }] }, { streamed: true })
      .catch(() => undefined);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatch(/^https?:\/\//);
  });

  it.each([
    { provider: 'openai' as const, model: 'text-embedding-3-small' },
    { provider: 'ollama' as const, model: 'nomic-embed-text', baseURL: 'http://127.0.0.1:9' },
  ])('$provider embeddings go through providerFetch', async (cfg) => {
    await createEmbeddingClient({ ...cfg, apiKey: 'k' })
      .embed('hi')
      .catch(() => undefined);

    expect(seen.length).toBeGreaterThan(0);
  });

  it.each([
    { provider: 'openai' as const, model: 'gpt-image-1' },
    { provider: 'openrouter' as const, model: 'google/gemini-3-pro-image' },
  ])('$provider image generation goes through providerFetch', async (cfg) => {
    await generateImageWithProvider({ ...cfg, apiKey: 'k' }, { prompt: 'a cat' }).catch(
      () => undefined,
    );

    expect(seen.length).toBeGreaterThan(0);
  });

  it('speech goes through providerFetch', async () => {
    await createOpenRouterSpeech('k')({ model: 'openai/tts', text: 'hi', voice: 'alloy' }).catch(
      () => undefined,
    );

    expect(seen.length).toBeGreaterThan(0);
  });
});
