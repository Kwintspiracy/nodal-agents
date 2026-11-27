// connection-failure.ts — the state an MCP connection's failure puts its
// server in. The one mapping for MCP servers, whatever the server: the runner's
// connect (eager and lazy) and the dashboard's verification read it.
//
// By protocol, never by server: an HTTP status from the Streamable HTTP
// transport, the SDK's own authorisation refusal, the operating system's
// error for a command that does not exist, then the network codes every
// transport shares (connection-state.ts).

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  UNREACHABLE_RETRY_MS,
  connectionState,
  httpFailure,
  networkFailure,
  type ConnectionState,
} from '@nodal-agents/shared';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null
    ? (err as Record<string, unknown>)['code']
    : undefined;
}

export function mcpConnectionFailure(err: unknown, now: Date = new Date()): ConnectionState {
  if (err instanceof UnauthorizedError) {
    return connectionState('needs_reauth', 'grant_refused', messageOf(err), now);
  }
  const code = codeOf(err);
  // A Streamable HTTP refusal carries the HTTP status as `code`; a JSON-RPC
  // error carries a negative code. Only the first says something about the key.
  if (typeof code === 'number' && code >= 400 && code <= 599 && !(err instanceof McpError)) {
    const byStatus = httpFailure(code, messageOf(err), now);
    if (byStatus) return byStatus;
    if (code === 403)
      return connectionState('needs_reauth', 'grant_refused', `${code} ${messageOf(err)}`, now);
  }
  // The command is not on this machine (spawn's ENOENT), or the process
  // ended before it said a word (how Windows' `cmd.exe` reports a missing
  // command, and how a server that cannot start ends): the server did not
  // start, and will not until its configuration changes.
  if (
    code === 'ENOENT' ||
    codeOf((err as { cause?: unknown } | null)?.cause) === 'ENOENT' ||
    /ENOENT/.test(messageOf(err)) ||
    (err instanceof McpError &&
      (err.data as { reason?: unknown } | undefined)?.reason === 'MCP_SERVER_EXITED')
  ) {
    return connectionState('broken', 'command_not_found', messageOf(err), now);
  }
  const network = networkFailure(err, now);
  if (network) return network;
  const retryAfter = new Date(now.getTime() + UNREACHABLE_RETRY_MS);
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
    return connectionState('unreachable', 'timeout', messageOf(err), now, retryAfter);
  }
  // A server that closed the connection, or answered something the client
  // could not read: it did not serve this attempt; the next one may.
  return connectionState('unreachable', 'provider_unavailable', messageOf(err), now, retryAfter);
}
