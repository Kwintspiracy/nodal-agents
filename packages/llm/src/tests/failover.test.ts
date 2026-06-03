// failover.test.ts — provider failover chain (Guard 2)
// Asserts REAL behaviour: which provider served the call, the returned value,
// and the loud terminal error — never just call counts.

import { describe, it, expect, vi } from 'vitest';
import { createFailoverFromClients } from '../failover';
import {
  RetryExhaustedError,
  LLMTimeoutError,
  QuotaExhaustedError,
  MessageStructureError,
  AllProvidersFailedError,
} from '../errors';
import type { NodalLlmClient } from '../types';

type GenText = NodalLlmClient['generateText'];

// A minimal fake client. `gen` drives generateText: it returns a value or throws.
function fakeClient(model: string, gen: () => Promise<{ text: string }>): NodalLlmClient {
  return {
    config: { provider: 'openrouter', model },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: vi.fn(gen) as unknown as GenText,
    streamText: (() => {
      throw new Error('streamText not used');
    }) as NodalLlmClient['streamText'],
    generateObject: (() => {
      throw new Error('generateObject not used');
    }) as NodalLlmClient['generateObject'],
  } as unknown as NodalLlmClient;
}

const ARGS = { system: 's', messages: [] } as Parameters<GenText>[0];

describe('createFailoverFromClients', () => {
  it('a single client is returned untouched (no failover wrapping)', () => {
    const only = fakeClient('solo', () => Promise.resolve({ text: 'x' }));
    const client = createFailoverFromClients([only]);
    expect(client).toBe(only);
  });

  it('fails over to the next provider on RetryExhaustedError and returns its result', async () => {
    const primary = fakeClient('primary', () =>
      Promise.reject(new RetryExhaustedError(4, new Error('502'))),
    );
    const backup = fakeClient('backup', () => Promise.resolve({ text: 'served-by-backup' }));
    const client = createFailoverFromClients([primary, backup]);

    const res = (await client.generateText(ARGS)) as unknown as { text: string };
    // The RESULT proves the backup actually served the call (not a count).
    expect(res.text).toBe('served-by-backup');
    expect(primary.generateText).toHaveBeenCalledTimes(1);
    expect(backup.generateText).toHaveBeenCalledTimes(1);
  });

  it('fails over on LLMTimeoutError and on QuotaExhaustedError', async () => {
    const timeoutPrimary = fakeClient('p', () =>
      Promise.reject(new LLMTimeoutError('openrouter', 'p', 300000)),
    );
    const quotaMid = fakeClient('q', () =>
      Promise.reject(new QuotaExhaustedError('openrouter', 'q', 'billing')),
    );
    const backup = fakeClient('b', () => Promise.resolve({ text: 'ok' }));
    const client = createFailoverFromClients([timeoutPrimary, quotaMid, backup]);

    const res = (await client.generateText(ARGS)) as unknown as { text: string };
    expect(res.text).toBe('ok');
    expect(timeoutPrimary.generateText).toHaveBeenCalledTimes(1);
    expect(quotaMid.generateText).toHaveBeenCalledTimes(1);
    expect(backup.generateText).toHaveBeenCalledTimes(1);
  });

  it('throws AllProvidersFailedError when every provider is down', async () => {
    const a = fakeClient('a', () => Promise.reject(new LLMTimeoutError('openrouter', 'a', 1000)));
    const b = fakeClient('b', () => Promise.reject(new RetryExhaustedError(4, new Error('503'))));
    const client = createFailoverFromClients([a, b]);

    await expect(client.generateText(ARGS)).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(a.generateText).toHaveBeenCalledTimes(1);
    expect(b.generateText).toHaveBeenCalledTimes(1);
  });

  it('a deterministic error (MessageStructureError) propagates without failover', async () => {
    const primary = fakeClient('primary', () =>
      Promise.reject(new MessageStructureError('unmatched_tool_use', {})),
    );
    const backup = fakeClient('backup', () => Promise.resolve({ text: 'should-not-run' }));
    const client = createFailoverFromClients([primary, backup]);

    await expect(client.generateText(ARGS)).rejects.toBeInstanceOf(MessageStructureError);
    // The backup must NOT be tried — a malformed request fails identically there.
    expect(backup.generateText).not.toHaveBeenCalled();
  });

  it('is sticky: after failing over, the next call starts at the working provider', async () => {
    let primaryCalls = 0;
    const primary = fakeClient('primary', () => {
      primaryCalls += 1;
      return Promise.reject(new RetryExhaustedError(4, new Error('502')));
    });
    const backup = fakeClient('backup', () => Promise.resolve({ text: 'backup' }));
    const client = createFailoverFromClients([primary, backup]);

    await client.generateText(ARGS); // call 1: primary fails → backup serves
    await client.generateText(ARGS); // call 2: should start at backup, skip primary

    expect(primaryCalls).toBe(1); // primary tried only on the first call
    expect(backup.generateText).toHaveBeenCalledTimes(2);
  });
});
