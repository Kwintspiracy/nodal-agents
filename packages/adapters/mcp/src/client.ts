// MCP client — connects to a remote MCP server over Streamable HTTP and
// lists its tools. The caller owns the returned connection and must close()
// it once finished.
//
// stdio transport: future. Only Streamable HTTP is supported today.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type McpAuthScheme = 'header' | 'query' | 'bearer';

export interface McpConnectOptions {
  /** Base MCP server URL (Streamable HTTP endpoint). */
  url: string;
  /** Decrypted API key. Omit for servers that need no auth. */
  apiKey?: string;
  /**
   * How to inject the key. Required when `apiKey` is set.
   * - `header`: `headers[authParamName] = apiKey` (e.g. `x-api-key: <key>`)
   * - `query`: `?<authParamName>=<apiKey>` appended to the URL
   * - `bearer`: `headers['Authorization'] = 'Bearer ' + apiKey` (authParamName ignored)
   */
  authScheme?: McpAuthScheme;
  /** Header name or query-param name (e.g. `x-api-key`). Required for `header` and `query`; ignored for `bearer`. */
  authParamName?: string;
}

/** A discovered MCP tool, straight from the server's `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpConnection {
  client: Client;
  tools: McpToolDescriptor[];
  /** Close the underlying transport. Always call this when done. */
  close: () => Promise<void>;
}

/** Resolved HTTP target — the URL (with any query-param key) and headers. */
export interface McpRequestTarget {
  url: URL;
  headers: Record<string, string>;
}

/**
 * Build the request URL + headers for an MCP connection, injecting the API
 * key per the configured auth scheme. Pure and synchronous — unit-testable
 * without a live server.
 */
export function buildMcpRequest(opts: McpConnectOptions): McpRequestTarget {
  const url = new URL(opts.url);
  const headers: Record<string, string> = {};

  if (opts.apiKey) {
    if (!opts.authScheme) {
      throw new Error('buildMcpRequest: authScheme is required when apiKey is set');
    }
    if (opts.authScheme === 'bearer') {
      headers['Authorization'] = `Bearer ${opts.apiKey}`;
    } else {
      if (!opts.authParamName) {
        throw new Error(
          `buildMcpRequest: authParamName is required when authScheme is '${opts.authScheme}'`,
        );
      }
      if (opts.authScheme === 'query') {
        url.searchParams.set(opts.authParamName, opts.apiKey);
      } else {
        headers[opts.authParamName] = opts.apiKey;
      }
    }
  }

  return { url, headers };
}

/**
 * Connect to an MCP server over Streamable HTTP and list its tools.
 * Throws on connection failure or auth rejection.
 */
export async function connectMcp(opts: McpConnectOptions): Promise<McpConnection> {
  const target = buildMcpRequest(opts);

  const transport = new StreamableHTTPClientTransport(target.url, {
    requestInit: { headers: target.headers },
  });

  const client = new Client({ name: 'nodal-agents', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);

  const listed = await client.listTools();
  const tools: McpToolDescriptor[] = (listed.tools ?? []).map((t) => ({
    name: t.name,
    description: typeof t.description === 'string' ? t.description : undefined,
    inputSchema: t.inputSchema,
    annotations: t.annotations as McpToolDescriptor['annotations'],
  }));

  return {
    client,
    tools,
    close: async () => {
      await client.close();
    },
  };
}
