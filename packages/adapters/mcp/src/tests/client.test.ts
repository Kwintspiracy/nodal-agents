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

import { buildMcpRequest, connectMcp } from '../client.ts';

describe('buildMcpRequest', () => {
  it('injects the key as a query param', () => {
    const t = buildMcpRequest({
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
      url: 'https://mcp.stripe.com',
      apiKey: 'sk_live_xyz',
      authScheme: 'bearer',
    });
    expect(t.headers['Authorization']).toBe('Bearer sk_live_xyz');
  });

  it('emits no auth when apiKey is omitted', () => {
    const t = buildMcpRequest({ url: 'https://x.example.com/api/mcp' });
    expect(t.headers).toEqual({});
    expect(t.url.toString()).toBe('https://x.example.com/api/mcp');
  });

  it('throws when apiKey is set without authScheme', () => {
    expect(() => buildMcpRequest({ url: 'https://x.example.com', apiKey: 'k' })).toThrow();
  });

  it('throws when header scheme is set without authParamName', () => {
    expect(() =>
      buildMcpRequest({
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

    const conn = await connectMcp({ url: 'https://x.example.com/api/mcp' });

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
    const conn = await connectMcp({ url: 'https://x.example.com/api/mcp' });
    expect(conn.tools).toEqual([]);
  });
});
