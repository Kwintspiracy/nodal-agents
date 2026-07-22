// @nodal-agents/adapter-outlook-mail — client factory tests

import { describe, it, expect, vi } from 'vitest';
import { createOutlookClient, ResolvedAccessTokenProvider, TimeoutMiddleware } from '../client';
import type { Middleware, Context } from '@microsoft/microsoft-graph-client';

describe('ResolvedAccessTokenProvider', () => {
  // M-12-equivalent for Outlook: the provider must NOT capture/cache a single
  // token — every getAccessToken() call must re-invoke the resolver, so a job
  // outliving the ~1h Microsoft token TTL still gets a live token via the
  // runner's advisory-lock refresh path.
  it('invokes the resolver on every getAccessToken() call — not cached', async () => {
    let calls = 0;
    const provider = new ResolvedAccessTokenProvider(async () => {
      calls++;
      return `token-${calls}`;
    });

    const first = await provider.getAccessToken();
    expect(first).toBe('token-1');
    expect(calls).toBe(1);

    const second = await provider.getAccessToken();
    expect(second).toBe('token-2');
    expect(calls).toBe(2);
  });
});

describe('TimeoutMiddleware', () => {
  it('resolves normally when the next middleware finishes before the timeout', async () => {
    const middleware = new TimeoutMiddleware(50);
    const next: Middleware = { execute: vi.fn().mockResolvedValue(undefined) };
    middleware.setNext(next);

    await expect(middleware.execute({} as Context)).resolves.toBeUndefined();
    expect(next.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects with a timeout error when the next middleware hangs past timeoutMs', async () => {
    const middleware = new TimeoutMiddleware(20);
    const next: Middleware = { execute: () => new Promise(() => {}) }; // never resolves
    middleware.setNext(next);

    await expect(middleware.execute({} as Context)).rejects.toThrow(/outlook_request_timeout/);
  });

  it('throws if executed before setNext is called', async () => {
    const middleware = new TimeoutMiddleware(20);
    await expect(middleware.execute({} as Context)).rejects.toThrow(
      /no next middleware configured/,
    );
  });

  it("propagates the next middleware's rejection unchanged, not swallowed by the race", async () => {
    const middleware = new TimeoutMiddleware(1000);
    const next: Middleware = { execute: () => Promise.reject(new Error('graph 500')) };
    middleware.setNext(next);

    await expect(middleware.execute({} as Context)).rejects.toThrow('graph 500');
  });

  // review MINOR-2: the timeout must actually cancel the in-flight request
  // (via context.options.signal), not just abandon our own wait on it —
  // otherwise the underlying fetch keeps running and leaks a socket.
  it('wires a fresh AbortSignal into context.options before calling next', async () => {
    const middleware = new TimeoutMiddleware(1000);
    let seenSignal: AbortSignal | undefined;
    const next: Middleware = {
      execute: async (ctx) => {
        seenSignal = ctx.options?.signal ?? undefined;
      },
    };
    middleware.setNext(next);

    const context = { request: 'https://graph.microsoft.com/v1.0/me', options: {} } as Context;
    await middleware.execute(context);

    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });

  it('aborts the signal passed to next when the timeout fires', async () => {
    const middleware = new TimeoutMiddleware(20);
    let capturedSignal: AbortSignal | undefined;
    const next: Middleware = {
      execute: (ctx) => {
        capturedSignal = ctx.options?.signal ?? undefined;
        return new Promise(() => {}); // never resolves — only the abort matters
      },
    };
    middleware.setNext(next);

    const context = { request: 'https://graph.microsoft.com/v1.0/me', options: {} } as Context;
    await expect(middleware.execute(context)).rejects.toThrow(/outlook_request_timeout/);

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('preserves other context.options fields when injecting the signal', async () => {
    const middleware = new TimeoutMiddleware(1000);
    let seenOptions: Context['options'];
    const next: Middleware = {
      execute: async (ctx) => {
        seenOptions = ctx.options;
      },
    };
    middleware.setNext(next);

    const context = {
      request: 'https://graph.microsoft.com/v1.0/me',
      options: { method: 'GET', headers: { Authorization: 'Bearer x' } },
    } as Context;
    await middleware.execute(context);

    expect(seenOptions?.method).toBe('GET');
    expect((seenOptions?.headers as Record<string, string>)?.Authorization).toBe('Bearer x');
  });
});

describe('createOutlookClient', () => {
  it('returns a Client instance with an api() entry point', () => {
    const client = createOutlookClient(async () => 'fake-token');
    expect(client).toBeDefined();
    expect(typeof client.api).toBe('function');
  });

  it('creates distinct instances per call', () => {
    const a = createOutlookClient(async () => 'token-a');
    const b = createOutlookClient(async () => 'token-b');
    expect(a).not.toBe(b);
  });

  it('accepts any resolver returning a string (validation is API-side)', () => {
    expect(() => createOutlookClient(async () => 'any-token')).not.toThrow();
  });
});
