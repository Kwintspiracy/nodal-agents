// resolve-llm.test.ts — per-agent LLM chain resolution.
// Asserts the REAL resolution result against real entity_llm_keys rows: the
// chain built, what's skipped (and why), and that the forced-tool_choice
// capability is read from the model CATALOG (provider, agent.model), not a
// stored column. Failover BEHAVIOUR is unit-tested in failover.test.ts.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { entityLlmKeys } from '@nodal-agents/db';
import { resolveAgentLlmClient } from '../../job/resolve-llm.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32)); // so encrypted test keys can be decrypted
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

// A key is now just credentials. The fallback's MODEL comes from the catalog of
// its provider — so the provider matters (openrouter/anthropic have a catalog;
// openai-compatible/ollama don't).
async function insertKey(opts: { provider: string; isActive: boolean }): Promise<string> {
  const local = opts.provider === 'openai-compatible' || opts.provider === 'ollama';
  const [row] = await db
    .insert(entityLlmKeys)
    .values({
      entityId: seed.entityId,
      provider: opts.provider,
      // Encrypted non-empty key — openrouter/anthropic builders require one to
      // construct (the primary seedMinimal key is local openai-compatible, empty).
      apiKey: encrypt('sk-test-key'),
      baseUrl: local ? 'http://localhost:11434' : null,
      nickname: null,
      isActive: opts.isActive,
    })
    .returning();
  if (!row) throw new Error('failed to insert key');
  return row.id;
}

