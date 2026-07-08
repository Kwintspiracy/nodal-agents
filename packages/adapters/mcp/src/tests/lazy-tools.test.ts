// lazy-tools.test.ts — Lot A3 (lazy MCP connect): createLazyMcpTools must
// build a real toolset from a cached descriptor list WITHOUT connecting, and
// only pay the connect cost on the first actual tool call.

import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpConnection, McpToolDescriptor } from '../client.ts';

const h = vi.hoisted(() => ({ connectMcp: vi.fn() }));

vi.mock('../client.ts', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('../client.ts')>();
  return { ...actual, connectMcp: h.connectMcp };
});

import { createLazyMcpTools } from '../index.ts';

const cachedDescriptors: McpToolDescriptor[] = [
  {
    name: 'get_home',
    description: 'Return the home view',
    inputSchema: { type: 'object', properties: { detail: { type: 'boolean' } } },
    annotations: { readOnlyHint: true },
  },
];

function fakeConnection(overrides?: Partial<McpConnection>): McpConnection {
  return {
    client: {
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    } as unknown as Client,
    tools: cachedDescriptors,
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('createLazyMcpTools', () => {
  it('builds the toolset synchronously from the cache — connectMcp is never called at build time', () => {
    h.connectMcp.mockReset();
    h.connectMcp.mockImplementation(() => {
      throw new Error('connectMcp must not be called at build time');
    });

    const toolset = createLazyMcpTools(
      { transport: 'http', slug: 'cogni-cortex', url: 'https://x.example.com' },
      cachedDescriptors,
    );

    expect(toolset.tools).toHaveLength(1);
    expect(toolset.tools[0]?.name).toBe('cogni_cortex__get_home');
    expect(toolset.tools[0]?.riskLevel).toBe('read');
    expect(toolset.descriptors).toBe(cachedDescriptors);
    expect(h.connectMcp).not.toHaveBeenCalled();
  });

  it('connects on the first execute() and returns the real result; onConnected receives the fresh descriptors', async () => {
    h.connectMcp.mockReset();
    const freshDescriptors: McpToolDescriptor[] = [
      { name: 'get_home', inputSchema: { type: 'object' }, description: 'fresh' },
    ];
    const conn = fakeConnection({ tools: freshDescriptors });
    h.connectMcp.mockResolvedValue(conn);
    const onConnected = vi.fn();

    const toolset = createLazyMcpTools(
      { transport: 'http', slug: 'cogni-cortex', url: 'https://x.example.com' },
      cachedDescriptors,
      { onConnected },
    );

    const out = await toolset.tools[0]!.execute({ detail: true }, {} as never);
    expect(out).toBe('ok');
    expect(h.connectMcp).toHaveBeenCalledOnce();

    // onConnected fires asynchronously off the connect chain — flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(onConnected).toHaveBeenCalledWith(freshDescriptors);
  });

  it('memoizes the connection across concurrent execute() calls — connectMcp is called exactly once', async () => {
    h.connectMcp.mockReset();
    let resolveConnect: (c: McpConnection) => void = () => {};
    h.connectMcp.mockImplementation(
      () =>
        new Promise<McpConnection>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    const toolset = createLazyMcpTools(
      { transport: 'http', slug: 'cogni-cortex', url: 'https://x.example.com' },
      cachedDescriptors,
    );

    const call1 = toolset.tools[0]!.execute({}, {} as never);
    const call2 = toolset.tools[0]!.execute({}, {} as never);
    expect(h.connectMcp).toHaveBeenCalledOnce();

    resolveConnect(fakeConnection());
    const [out1, out2] = await Promise.all([call1, call2]);
    expect(out1).toBe('ok');
    expect(out2).toBe('ok');
    // Still exactly one connect — the second call reused the memoized promise.
    expect(h.connectMcp).toHaveBeenCalledOnce();
  });

  it('a connect failure rejects as a tool error AND is not memoized — the next call can retry', async () => {
    h.connectMcp.mockReset();
    h.connectMcp.mockRejectedValueOnce(new Error('spawn ENOENT'));

    const toolset = createLazyMcpTools(
      { transport: 'stdio', slug: 'broken-server', command: 'uvx', args: [], env: {} },
      [{ name: 'do_thing', inputSchema: { type: 'object' } }],
    );

    await expect(toolset.tools[0]!.execute({}, {} as never)).rejects.toThrow(/spawn ENOENT/);
    expect(h.connectMcp).toHaveBeenCalledOnce();

    // Retry: connectMcp succeeds this time.
    h.connectMcp.mockResolvedValueOnce(fakeConnection());
    const out = await toolset.tools[0]!.execute({}, {} as never);
    expect(out).toBe('ok');
    expect(h.connectMcp).toHaveBeenCalledTimes(2);
  });

  it('close() before any execute() is a no-op — no error, connectMcp never called', async () => {
    h.connectMcp.mockReset();
    h.connectMcp.mockImplementation(() => {
      throw new Error('connectMcp must not be called');
    });

    const toolset = createLazyMcpTools(
      { transport: 'http', slug: 'cogni-cortex', url: 'https://x.example.com' },
      cachedDescriptors,
    );

    await expect(toolset.close()).resolves.toBeUndefined();
    expect(h.connectMcp).not.toHaveBeenCalled();
  });

  it('close() after a real connection closes the live transport', async () => {
    h.connectMcp.mockReset();
    const conn = fakeConnection();
    h.connectMcp.mockResolvedValue(conn);

    const toolset = createLazyMcpTools(
      { transport: 'http', slug: 'cogni-cortex', url: 'https://x.example.com' },
      cachedDescriptors,
    );

    await toolset.tools[0]!.execute({}, {} as never);
    await toolset.close();
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it('close() during an IN-FLIGHT connect awaits it and closes the transport — no orphaned subprocess', async () => {
    h.connectMcp.mockReset();
    const conn = fakeConnection();
    // A connect that resolves only when we say so — simulates a slow cold
    // stdio spawn still underway when the job loop's finally calls close().
    let releaseConnect!: (c: McpConnection) => void;
    h.connectMcp.mockReturnValue(
      new Promise<McpConnection>((resolve) => {
        releaseConnect = resolve;
      }),
    );

    const toolset = createLazyMcpTools(
      { transport: 'http', slug: 'cogni-cortex', url: 'https://x.example.com' },
      cachedDescriptors,
    );

    // Kick off a tool call → connect is now pending. Don't await it.
    const inFlightCall = toolset.tools[0]!.execute({}, {} as never);
    const closing = toolset.close();
    // The connect finishes AFTER close() was requested.
    releaseConnect(conn);

    await closing;
    expect(conn.close).toHaveBeenCalledOnce();
    // The racing tool call still settles (the shared client resolved).
    await expect(inFlightCall).resolves.toBe('ok');
  });

  it('close() after a FAILED connect is a no-op — nothing to close, no throw', async () => {
    h.connectMcp.mockReset();
    h.connectMcp.mockRejectedValue(new Error('spawn refused'));

    const toolset = createLazyMcpTools(
      { transport: 'http', slug: 'cogni-cortex', url: 'https://x.example.com' },
      cachedDescriptors,
    );

    await expect(toolset.tools[0]!.execute({}, {} as never)).rejects.toThrow('spawn refused');
    await expect(toolset.close()).resolves.toBeUndefined();
  });
});
