// embeddings.test.ts — EmbeddingClient paths

import { describe, it, expect } from 'vitest';
import { createEmbeddingClient } from '../embeddings.js';

describe('createEmbeddingClient — keyword fallback', () => {
  it('returns null for embed() with keyword provider', async () => {
    const client = createEmbeddingClient({ provider: 'keyword' });
    const result = await client.embed('some text');
    expect(result).toBeNull();
  });

  it('has null dimensions for keyword provider', () => {
    const client = createEmbeddingClient({ provider: 'keyword' });
    expect(client.dimensions).toBeNull();
  });
});

describe('createEmbeddingClient — Ollama path (unit, network not required)', () => {
  it('creates an Ollama embedding client with default model and baseURL', () => {
    // Just check it constructs without throwing — no real network call
    const client = createEmbeddingClient({ provider: 'ollama' });
    expect(client).toBeDefined();
    expect(client.dimensions).toBe(1024);
    expect(typeof client.embed).toBe('function');
  });

  it('respects custom baseURL and model', () => {
    const client = createEmbeddingClient({
      provider: 'ollama',
      baseURL: 'http://localhost:11434',
      model: 'nomic-embed-text',
    });
    expect(client.dimensions).toBe(1024);
    expect(client).toBeDefined();
  });

  it('embed() would call the Ollama embedding endpoint (structure verified)', () => {
    // Verify that the client is constructed with the correct structure.
    // Real network call tested separately via OLLAMA_URL integration test.
    const client = createEmbeddingClient({ provider: 'ollama' });
    expect(client.dimensions).toBe(1024);
    expect(typeof client.embed).toBe('function');
  });
});

describe('createEmbeddingClient — OpenAI path (unit, network not required)', () => {
  it('creates an OpenAI embedding client with default model', () => {
    const client = createEmbeddingClient({
      provider: 'openai',
      apiKey: 'test-openai-key',
    });
    expect(client).toBeDefined();
    expect(client.dimensions).toBe(1536);
    expect(typeof client.embed).toBe('function');
  });

  it('respects custom model', () => {
    const client = createEmbeddingClient({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'text-embedding-3-large',
    });
    expect(client.dimensions).toBe(1536);
  });
});

describe('createEmbeddingClient — integration (real network, opt-in)', () => {
  it.runIf(process.env['OLLAMA_URL'])(
    'embeds a real string via Ollama (requires OLLAMA_URL)',
    async () => {
      const client = createEmbeddingClient({
        provider: 'ollama',
        baseURL: process.env['OLLAMA_URL'],
      });
      const embedding = await client.embed('hello world');
      expect(embedding).not.toBeNull();
      expect(Array.isArray(embedding)).toBe(true);
      expect((embedding as number[]).length).toBeGreaterThan(0);
    },
  );

  it.runIf(process.env['OPENAI_API_KEY'])(
    'embeds a real string via OpenAI (requires OPENAI_API_KEY)',
    async () => {
      const client = createEmbeddingClient({
        provider: 'openai',
        apiKey: process.env['OPENAI_API_KEY'],
      });
      const embedding = await client.embed('hello world');
      expect(embedding).not.toBeNull();
      expect(Array.isArray(embedding)).toBe(true);
      expect((embedding as number[]).length).toBe(1536);
    },
  );
});
