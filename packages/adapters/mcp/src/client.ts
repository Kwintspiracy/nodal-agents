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
import { buildChildEnv } from '@nodal-agents/tools';

// audit#2 M-15: establishing the transport (HTTP handshake, or spawning a
// stdio subprocess) has no built-in timeout in the SDK — unlike client
// requests (listTools included), which the SDK itself bounds via
// DEFAULT_REQUEST_TIMEOUT_MSEC (60s). A server that accepts the connection
// but never completes the handshake, or a stdio command that spawns but
// never signals ready, would hang connectMcp — and the job — forever.
//
// Default raised from an initial 30s to 120s after a regression report:
// connecting to a stdio MCP server via `npx`/`uvx` on a COLD cache (first
// launch, or a community server with heavy deps like Playwright pulling a
// browser binary) can legitimately take well over 30s — sometimes several
// minutes. Before M-15, this had no bound at all and eventually succeeded;
// a 30s cutoff would have broken that central use case (the MCP/community
// skill catalog) instead of just bounding a genuine infinite hang. 120s
// bounds the hang while leaving room for a cold warmup. Override via
// MCP_CONNECT_TIMEOUT_MS for servers that legitimately need longer.
const DEFAULT_CONNECT_TIMEOUT_MS = 120_000;

function resolveConnectTimeoutMs(): number {
  const raw = process.env['MCP_CONNECT_TIMEOUT_MS'];
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONNECT_TIMEOUT_MS;
}

// Explicit, defense-in-depth bound for listTools, matching (not tightening)
// the SDK's own DEFAULT_REQUEST_TIMEOUT_MSEC — a server that computes its
// capabilities dynamically can legitimately take 30-60s here too.
const LIST_TOOLS_TIMEOUT_MS = 60_000;

/**
 * Race a promise against a timeout, closing the given transport (killing the
 * stdio subprocess / releasing the HTTP transport) if the timeout wins so a
 * hung connect attempt doesn't leak resources.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Best-effort transport teardown after a connect timeout — never throws. */
function safeCloseTransport(transport: { close?: () => Promise<void> }): void {
  transport.close?.()?.catch(() => {
    // best-effort cleanup (releases the HTTP transport / kills the spawned
    // stdio subprocess) — the connect attempt is already being reported as
    // failed via the timeout error, so a close failure here is not fatal.
  });
}

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
  const connectTimeoutMs = resolveConnectTimeoutMs();

  if (opts.transport === 'http') {
    const target = buildMcpRequest(opts);
    const transport = new StreamableHTTPClientTransport(target.url, {
      requestInit: { headers: target.headers },
    });
    await withTimeout(
      client.connect(transport),
      connectTimeoutMs,
      `MCP connect (${target.url.hostname})`,
      () => safeCloseTransport(transport),
    );
  } else {
    // audit#2 C-1: un serveur MCP tiers lancé via npx/uvx est un binaire
    // arbitraire — il ne doit PAS hériter du process.env complet du runner
    // (WORKER_SECRET, DATABASE_URL, clés LLM/OAuth...). On passe par le même
    // scrubber allowlist que run_command/run_skill_script (buildChildEnv) :
    // seuls PATH et le plumbing OS/shell (HOME, APPDATA, LOCALAPPDATA...)
    // traversent, plus les variables explicites du connecteur (opts.env, ex.
    // token du connecteur) qui restent voulues et gagnent sur collision.
    //
    // Filtrage des `undefined` — la SDK typing StdioServerParameters attend
    // `Record<string, string>` strict, buildChildEnv retourne `string | undefined`.
    const scrubbedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(buildChildEnv(process.env))) {
      if (typeof v === 'string') scrubbedEnv[k] = v;
    }
    const transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      env: { ...scrubbedEnv, ...opts.env },
    });
    await withTimeout(
      client.connect(transport),
      connectTimeoutMs,
      `MCP connect (${opts.command})`,
      () => safeCloseTransport(transport),
    );
  }

  const listed = await client.listTools(undefined, { timeout: LIST_TOOLS_TIMEOUT_MS });
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
