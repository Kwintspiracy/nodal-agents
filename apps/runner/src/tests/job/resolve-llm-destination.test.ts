// resolve-llm-destination.test.ts — the client every model call of the runner
// uses (job loop, chat, titles, rechecks, curators, reflection: all of them go
// through resolveAgentLlmClient, see architecture.test.ts) sends the stored
// key to the stored address, or to the provider's official address when the
// row stores none. The process environment decides neither.
//
// The transport of @nodal-agents/llm is replaced by a recorder: the
// assertions read the URL and the headers of the request actually sent.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { entityLlmKeys } from '@nodal-agents/db';
import { PROVIDER_ENDPOINTS } from '@nodal-agents/shared';
import { resolveAgentLlmClient } from '../../job/resolve-llm.ts';

const sent = vi.hoisted(() => [] as Array<{ url: string; headers: Record<string, string> }>);

vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
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

const ENV_CHOSEN_URL = 'http://env-chosen.invalid/v1';
const ENV_CHOSEN_KEY = 'env-chosen-key-must-not-be-sent';
const AMBIENT: Record<string, string> = {
  ANTHROPIC_BASE_URL: ENV_CHOSEN_URL,
  OPENAI_BASE_URL: ENV_CHOSEN_URL,
  ANTHROPIC_API_KEY: ENV_CHOSEN_KEY,
  OPENAI_API_KEY: ENV_CHOSEN_KEY,
  OPENROUTER_API_KEY: ENV_CHOSEN_KEY,
};
const saved: Record<string, string | undefined> = {};

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

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

async function keyRow(provider: string, apiKey: string | null, baseUrl: string | null) {
  const [row] = await db
    .insert(entityLlmKeys)
    .values({
      entityId: seed.entityId,
      provider,
      apiKey: apiKey === null ? '' : encrypt(apiKey),
      baseUrl,
      isActive: true,
    })
    .returning();
  if (!row) throw new Error('failed to insert key');
  return row.id;
}

async function callThrough(llmKeyId: string, model: string) {
  const res = await resolveAgentLlmClient(db, {
    entityId: seed.entityId,
    llmKeyId,
    fallbackChain: null,
    model,
  });
  if (!res.ok) throw new Error(`resolution failed: ${res.reason}`);
  await res.client
    .generateText({ messages: [{ role: 'user', content: 'hi' }] }, { streamed: true })
    .catch(() => undefined);
  expect(sent.length).toBeGreaterThan(0);
  return sent[0]!;
}

function headerValues(req: { headers: Record<string, string> }): string[] {
  return Object.values(req.headers);
}

describe('the runner sends a key to the address stored for it @cap:choisir-modele/moteur', () => {
  it.each([
    {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      header: 'x-api-key',
      value: (k: string) => k,
    },
    {
      provider: 'openai',
      model: 'gpt-5',
      header: 'authorization',
      value: (k: string) => `Bearer ${k}`,
    },
    {
      provider: 'openrouter',
      model: 'z-ai/glm-5.3',
      header: 'authorization',
      value: (k: string) => `Bearer ${k}`,
    },
  ] as const)(
    '$provider row without an address: official address, stored key',
    async ({ provider, model, header, value }) => {
      const id = await keyRow(provider, `stored-${provider}`, null);
      const req = await callThrough(id, model);

      expect(req.url.startsWith(`${PROVIDER_ENDPOINTS[provider].officialBaseUrl!}/`)).toBe(true);
      expect(req.headers[header]).toBe(value(`stored-${provider}`));
      expect(headerValues(req).join(' ')).not.toContain(ENV_CHOSEN_KEY);
    },
  );

  it('a row with an address: that address, stored key', async () => {
    const id = await keyRow('anthropic', 'stored-gateway-key', 'http://127.0.0.1:9/gateway/v1');
    const req = await callThrough(id, 'claude-sonnet-5');

    expect(req.url.startsWith('http://127.0.0.1:9/gateway/v1/')).toBe(true);
    expect(req.headers['x-api-key']).toBe('stored-gateway-key');
  });

  it('a hosted provider row without a key is refused, naming the provider, and nothing is sent', async () => {
    const id = await keyRow('anthropic', null, null);
    const res = await resolveAgentLlmClient(db, {
      entityId: seed.entityId,
      llmKeyId: id,
      fallbackChain: null,
      model: 'claude-sonnet-5',
    });

    expect(res).toEqual({
      ok: false,
      reason: 'llm_key_invalid',
      detail: 'Provider config error: anthropic provider requires an apiKey',
    });
    expect(sent).toEqual([]);
  });
});
