// embedding-credential.test.ts — the runner's embedding client sends the
// embedding provider's own key, never the chat provider's.
//
// The transport of @nodal-agents/llm is replaced by a recorder: the
// assertions read the URL and the headers of the request actually sent.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { embeddingConfigFromEnv } from '../deps.ts';

const sent = vi.hoisted(() => [] as Array<{ url: string; authorization: string | null }>);

vi.mock('../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return new Response(JSON.stringify({ error: { message: 'recorded' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  },
}));

beforeEach(() => {
  sent.length = 0;
});

/** A runner environment that also carries the chat provider's key. */
function runnerEnv(embedding: { EMBEDDING_API_KEY?: string; EMBEDDING_BASE_URL?: string }) {
  const env = {
    LLM_PROVIDER: 'openrouter',
    LLM_API_KEY: 'chat-provider-key',
    EMBEDDING_PROVIDER: 'openai' as const,
    EMBEDDING_MODEL: undefined,
    EMBEDDING_BASE_URL: embedding.EMBEDDING_BASE_URL,
    EMBEDDING_API_KEY: embedding.EMBEDDING_API_KEY,
  };
  return env;
}

describe('the embedding credential is its own @cap:se-souvenir/moteur', () => {
  it('openai embeddings send EMBEDDING_API_KEY to the official address, never LLM_API_KEY', async () => {
    const client = createEmbeddingClient(
      embeddingConfigFromEnv(runnerEnv({ EMBEDDING_API_KEY: 'embedding-key' })),
    );
    await client.embed('hi', { entityId: null }).catch(() => undefined);

    expect(sent).toEqual([
      { url: 'https://api.openai.com/v1/embeddings', authorization: 'Bearer embedding-key' },
    ]);
  });

  it('openai embeddings with a stored address send the embedding key there', async () => {
    const client = createEmbeddingClient(
      embeddingConfigFromEnv(
        runnerEnv({
          EMBEDDING_API_KEY: 'embedding-key',
          EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
        }),
      ),
    );
    await client.embed('hi', { entityId: null }).catch(() => undefined);

    expect(sent).toEqual([
      { url: 'http://127.0.0.1:9/v1/embeddings', authorization: 'Bearer embedding-key' },
    ]);
  });

  it('without an embedding key the client is refused, the chat key is not borrowed', () => {
    expect(() => createEmbeddingClient(embeddingConfigFromEnv(runnerEnv({})))).toThrow(
      /: openai provider requires an apiKey$/,
    );
    expect(sent).toEqual([]);
  });

  it('keyword search carries no credential at all', () => {
    expect(embeddingConfigFromEnv({ ...runnerEnv({}), EMBEDDING_PROVIDER: 'keyword' })).toEqual({
      provider: 'keyword',
    });
  });
});
