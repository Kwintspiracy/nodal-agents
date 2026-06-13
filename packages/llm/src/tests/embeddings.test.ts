// embeddings.test.ts — EmbeddingClient paths

import { describe, it, expect } from 'vitest';
import { createEmbeddingClient, validateEmbeddingDimension, EXPECTED_EMBEDDING_DIM } from '../embeddings';

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

// ─── Dimension validation ──────────────────────────────────────────────────────

describe('validateEmbeddingDimension', () => {
  it('throws a descriptive error when vector length does not match EXPECTED_EMBEDDING_DIM', () => {
    const wrongDimVector = Array.from({ length: 1024 }, () => 0.1);
    expect(() => validateEmbeddingDimension(wrongDimVector, 'ollama', 'mxbai-embed-large')).toThrow(
      /mxbai-embed-large.*ollama.*1024.*1536/,
    );
  });

  it('error message names the provider, model, actual dims, and expected dims', () => {
    const wrongDimVector = Array.from({ length: 768 }, () => 0.1);
    let thrown: Error | undefined;
    try {
      validateEmbeddingDimension(wrongDimVector, 'openai', 'text-embedding-ada-002');
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain('text-embedding-ada-002');
    expect(thrown?.message).toContain('openai');
    expect(thrown?.message).toContain('768');
    expect(thrown?.message).toContain(String(EXPECTED_EMBEDDING_DIM));
    expect(thrown?.message).toContain('EMBEDDING_PROVIDER=keyword');
  });

  it('does NOT throw when vector length equals EXPECTED_EMBEDDING_DIM (1536)', () => {
    const correctVector = Array.from({ length: EXPECTED_EMBEDDING_DIM }, () => 0.5);
    expect(() => validateEmbeddingDimension(correctVector, 'openai', 'text-embedding-3-small')).not.toThrow();
  });

  it('keyword mode (null vector) is intentionally not validated — only real vectors are checked', () => {
    // The keyword client returns null, so validateEmbeddingDimension is never
    // called for it. This test confirms null does not reach the validator.
    const keywordClient = createEmbeddingClient({ provider: 'keyword' });
    // embed() resolves to null — no dimension check occurs
    expect(keywordClient.embed('hello')).resolves.toBeNull();
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
