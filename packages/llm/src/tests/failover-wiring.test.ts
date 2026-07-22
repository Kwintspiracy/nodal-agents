// failover-wiring.test.ts — createFailoverLlmClient marks every provider
// except the LAST with hasFallback, so rate-limit retries hand over to the
// backup instead of out-waiting congestion (see rate-limit-policy.test.ts for
// the retry behavior itself).

import { describe, it, expect, vi } from 'vitest';
import type { ProviderConfig, NodalLlmClient } from '../types';

const createLlmClientMock = vi.fn(
  (config: ProviderConfig, opts?: { hasFallback?: boolean }): NodalLlmClient =>
    ({
      config,
      capabilities: { promptCaching: false, vision: false, toolUse: true },
      generateText: () => Promise.reject(new Error(`unused ${opts?.hasFallback}`)),
      streamText: () => {
        throw new Error('unused');
      },
      generateObject: () => Promise.reject(new Error('unused')),
    }) as unknown as NodalLlmClient,
);

vi.mock('../client', () => ({
  createLlmClient: (config: ProviderConfig, opts?: { hasFallback?: boolean }) =>
    createLlmClientMock(config, opts),
}));

import { createFailoverLlmClient } from '../failover';

function cfg(model: string): ProviderConfig {
  return { provider: 'openrouter', model, apiKey: 'k' } as ProviderConfig;
}

describe('createFailoverLlmClient — hasFallback wiring', () => {
  it('marks every provider except the last as hasFallback', () => {
    createLlmClientMock.mockClear();
    createFailoverLlmClient([cfg('a'), cfg('b'), cfg('c')]);

    expect(createLlmClientMock.mock.calls.map(([c, o]) => [c.model, o?.hasFallback])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
    ]);
  });

  it('a single-provider chain gets NO hasFallback (patient policy)', () => {
    createLlmClientMock.mockClear();
    createFailoverLlmClient([cfg('only')]);

    expect(createLlmClientMock.mock.calls.map(([c, o]) => [c.model, o?.hasFallback])).toEqual([
      ['only', false],
    ]);
  });
});
