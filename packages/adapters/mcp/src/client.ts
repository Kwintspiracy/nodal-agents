// MCP client — connects to a remote or local MCP server and lists its tools.
// Two transports supported:
//   - 'http' : Streamable HTTP (remote hosted servers — Stripe, Cogni, etc.)
//   - 'stdio': local subprocess via stdin/stdout pipes (filesystem, sqlite,
//             github, fetch and most Anthropic-published reference servers)
//
// The caller owns the returned connection and must call `close()` on it once
// finished. For stdio that also tears down the spawned subprocess.

import { lookup as dnsLookupCb } from 'node:dns';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildChildEnv } from '@nodal-agents/tools';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';

const dnsLookup = promisify(dnsLookupCb);

// F7 (audit sécu 2026-07-07): SSRF guard on the HTTP MCP server URL. connectMcp
// is the single chokepoint for BOTH config paths (the web action AND an agent's
// create_mcp tool), so the guard lives here. We block ONLY link-local / cloud
// metadata (169.254.x, metadata.google.internal, …) — the IAM-credential-theft
// vector when the runner sits in a cloud — while allowing loopback and RFC1918,
// which are legitimate for a local/LAN MCP server. DNS is resolved so a hostname
// can't mask a blocked target.
const BLOCKED_MCP_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog', 'metadata']);

function isBlockedMcpAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  if (/^169\.254\./.test(a)) return true; // IPv4 link-local (incl. …169.254 metadata)
  if (a === '100.100.100.100') return true; // Alibaba metadata
  if (a.startsWith('fe80:')) return true; // IPv6 link-local
  if (a === 'fd00:ec2::254') return true; // AWS IMDS over IPv6
  return false;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

export async function assertMcpHttpUrlSafe(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_MCP_HOSTNAMES.has(hostname) || isBlockedMcpAddress(hostname)) {
    throw new Error(`MCP URL blocked: "${hostname}" is a link-local / cloud-metadata endpoint.`);
  }
  // An IP literal was already checked above — no DNS to resolve (and no real
  // network I/O in unit tests, which would otherwise hang under fake timers).
  if (isIpLiteral(hostname)) return;
  let resolved: Array<{ address: string }>;
  try {
    resolved = await dnsLookup(hostname, { all: true });
  } catch {
    return; // a DNS failure is not a security decision — the real connect fails on its own
  }
  for (const { address } of resolved) {
    if (isBlockedMcpAddress(address)) {
      throw new Error(
        `MCP URL blocked: "${hostname}" resolves to a link-local / cloud-metadata address.`,
      );
    }
  }
}

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
  // P0-H7 (causality study): the http branch gets its own dedicated undici
  // Agent, closed alongside the client in McpConnection.close. Set only when
  // transport === 'http' — stdio has no HTTP dispatcher to isolate.
  let httpAgent: UndiciAgent | undefined;

  if (opts.transport === 'http') {
    const target = buildMcpRequest(opts);
    await assertMcpHttpUrlSafe(target.url); // F7: reject link-local / cloud-metadata targets
    // P0-H7: the MCP SDK's StreamableHTTPClientTransport opens a long-lived
    // GET (SSE) after connect. On Node's global fetch dispatcher, that GET
    // holding a connection open (or hanging mid-handshake on a misbehaving
    // remote server) starves the pool and wedges the subsequent tool-call
    // POSTs to the same origin — every call to that server then blocks until
    // the SDK's own 60s request timeout (-32001), freezing the agent. Giving
    // the transport its own undici Agent (connections: 16) decouples it from
    // the global dispatcher entirely, so a hung GET can no longer starve
    // POSTs. Prototype-proven (causality study P0-H7): 5/5 listTools <2s
    // against a hung server; a healthy long-lived SSE stream is unaffected
    // because fetch() resolves on response headers, not body completion.
    httpAgent = new UndiciAgent({ connections: 16 });
    // StreamableHTTPClientTransport's `fetch` option is typed against the
    // global lib.dom `fetch`; undici's `fetch`/`Response` are structurally
    // close but not nominally identical (e.g. Headers iterator typing), so
    // this needs an `unknown` round-trip cast, same as the H7 prototype.
    const dedicatedFetch = ((input: unknown, init: unknown) =>
      undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        { ...(init as Record<string, unknown>), dispatcher: httpAgent } as Parameters<
          typeof undiciFetch
        >[1],
      )) as unknown as typeof fetch;
    const transport = new StreamableHTTPClientTransport(target.url, {
      requestInit: { headers: target.headers },
      fetch: dedicatedFetch,
    });
    await withTimeout(
      client.connect(transport),
      connectTimeoutMs,
      `MCP connect (${target.url.hostname})`,
      () => {
        safeCloseTransport(transport);
        httpAgent?.close().catch(() => {
          // best-effort — the connect attempt is already reported as failed
          // via the timeout error, so an agent-close failure isn't fatal.
        });
      },
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
      // P0-H7: release the dedicated undici Agent's connection pool.
      await httpAgent?.close();
    },
  };
}
