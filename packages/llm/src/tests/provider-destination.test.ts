// provider-destination.test.ts — a model call goes to the stored address, or
// the provider's official one, with the stored key; nothing in the process
// environment decides either.
//
// The official SDKs read a base URL and a key from the environment when the
// option is not passed (`@ai-sdk/provider-utils` `loadOptionalSetting` /
// `loadApiKey`). Every variable they know is set here to a value that must
// never be used, then every provider of the catalog is built from a row with
// and without an address. The transport is replaced by a recorder, so the
// assertions read the URL and the headers of the request actually sent.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MODEL_PROVIDER_NAMES, PROVIDER_ENDPOINTS } from '@nodal-agents/shared';

import type { ProviderName } from '../types';

interface Sent {
  url: string;
  headers: Record<string, string>;
}

const sent: Sent[] = [];

vi.mock('../transport', () => ({
  providerFetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    sent.push({ url: String(input), headers });
    return new Response(JSON.stringify({ error: { message: 'recorded' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  },
}));

const { createLlmClient } = await import('../client');
const { createEmbeddingClient } = await import('../embeddings');
const { generateImageWithProvider } = await import('../providers/image-models');
const { ProviderConfigError } = await import('../errors');

/** Every environment variable the installed provider SDKs consult. */
const ENV_CHOSEN_URL = 'http://env-chosen.invalid/v1';
const ENV_CHOSEN_KEY = 'env-chosen-key-must-not-be-sent';
const AMBIENT: Record<string, string> = {
  ANTHROPIC_BASE_URL: ENV_CHOSEN_URL,
  OPENAI_BASE_URL: ENV_CHOSEN_URL,
  ANTHROPIC_API_KEY: ENV_CHOSEN_KEY,
  ANTHROPIC_AUTH_TOKEN: ENV_CHOSEN_KEY,
  OPENAI_API_KEY: ENV_CHOSEN_KEY,
  GOOGLE_GENERATIVE_AI_API_KEY: ENV_CHOSEN_KEY,
  MISTRAL_API_KEY: ENV_CHOSEN_KEY,
  GROQ_API_KEY: ENV_CHOSEN_KEY,
  DEEPSEEK_API_KEY: ENV_CHOSEN_KEY,
  OPENROUTER_API_KEY: ENV_CHOSEN_KEY,
};

const MODEL: Record<ProviderName, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5',
  ollama: 'llama3',
  'openai-compatible': 'local-model',
  google: 'gemini-3-flash',
  mistral: 'mistral-large-latest',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'z-ai/glm-5.3',
  deepseek: 'deepseek-chat',
  minimax: 'MiniMax-M3',
  moonshot: 'kimi-k2.7',
};

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  sent.length = 0;
  for (const [k, v] of Object.entries(AMBIENT)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(() => {
  for (const k of Object.keys(AMBIENT)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function sendOne(provider: ProviderName, row: { baseURL?: string; apiKey?: string }) {
  const client = createLlmClient({ provider, model: MODEL[provider], ...row });
  await client
    .generateText({ messages: [{ role: 'user', content: 'hi' }] }, { streamed: true })
    .catch(() => undefined);
  expect(sent.length).toBeGreaterThan(0);
  return sent[0]!;
}

function expectNothingAmbient(req: Sent): void {
  expect(req.url.startsWith(ENV_CHOSEN_URL)).toBe(false);
  expect(req.url).not.toContain(ENV_CHOSEN_KEY);
  for (const v of Object.values(req.headers)) expect(v).not.toContain(ENV_CHOSEN_KEY);
}

function expectStoredKey(req: Sent, key: string): void {
  const carried = Object.values(req.headers).some((v) => v === key || v === `Bearer ${key}`);
  expect(carried, `stored key in headers ${JSON.stringify(Object.keys(req.headers))}`).toBe(true);
}

const WITH_OFFICIAL = MODEL_PROVIDER_NAMES.filter((p) => PROVIDER_ENDPOINTS[p].officialBaseUrl);
const KEYED = MODEL_PROVIDER_NAMES.filter((p) => PROVIDER_ENDPOINTS[p].keyRequired);

describe('model call destination is the stored address or the official one @cap:choisir-modele/moteur', () => {
  it('every catalogued provider states where its key goes', () => {
    // A provider without an entry would have no rule for its destination.
    expect([...MODEL_PROVIDER_NAMES].sort()).toEqual(Object.keys(PROVIDER_ENDPOINTS).sort());
    expect(Object.keys(MODEL).sort()).toEqual([...MODEL_PROVIDER_NAMES].sort());
  });

  it.each(WITH_OFFICIAL)(
    '%s: a row without an address goes to the official address with the stored key',
    async (provider) => {
      const key = `stored-key-${provider}`;
      const req = await sendOne(provider, { apiKey: key });

      expect(req.url.startsWith(`${PROVIDER_ENDPOINTS[provider].officialBaseUrl!}/`)).toBe(true);
      expectNothingAmbient(req);
      if (PROVIDER_ENDPOINTS[provider].keyRequired) expectStoredKey(req, key);
    },
  );

  it.each([...MODEL_PROVIDER_NAMES])(
    '%s: a row with an address goes to that address with the stored key',
    async (provider) => {
      const key = `stored-key-${provider}`;
      const stored = `http://127.0.0.1:9/stored-${provider}`;
      const req = await sendOne(provider, { apiKey: key, baseURL: `${stored}/` });

      expect(req.url.startsWith(`${stored}/`)).toBe(true);
      expectNothingAmbient(req);
      if (PROVIDER_ENDPOINTS[provider].keyRequired) expectStoredKey(req, key);
    },
  );

  it('a server the person runs receives the key stored for it, and no other', async () => {
    const req = await sendOne('openai-compatible', {
      apiKey: 'local-server-key',
      baseURL: 'http://127.0.0.1:9/v1',
    });
    expectStoredKey(req, 'local-server-key');
    expectNothingAmbient(req);
  });

  it.each(KEYED)(
    '%s: a row without a key is refused, naming the provider, and nothing is sent',
    (provider) => {
      expect(() => createLlmClient({ provider, model: MODEL[provider] })).toThrow(
        ProviderConfigError,
      );
      expect(() => createLlmClient({ provider, model: MODEL[provider] })).toThrow(
        new RegExp(`: ${provider} provider requires an apiKey$`),
      );
      expect(sent).toEqual([]);
    },
  );

  it('a provider with no official address and no stored one is refused', () => {
    const none = MODEL_PROVIDER_NAMES.filter((p) => !PROVIDER_ENDPOINTS[p].officialBaseUrl);
    expect(none.length).toBeGreaterThan(0);
    for (const provider of none) {
      expect(() => createLlmClient({ provider, model: MODEL[provider], apiKey: 'k' })).toThrow(
        new RegExp(`: ${provider} provider requires a baseURL`),
      );
    }
    expect(sent).toEqual([]);
  });
});

describe('embedding and image calls follow the same rule @cap:se-souvenir/moteur', () => {
  it('openai embeddings without an address go to the official address with their own key', async () => {
    await createEmbeddingClient({ provider: 'openai', apiKey: 'embedding-key' })
      .embed('hi', { entityId: null })
      .catch(() => undefined);

    expect(sent[0]!.url.startsWith(`${PROVIDER_ENDPOINTS.openai.officialBaseUrl!}/`)).toBe(true);
    expectNothingAmbient(sent[0]!);
    expectStoredKey(sent[0]!, 'embedding-key');
  });

  it('openai embeddings without a key are refused, whatever the environment holds', () => {
    expect(() => createEmbeddingClient({ provider: 'openai' })).toThrow(
      /: openai provider requires an apiKey$/,
    );
  });

  it('ollama embeddings go to the stored address', async () => {
    await createEmbeddingClient({ provider: 'ollama', baseURL: 'http://127.0.0.1:9/api' })
      .embed('hi', { entityId: null })
      .catch(() => undefined);

    expect(sent[0]!.url.startsWith('http://127.0.0.1:9/api/')).toBe(true);
  });

  it.each(['openai', 'openrouter'] as const)(
    '%s image generation without an address goes to the official address with the stored key',
    async (provider) => {
      await generateImageWithProvider(
        { provider, model: 'img', apiKey: `stored-key-${provider}` },
        { prompt: 'a cat' },
      ).catch(() => undefined);

      expect(sent[0]!.url.startsWith(`${PROVIDER_ENDPOINTS[provider].officialBaseUrl!}/`)).toBe(
        true,
      );
      expectNothingAmbient(sent[0]!);
      expectStoredKey(sent[0]!, `stored-key-${provider}`);
    },
  );
});
