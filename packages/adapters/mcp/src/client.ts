// MCP client — connects to a remote or local MCP server and lists its tools.
// Two transports supported:
//   - 'http' : Streamable HTTP (remote hosted servers — Stripe, Cogni, etc.)
//   - 'stdio': local subprocess via stdin/stdout pipes (filesystem, sqlite,
//             github, fetch and most Anthropic-published reference servers)
//
// The caller owns the returned connection and must call `close()` on it once
// finished. For stdio that also tears down the spawned subprocess.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export type McpAuthScheme = 'header' | 'query' | 'bearer';

/**
 * Discriminated union of supported transports. Each branch carries only the
 * fields meaningful for its transport — HTTP needs URL+auth, stdio needs
 * command+args+env. No optional "use one or the other" mush.
 */
export type McpConnectOptions =
  | {
      transport: 'http';
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
      /** Header name or query-param name. Required for `header`/`query`; ignored for `bearer`. */
      authParamName?: string;
    }
  | {
      transport: 'stdio';
      /** Executable to spawn — `npx`, `node`, `python`, an absolute path, etc. */
      command: string;
      /** Args passed to the executable. May be empty. */
      args: string[];
      /**
       * Extra env vars merged on top of `process.env` (the system PATH is
       * preserved so the command can be resolved). Values are passed as-is;
       * the caller is responsible for decryption before invoking us.
       */
      env: Record<string, string>;
    };

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
  /** Close the underlying transport. Always call this when done. For stdio,
   *  this also terminates the spawned subprocess. */
  close: () => Promise<void>;
}

/** Resolved HTTP target — the URL (with any query-param key) and headers. */
export interface McpRequestTarget {
  url: URL;
  headers: Record<string, string>;
}

/**
 * Build the request URL + headers for an MCP HTTP connection, injecting the
 * API key per the configured auth scheme. Pure and synchronous —
 * unit-testable without a live server. Only meaningful for `transport: 'http'`;
 * the stdio branch has no URL to build.
 */
export function buildMcpRequest(
  opts: Extract<McpConnectOptions, { transport: 'http' }>,
): McpRequestTarget {
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
 * Connect to an MCP server and list its tools. Throws on connection failure,
 * auth rejection (HTTP), or subprocess spawn failure (stdio).
 */
export async function connectMcp(opts: McpConnectOptions): Promise<McpConnection> {
  const client = new Client({ name: 'nodal-agents', version: '0.1.0' }, { capabilities: {} });

  if (opts.transport === 'http') {
    const target = buildMcpRequest(opts);
    const transport = new StreamableHTTPClientTransport(target.url, {
      requestInit: { headers: target.headers },
    });
    await client.connect(transport);
  } else {
    // Merge user env on top of process.env so PATH (and OS-level vars the
    // MCP server may need, e.g. HOME, APPDATA, LOCALAPPDATA) reach the
    // subprocess. User values win on collision — that's the point of letting
    // them set env.
    //
    // Filter out any undefined entries from process.env before merging — the
    // SDK's StdioServerParameters typing is strict (`Record<string, string>`)
    // and Node's process.env has `string | undefined`.
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') baseEnv[k] = v;
    }
    const transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      env: { ...baseEnv, ...opts.env },
    });
    await client.connect(transport);
  }

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
      // client.close() tears down the transport, which for stdio means
      // closing stdin and waiting for the subprocess to exit. The MCP SDK
      // handles tree-kill on the underlying child_process — on Windows
      // shell:true is NOT used so taskkill /T is unnecessary (the child
      // is spawned directly, no shell intermediary to leak).
      await client.close();
    },
  };
}