describe('resolveAgentLlmClient', () => {
  it('builds a 2-link chain when the fallback provider has a catalog model', async () => {
    const fbId = await insertKey({ provider: 'openrouter', isActive: true });
    const res = await resolveAgentLlmClient(db, {
      llmKeyId: seed.llmKeyId,
      fallbackChain: [{ keyId: fbId, model: '' }],
      model: 'mock',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.chainLength).toBe(2);
      expect(res.primaryProvider).toBe('openai-compatible');
    }
  });

  it('skips an INACTIVE fallback (chain stays length 1, onSkip fired)', async () => {
    const fbId = await insertKey({ provider: 'openrouter', isActive: false });
    const skipped: Array<{ keyId: string; reason: string }> = [];
    const res = await resolveAgentLlmClient(
      db,
      { llmKeyId: seed.llmKeyId, fallbackChain: [{ keyId: fbId, model: '' }], model: 'mock' },
      (info) => skipped.push(info),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.chainLength).toBe(1);
    expect(skipped).toEqual([{ keyId: fbId, reason: 'missing_or_inactive' }]);
  });

  it('an INACTIVE primary fails over to the active fallback (not unconfigured)', async () => {
    const deadPrimary = await insertKey({ provider: 'openrouter', isActive: false });
    const liveFallback = await insertKey({ provider: 'openrouter', isActive: true });
    const skipped: Array<{ keyId: string; reason: string }> = [];
    const res = await resolveAgentLlmClient(
      db,
      {
        llmKeyId: deadPrimary,
        // Fallback runs on its own chosen model, not the (disabled) primary's.
        fallbackChain: [{ keyId: liveFallback, model: 'deepseek/deepseek-v4-pro' }],
        model: 'anthropic/claude-opus-4.8',
      },
      (info) => skipped.push(info),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.chainLength).toBe(1); // dead primary dropped; fallback serves
      expect(res.primaryProvider).toBe('openrouter');
    }
    expect(skipped).toEqual([{ keyId: deadPrimary, reason: 'missing_or_inactive' }]);
  });

  it('agent_no_llm_configured when the primary AND every fallback are inactive', async () => {
    const deadPrimary = await insertKey({ provider: 'openrouter', isActive: false });
    const deadFallback = await insertKey({ provider: 'openrouter', isActive: false });
    const res = await resolveAgentLlmClient(db, {
      llmKeyId: deadPrimary,
      fallbackChain: [{ keyId: deadFallback, model: '' }],
      model: 'mock',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('agent_no_llm_configured');
  });

  it('skips a fallback whose provider has no catalog model (onSkip fired)', async () => {
    const fbId = await insertKey({ provider: 'ollama', isActive: true });
    const skipped: Array<{ keyId: string; reason: string }> = [];
    const res = await resolveAgentLlmClient(
      db,
      { llmKeyId: seed.llmKeyId, fallbackChain: [{ keyId: fbId, model: '' }], model: 'mock' },
      (info) => skipped.push(info),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.chainLength).toBe(1);
    expect(skipped).toEqual([{ keyId: fbId, reason: 'no_catalog_model' }]);
  });

  it('a missing fallback id is skipped, not fatal', async () => {
    const res = await resolveAgentLlmClient(db, {
      llmKeyId: seed.llmKeyId,
      fallbackChain: [{ keyId: '00000000-0000-0000-0000-0000000000ff', model: '' }],
      model: 'mock',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.chainLength).toBe(1);
  });

  it('fails loud when there is no primary key', async () => {
    const res = await resolveAgentLlmClient(db, {
      llmKeyId: null,
      fallbackChain: [],
      model: 'mock',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('agent_no_llm_configured');
  });

  it('reads forced-tool_choice capability from the catalog by (provider, agent.model)', async () => {
    const orId = await insertKey({ provider: 'openrouter', isActive: true });

    // A catalogued tool-capable model → true.
    const sonnet = await resolveAgentLlmClient(db, {
      llmKeyId: orId,
      fallbackChain: [],
      model: 'anthropic/claude-sonnet-4.6',
    });
    expect(sonnet.ok).toBe(true);
    if (sonnet.ok) expect(sonnet.primarySupportsForcedToolChoice).toBe(true);

    // An unknown/custom model → default true (the runtime floor backstops).
    const custom = await resolveAgentLlmClient(db, {
      llmKeyId: orId,
      fallbackChain: [],
      model: 'some/unknown-model',
    });
    expect(custom.ok).toBe(true);
    if (custom.ok) expect(custom.primarySupportsForcedToolChoice).toBe(true);

    // MiniMax M3 → false: the catalog marks it forcedToolChoice:false (some of
    // its OpenRouter endpoints reject a forced tool_choice), so the runner sends
    // 'auto' instead of 'required' and the recurring 404 ("No endpoints found
    // that support the provided 'tool_choice' value") does not recur.
    const minimax = await resolveAgentLlmClient(db, {
      llmKeyId: orId,
      fallbackChain: [],
      model: 'minimax/minimax-m3',
    });
    expect(minimax.ok).toBe(true);
    if (minimax.ok) expect(minimax.primarySupportsForcedToolChoice).toBe(false);
  });
});

// reasoning-effort resolution — 0.8's Auto/Off/low→max scale. `client.config`
// is what the provider builder actually reads (packages/llm), so asserting on
// it here proves the REAL value resolve-llm hands downstream, not just that
// resolution "succeeded".
describe('resolveAgentLlmClient — reasoning effort', () => {
  it('resolves a valid agent-level reasoning_effort onto the primary config', async () => {
    const res = await resolveAgentLlmClient(db, {
      llmKeyId: seed.llmKeyId,
      fallbackChain: [],
      model: 'mock',
      reasoningEffort: 'high',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.client.config.reasoningEffort).toBe('high');
  });

  it.each([null, undefined, ''])(
    'reasoning_effort %j resolves to Auto (undefined on the config)',
    async (value) => {
      const res = await resolveAgentLlmClient(db, {
        llmKeyId: seed.llmKeyId,
        fallbackChain: [],
        model: 'mock',
        reasoningEffort: value,
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.client.config.reasoningEffort).toBeUndefined();
    },
  );

  it('an invalid agent-level reasoning_effort is dropped to Auto and warns loudly', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await resolveAgentLlmClient(db, {
        llmKeyId: seed.llmKeyId,
        fallbackChain: [],
        model: 'mock',
        reasoningEffort: 'ultra', // not on REASONING_EFFORT_LEVELS
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.client.config.reasoningEffort).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'ignoring invalid reasoning_effort "ultra" (agents.reasoning_effort)',
        ),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a fallback link's own reasoning_effort wins over the agent's inherited effort", async () => {
    const deadPrimary = await insertKey({ provider: 'openrouter', isActive: false });
    const liveFallback = await insertKey({ provider: 'openrouter', isActive: true });
    const res = await resolveAgentLlmClient(db, {
      llmKeyId: deadPrimary,
      fallbackChain: [
        { keyId: liveFallback, model: 'deepseek/deepseek-v4-pro', reasoningEffort: 'low' },
      ],
      model: 'anthropic/claude-opus-4.8',
      reasoningEffort: 'max', // must NOT win: the link sets its own
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Dead primary dropped ⇒ configs.length === 1 ⇒ plain client, so
      // `client.config` IS the fallback's own resolved config (no failover
      // wrapper masking it).
      expect(res.chainLength).toBe(1);
      expect(res.client.config.reasoningEffort).toBe('low');
    }
  });

  it("a fallback link without its own reasoning_effort inherits the agent's effort", async () => {
    const deadPrimary = await insertKey({ provider: 'openrouter', isActive: false });
    const liveFallback = await insertKey({ provider: 'openrouter', isActive: true });
    const res = await resolveAgentLlmClient(db, {
      llmKeyId: deadPrimary,
      fallbackChain: [{ keyId: liveFallback, model: 'deepseek/deepseek-v4-pro' }],
      model: 'anthropic/claude-opus-4.8',
      reasoningEffort: 'max',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.chainLength).toBe(1);
      expect(res.client.config.reasoningEffort).toBe('max');
    }
  });

  it("a fallback link's own INVALID reasoning_effort is dropped, falling back to the agent's inherited effort", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deadPrimary = await insertKey({ provider: 'openrouter', isActive: false });
      const liveFallback = await insertKey({ provider: 'openrouter', isActive: true });
      const res = await resolveAgentLlmClient(db, {
        llmKeyId: deadPrimary,
        fallbackChain: [
          { keyId: liveFallback, model: 'deepseek/deepseek-v4-pro', reasoningEffort: 'bogus' },
        ],
        model: 'anthropic/claude-opus-4.8',
        reasoningEffort: 'medium',
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.chainLength).toBe(1);
        expect(res.client.config.reasoningEffort).toBe('medium');
      }
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `ignoring invalid reasoning_effort "bogus" (fallback ${liveFallback})`,
        ),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
