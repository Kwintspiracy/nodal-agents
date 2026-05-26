import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  listTools: vi.fn(),
  close: vi.fn(async () => {}),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = h.connect;
    listTools = h.listTools;
    close = h.close;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  // Capturing the constructor args lets the stdio test inspect what the
  // adapter passed to the SDK without actually spawning a subprocess.
  StdioClientTransport: vi.fn().mockImplementation(function (this: { args: unknown }, a: unknown) {
    this.args = a;
  }),
}));

import { buildMcpRequest, connectMcp } from '../client.ts';

describe('buildMcpRequest', () => {
  it('injects the key as a query param', () => {
    const t = buildMcpRequest({
      transport: 'http',
      url: 'https://x.example.com/api/mcp',
      apiKey: 'cog_secret',
      authScheme: 'query',
      authParamName: 'api_key',
    });
    expect(t.url.searchParams.get('api_key')).toBe('cog_secret');
    expect(t.headers).toEqual({});
  });

  it('injects the key as a request header', () => {
    const t = buildMcpRequest({
      transport: 'http',
      url: 'https://x.example.com/api/mcp',
      apiKey: 'cog_secret',
      authScheme: 'header',
      authParamName: 'x-api-key',
    });
    expect(t.headers['x-api-key']).toBe('cog_secret');
    expect(t.url.searchParams.get('x-api-key')).toBeNull();
  });

  it('injects the key as a bearer Authorization header', () => {
    const t = buildMcpRequest({
      transport: 'http',
      url: 'https://mcp.stripe.com',
      apiKey: 'sk_test_123',
      authScheme: 'bearer',
      authParamName: 'Authorization', // ignored for bearer, kept for type stability
    });
    expect(t.headers['Authorization']).toBe('Bearer sk_test_123');
    expect(t.url.searchParams.get('Authorization')).toBeNull();
  });

  it('bearer scheme does not require authParamName', () => {
    const t = buildMcpRequest({
      transport: 'http',
      url: 'https://mcp.stripe.com',
      apiKey: 'sk_live_xyz',
      authScheme: 'bearer',
    });
    expect(t.headers['Authorization']).toBe('Bearer sk_live_xyz');
  });

  it('emits no auth when apiKey is omitted', () => {
    const t = buildMcpRequest({ transport: 'http', url: 'https://x.example.com/api/mcp' });
    expect(t.headers).toEqual({});
    expect(t.url.toString()).toBe('https://x.example.com/api/mcp');
  });

  it('throws when apiKey is set without authScheme', () => {
    expect(() =>
      buildMcpRequest({ transport: 'http', url: 'https://x.example.com', apiKey: 'k' }),
    ).toThrow();
  });

  it('throws when header scheme is set without authParamName', () => {
    expect(() =>
      buildMcpRequest({
        transport: 'http',
        url: 'https://x.example.com',
        apiKey: 'k',
        authScheme: 'header',
      }),
    ).toThrow();
  });
});

describe('connectMcp', () => {
  beforeEach(() => {
    h.connect.mockClear();
    h.listTools.mockReset();
    h.close.mockClear();
  });

  it('connects, lists tools, and maps the descriptors', async () => {
    h.listTools.mockResolvedValue({
      tools: [
        {
          name: 'get_home',
          description: 'home view',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        },
      ],
    });

    const conn = await connectMcp({
      transport: 'http',
      url: 'https://x.example.com/api/mcp',
    });

    expect(h.connect).toHaveBeenCalledOnce();
    expect(conn.tools).toHaveLength(1);
    expect(conn.tools[0]?.name).toBe('get_home');
    expect(conn.tools[0]?.description).toBe('home view');
    expect(conn.tools[0]?.annotations?.readOnlyHint).toBe(true);

    await conn.close();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('returns an empty tool list when the server lists none', async () => {
    h.listTools.mockResolvedValue({ tools: [] });
    const conn = await connectMcp({
      transport: 'http',
      url: 'https://x.example.com/api/mcp',
    });
    expect(conn.tools).toEqual([]);
  });

  // ── stdio transport ────────────────────────────────────────────────────────
  // The SDK's StdioClientTransport is mocked above so the test never actually
  // spawns a subprocess. We verify two things: (1) the adapter passes
  // command/args/env through verbatim, and (2) the user env is merged on top
  // of process.env so PATH still resolves.

  it('builds a stdio transport with command, args, and merged env', async () => {
    h.listTools.mockResolvedValue({ tools: [] });
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const ctorMock = StdioClientTransport as unknown as ReturnType<typeof vi.fn>;
    ctorMock.mockClear();

    process.env['TEST_PATH_SENTINEL'] = '/usr/local/bin';

    await connectMcp({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { GITHUB_TOKEN: 'ghp_secret' },
    });

    expect(ctorMock).toHaveBeenCalledOnce();
    const arg = ctorMock.mock.calls[0]?.[0] as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(arg.command).toBe('npx');
    expect(arg.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    // User env wins on collision; process.env values flow through.
    expect(arg.env.GITHUB_TOKEN).toBe('ghp_secret');
    expect(arg.env.TEST_PATH_SENTINEL).toBe('/usr/local/bin');

    delete process.env['TEST_PATH_SENTINEL'];
  });

  it('user env overrides process.env on collision', async () => {
    h.listTools.mockResolvedValue({ tools: [] });
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const ctorMock = StdioClientTransport as unknown as ReturnType<typeof vi.fn>;
    ctorMock.mockClear();

    process.env['SHARED_KEY'] = 'system-value';

    await connectMcp({
      transport: 'stdio',
      command: 'node',
      args: [],
      env: { SHARED_KEY: 'user-value' },
    });

    const arg = ctorMock.mock.calls[0]?.[0] as { env: Record<string, string> };
    expect(arg.env.SHARED_KEY).toBe('user-value');

    delete process.env['SHARED_KEY'];
  });
});
