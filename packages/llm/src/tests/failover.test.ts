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

type StreamText = NodalLlmClient['streamText'];

// A minimal fake client for streamText tests. `stream` drives streamText: it
// returns a value synchronously or throws synchronously — mirroring the one
// failure class runStreamFailoverSync can act on (see failover.ts).
function fakeStreamClient(model: string, stream: () => unknown): NodalLlmClient {
  return {
    config: { provider: 'openrouter', model },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: true,
    },
    generateText: (() => {
      throw new Error('generateText not used');
    }) as unknown as GenText,
    streamText: vi.fn(stream) as unknown as StreamText,
    generateObject: (() => {
      throw new Error('generateObject not used');
    }) as NodalLlmClient['generateObject'],
  } as unknown as NodalLlmClient;
}

const STREAM_ARGS = { system: 's', messages: [] } as Parameters<StreamText>[0];

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

  it('config reflects the ACTIVE provider after a failover, not the frozen primary (F2)', async () => {
    const primary = fakeClient('primary-model', () =>
      Promise.reject(new RetryExhaustedError(4, new Error('502'))),
    );
    const backup = fakeClient('backup-model', () => Promise.resolve({ text: 'ok' }));
    const client = createFailoverFromClients([primary, backup]);

    // Before any call the active provider is the primary.
    expect(client.config.model).toBe('primary-model');

    await client.generateText(ARGS); // sticks to backup

    // After the failover, config.model must be the backup's — the runner reads
    // this to size the cost cap ($) and the compaction context window per model.
    expect(client.config.model).toBe('backup-model');
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

describe('createFailoverFromClients — streamText', () => {
  it('fails over to the next provider when establishing the stream throws synchronously', () => {
    const primary = fakeStreamClient('primary', () => {
      throw new RetryExhaustedError(4, new Error('502'));
    });
    const backup = fakeStreamClient('backup', () => ({ marker: 'served-by-backup' }));
    const client = createFailoverFromClients([primary, backup]);

    // streamText is synchronous — no await. The RESULT proves the backup
    // actually served the call.
    const res = client.streamText(STREAM_ARGS) as unknown as { marker: string };
    expect(res.marker).toBe('served-by-backup');
    expect(primary.streamText).toHaveBeenCalledTimes(1);
    expect(backup.streamText).toHaveBeenCalledTimes(1);
  });

  it('a deterministic error (MessageStructureError) propagates without failover for streamText', () => {
    const primary = fakeStreamClient('primary', () => {
      throw new MessageStructureError('unmatched_tool_use', {});
    });
    const backup = fakeStreamClient('backup', () => ({ marker: 'should-not-run' }));
    const client = createFailoverFromClients([primary, backup]);

    expect(() => client.streamText(STREAM_ARGS)).toThrow(MessageStructureError);
    expect(backup.streamText).not.toHaveBeenCalled();
  });

  it('throws AllProvidersFailedError when every provider fails to establish the stream', () => {
    const a = fakeStreamClient('a', () => {
      throw new LLMTimeoutError('openrouter', 'a', 1000);
    });
    const b = fakeStreamClient('b', () => {
      throw new RetryExhaustedError(4, new Error('503'));
    });
    const client = createFailoverFromClients([a, b]);

    expect(() => client.streamText(STREAM_ARGS)).toThrow(AllProvidersFailedError);
    expect(a.streamText).toHaveBeenCalledTimes(1);
    expect(b.streamText).toHaveBeenCalledTimes(1);
  });

  it('is sticky: after failing over, the next streamText call starts at the working provider', () => {
    let primaryCalls = 0;
    const primary = fakeStreamClient('primary', () => {
      primaryCalls += 1;
      throw new RetryExhaustedError(4, new Error('502'));
    });
    const backup = fakeStreamClient('backup', () => ({ marker: 'backup' }));
    const client = createFailoverFromClients([primary, backup]);

    client.streamText(STREAM_ARGS); // call 1: primary fails → backup serves
    client.streamText(STREAM_ARGS); // call 2: should start at backup, skip primary

    expect(primaryCalls).toBe(1);
    expect(backup.streamText).toHaveBeenCalledTimes(2);
  });
});
