import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  listTools: vi.fn(),
  close: vi.fn(async () => {}),
  transportClose: vi.fn(async () => {}),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = h.connect;
    listTools = h.listTools;
    close = h.close;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    close = h.transportClose;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  // Capturing the constructor args lets the stdio test inspect what the
  // adapter passed to the SDK without actually spawning a subprocess.
  StdioClientTransport: vi.fn().mockImplementation(function (
    this: { args: unknown; close: unknown },
    a: unknown,
  ) {
    this.args = a;
    this.close = h.transportClose;
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
  // spawns a subprocess. audit#2 C-1: un serveur MCP tiers (npx/uvx) est un
  // binaire arbitraire — il ne doit recevoir QUE l'env scrubbé (allowlist
  // buildChildEnv, cf. packages/tools/src/builtin/child-env.ts) plus les
  // variables explicites du connecteur (opts.env), jamais le process.env
  // complet du runner.

  it('builds a stdio transport with command, args, and a scrubbed env (opts.env still merges)', async () => {
    h.listTools.mockResolvedValue({ tools: [] });
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const ctorMock = StdioClientTransport as unknown as ReturnType<typeof vi.fn>;
    ctorMock.mockClear();

    // Non-allowlisted var (a made-up plumbing name) must NOT reach the child.
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
    // opts.env (connector-scoped, explicitly intended) always flows through.
    expect(arg.env.GITHUB_TOKEN).toBe('ghp_secret');
    // A random process.env var is NOT allowlisted plumbing — scrubbed out.
    expect(arg.env.TEST_PATH_SENTINEL).toBeUndefined();
    // PATH itself IS allowlisted plumbing — still resolves for the child.
    expect(arg.env.PATH ?? arg.env.Path).toBeTruthy();

    delete process.env['TEST_PATH_SENTINEL'];
  });

  it('user env overrides the scrubbed env on collision', async () => {
    h.listTools.mockResolvedValue({ tools: [] });
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const ctorMock = StdioClientTransport as unknown as ReturnType<typeof vi.fn>;
    ctorMock.mockClear();

    const savedPath = process.env['PATH'];
    process.env['PATH'] = '/system/bin';

    await connectMcp({
      transport: 'stdio',
      command: 'node',
      args: [],
      env: { PATH: '/user/bin' },
    });

    const arg = ctorMock.mock.calls[0]?.[0] as { env: Record<string, string> };
    expect(arg.env.PATH).toBe('/user/bin');

    process.env['PATH'] = savedPath;
  });

  // Regression for audit#2 C-1: a stdio MCP child process used to inherit
  // process.env WHOLESALE (`{ ...process.env, ...opts.env }`), handing a
  // third-party npx/uvx binary the runner's secrets. Assert the scrubber is
  // actually wired in — the exact secrets named in the finding must be absent
  // even though they're set on process.env for this test.
  it('does NOT leak WORKER_SECRET or DATABASE_URL from process.env to the spawned MCP server', async () => {
    h.listTools.mockResolvedValue({ tools: [] });
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const ctorMock = StdioClientTransport as unknown as ReturnType<typeof vi.fn>;
    ctorMock.mockClear();

    process.env['WORKER_SECRET'] = 'wsec_super_secret';
    process.env['DATABASE_URL'] = 'postgres://user:pw@host/db';

    await connectMcp({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-community-mcp-server'],
      env: { CONNECTOR_TOKEN: 'connector-scoped-token' },
    });

    const arg = ctorMock.mock.calls[0]?.[0] as { env: Record<string, string> };
    // Runner-wide secrets from process.env must be scrubbed.
    expect(arg.env.WORKER_SECRET).toBeUndefined();
    expect(arg.env.DATABASE_URL).toBeUndefined();
    // Allowlisted OS/shell plumbing still reaches the child.
    expect(arg.env.PATH ?? arg.env.Path).toBeTruthy();
    // The connector's own explicit env (opts.env) is the intended exception —
    // it's scoped to this one server, not the runner's whole process.env.
    expect(arg.env.CONNECTOR_TOKEN).toBe('connector-scoped-token');

    delete process.env['WORKER_SECRET'];
    delete process.env['DATABASE_URL'];
  });
});

// audit#2 M-15: establishing the transport has no built-in SDK timeout —
// unlike listTools, which the SDK itself bounds. A server/command that never
// completes the handshake must not hang connectMcp (and the job) forever.
//
// Default bound is 120s, NOT 30s: a regression report found that connecting
// to a stdio MCP server via npx/uvx on a cold cache (first launch, or a
// community server with heavy deps like Playwright pulling a browser binary)
// can legitimately take well over 30s. 120s bounds the hang without breaking
// that central use case (MCP/community skill catalog). MCP_CONNECT_TIMEOUT_MS
// overrides the default for servers that need even longer.
describe('connectMcp — connect timeout (M-15)', () => {
  beforeEach(() => {
    h.connect.mockClear();
    h.listTools.mockReset();
    h.close.mockClear();
    h.transportClose.mockClear();
  });

  afterEach(() => {
    // Restore the default (immediately-resolving) connect implementation so
    // later tests in this file aren't affected by the "never resolves" stub.
    h.connect.mockImplementation(async () => {});
    delete process.env['MCP_CONNECT_TIMEOUT_MS'];
    vi.useRealTimers();
  });

  it('rejects with a clear timeout error and closes the transport when connect() never resolves (http)', async () => {
    vi.useFakeTimers();
    h.connect.mockImplementation(() => new Promise(() => {}));

    const promise = connectMcp({ transport: 'http', url: 'https://x.example.com/api/mcp' });
    const assertion = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;

    expect(h.transportClose).toHaveBeenCalledOnce();
  });

  it('rejects with a clear timeout error and closes the transport (kills the subprocess) when connect() never resolves (stdio)', async () => {
    vi.useFakeTimers();
    h.connect.mockImplementation(() => new Promise(() => {}));

    const promise = connectMcp({
      transport: 'stdio',
      command: 'some-hanging-command',
      args: [],
      env: {},
    });
    const assertion = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;

    expect(h.transportClose).toHaveBeenCalledOnce();
  });

  it('does NOT time out a connect() that resolves within 60s (would have failed under the old 30s bound)', async () => {
    vi.useFakeTimers();
    let resolveConnect: () => void = () => {};
    h.connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    h.listTools.mockResolvedValue({ tools: [] });

    const promise = connectMcp({ transport: 'http', url: 'https://x.example.com/api/mcp' });

    // Simulate a slow-but-legitimate cold start (e.g. npx pulling a package)
    // finishing at 60s — well past the old 30s cutoff, well within the new
    // 120s one.
    await vi.advanceTimersByTimeAsync(60_000);
    resolveConnect();

    const conn = await promise;
    expect(conn.tools).toEqual([]);
    expect(h.transportClose).not.toHaveBeenCalled();
  });

  it('MCP_CONNECT_TIMEOUT_MS overrides the default connect timeout', async () => {
    process.env['MCP_CONNECT_TIMEOUT_MS'] = '5000';
    vi.useFakeTimers();
    h.connect.mockImplementation(() => new Promise(() => {}));

    const promise = connectMcp({ transport: 'http', url: 'https://x.example.com/api/mcp' });
    const assertion = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    expect(h.transportClose).toHaveBeenCalledOnce();
  });
});
