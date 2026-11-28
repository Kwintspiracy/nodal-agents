// connector-connections.ts — a job's native connectors, each with its
// connection state (connection-state.ts in @nodal-agents/shared).
//
// At job start nothing reaches a provider: the connector's rows are read
// (its key or its credential, decrypted without refresh), with what was
// learnt about them before (`connection_states`). One combination decides
// (`connectorConnection`, then `connectorAccessFor`, the dashboard's rule
// too): a connector that can work lends its tools; one that cannot (its grant
// refused, its credential deleted, its secret unreadable, none of its rights
// granted) lends none and is returned in `withheld`, which the job's context
// names with its state. It never disappears in silence.
//
// The credential is read when a tool is about to call its provider (the
// resolver, `getDecryptedCredentialById`, which refreshes and records what the
// token endpoint answered). A call's outcome is recorded where it is learnt:
// the provider's 401 on the credential that carried the token (or the
// connector, for an API key), a 5xx or a transport failure on the connector,
// a success on both. The tool's error ends with the same sentence the next
// job's context will carry.

import { AsyncLocalStorage } from 'node:async_hooks';
import { decrypt } from '@nodal-agents/secrets';
import {
  callFailure,
  classifyCallFailure,
  connectionNoteForModel,
  connectorFailureMessage,
  ConnectorCallError,
  connectionOfAccess,
  connectorConnection,
  ConnectionUnavailableError,
  connectionKey,
  offeredOperations,
  type ConnectionRef,
  type ConnectionState,
} from '@nodal-agents/shared';
import {
  decryptCredentialForDisplay,
  getDecryptedCredentialById,
  readConnectionStates,
  recordConnectionState,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import { ADAPTER_REGISTRY, connectorAccessFor } from '@nodal-agents/runner-adapters';
import type { ConnectorLending } from '@nodal-agents/tools';
import type { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

/** One assignment of a connector to the job's agent, as read from its rows. */
export interface ConnectorAssignment {
  connectorId: string;
  slug: string;
  name: string;
  credentialId: string | null;
  apiKey: string | null;
  enabledOperations: string[] | null;
}

/** A source attached to the agent that this job cannot use, with why. */
export interface WithheldConnection {
  kind: 'connector' | 'mcp_server';
  /** The service and account, as the model reads them. */
  label: string;
  account: string | null;
  connection: ConnectionState;
}

/** The sentence a job's context carries for a withheld source. */
export function withheldNote(w: WithheldConnection): string {
  return connectionNoteForModel({ label: w.label, account: w.account, kind: w.kind }, w.connection);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Append the connection's sentence to a tool's error, keeping the error
 * itself (its class, `code` and `status` are what the gate and the audit read).
 */
function withNote(err: unknown, note: string): unknown {
  if (err instanceof Error) {
    err.message = `${err.message} — ${note}`;
    return err;
  }
  return new Error(`${String(err)} — ${note}`);
}

interface LendContext {
  db: AnyDrizzleDb;
  label: string;
  account: string | null;
  connectorRef: ConnectionRef;
  /** OAuth: the credential that carries the token. */
  credentialRef: ConnectionRef | null;
  /** Rows already recorded `working` in this job (one write per row per job). */
  confirmed: Set<string>;
}

/**
 * The connection failure the credential's resolver raised during one tool
 * call. An adapter turns that failure into its own error type and keeps only
 * the message, so the state is carried beside the call, in its async context.
 */
const resolverFailures = new AsyncLocalStorage<{ failure: ConnectionUnavailableError | null }>();

async function record(db: AnyDrizzleDb, ref: ConnectionRef, state: ConnectionState): Promise<void> {
  try {
    await recordConnectionState(db, ref, state);
  } catch (err) {
    console.error(
      `[connector-connections] recording '${state.state}' for ${connectionKey(ref)} failed: ${errorText(err)}`,
    );
  }
}

/** Wrap a connector tool so its outcome is the connection's state. */
function withConnectionState(tool: AnyTool, ctx: LendContext): AnyTool {
  const execute = tool.execute.bind(tool) as AnyTool['execute'];
  const wrapped: AnyTool['execute'] = async (input, context) => {
    const call = { failure: null as ConnectionUnavailableError | null };
    try {
      const out = await resolverFailures.run(call, () => execute(input, context));
      const succeeded = {
        state: 'working' as const,
        cause: 'succeeded' as const,
        detail: null,
        observedAt: new Date(),
        retryAfter: null,
      };
      for (const ref of [ctx.connectorRef, ctx.credentialRef]) {
        if (ref && !ctx.confirmed.has(connectionKey(ref))) {
          ctx.confirmed.add(connectionKey(ref));
          await record(ctx.db, ref, succeeded);
        }
      }
      return out;
    } catch (err) {
      const fromResolver = call.failure ?? (err instanceof ConnectionUnavailableError ? err : null);
      const state = fromResolver ? fromResolver.connection : callFailure(err);
      if (!state) throw err;
      // A resolver failure was recorded by the refresh that learnt it; a
      // provider's answer is recorded here. A refused token belongs to the
      // credential that carried it; an unreachable API to the connector.
      if (!fromResolver) {
        const target =
          state.state === 'needs_reauth' && ctx.credentialRef
            ? ctx.credentialRef
            : ctx.connectorRef;
        ctx.confirmed.delete(connectionKey(target));
        await record(ctx.db, target, state);
      }
      // The adapter turned the resolver's failure into its own error: the
      // contract's class of it is the connection's (the person must
      // authorise again), not what the adapter's text alone said.
      const failed =
        fromResolver && !(err instanceof ConnectionUnavailableError)
          ? new ConnectorCallError(
              classifyCallFailure(fromResolver, null),
              connectorFailureMessage(
                classifyCallFailure(fromResolver, null).kind,
                errorText(err),
                {
                  retryAfter: fromResolver.connection.retryAfter,
                  boundMs: null,
                },
              ),
              null,
              { cause: err },
            )
          : err;
      throw withNote(
        failed,
        connectionNoteForModel(
          { label: ctx.label, account: ctx.account, kind: 'connector' },
          state,
        ),
      );
    }
  };
  return { ...tool, execute: wrapped };
}

/** What a connector's rows say before any call: its secret, and the account. */
type SecretRead =
  | { secret: 'absent' | 'unreadable'; token: null; scopes: null; account: null }
  | { secret: 'readable'; token: string; scopes: string | null; account: string | null };

async function readSecret(
  db: AnyDrizzleDb,
  ca: ConnectorAssignment,
  oauth: boolean,
): Promise<SecretRead> {
  const none = (secret: 'absent' | 'unreadable'): SecretRead => ({
    secret,
    token: null,
    scopes: null,
    account: null,
  });
  if (!oauth) {
    if (!ca.apiKey) return none('absent');
    try {
      return { secret: 'readable', token: decrypt(ca.apiKey), scopes: null, account: null };
    } catch (err) {
      // F3, invariant #4: a corrupt or rotated master key makes every
      // connector fail here; the log names the cause, the context says it.
      console.error(
        `[execute] connector '${ca.slug}' (${ca.connectorId}) api_key failed to decrypt ` +
          `(tampered row, or wrong/rotated master key): ${errorText(err)}`,
      );
      return none('unreadable');
    }
  }
  if (!ca.credentialId) return none('absent');
  try {
    const credential = await decryptCredentialForDisplay(db, ca.credentialId);
    if (!credential) return none('absent');
    return {
      secret: 'readable',
      token: credential.payload.accessToken,
      scopes: credential.payload.scopes ?? null,
      account: credential.payload.accountName || null,
    };
  } catch (err) {
    console.error(
      `[execute] connector '${ca.slug}' (${ca.connectorId}) credential ${ca.credentialId} failed to ` +
        `decrypt (tampered row, or wrong/rotated master key): ${errorText(err)}`,
    );
    return none('unreadable');
  }
}

/**
 * The job's connector tools and the attached connectors it cannot use.
 * Reads rows only: no request to any provider is made here.
 */
export async function lendJobConnectors(
  db: AnyDrizzleDb,
  assignments: readonly ConnectorAssignment[],
): Promise<{ lendings: ConnectorLending[]; withheld: WithheldConnection[] }> {
  const refs: ConnectionRef[] = assignments.flatMap((ca) => [
    { kind: 'connector' as const, id: ca.connectorId },
    ...(ca.credentialId ? [{ kind: 'credential' as const, id: ca.credentialId }] : []),
  ]);
  const stored = await readConnectionStates(db, refs);
  const confirmed = new Set<string>();
  const lendings: ConnectorLending[] = [];
  const withheld: WithheldConnection[] = [];

  for (const ca of assignments) {
    const entry = ADAPTER_REGISTRY[ca.slug];
    if (!entry) {
      // A row of a connector this version has no adapter for: nothing to
      // build. Logged, since the agent was given it.
      console.error(
        `[execute] connector '${ca.slug}' (${ca.connectorId}) has no adapter in this version; not lent`,
      );
      continue;
    }
    const oauth = entry.credentialType !== 'api_key';
    const read = await readSecret(db, ca, oauth);
    const connectorRef: ConnectionRef = { kind: 'connector', id: ca.connectorId };
    const credentialRef: ConnectionRef | null =
      oauth && ca.credentialId ? { kind: 'credential', id: ca.credentialId } : null;
    const connection = connectorConnection({
      secretKind: oauth ? 'credential' : 'api_key',
      secret: read.secret,
      stored: [
        stored.get(connectionKey(connectorRef))!,
        ...(credentialRef ? [stored.get(connectionKey(credentialRef))!] : []),
      ],
    });
    const access = connectorAccessFor(ca.slug, oauth ? read.scopes : null, connection);
    const offered = new Set(offeredOperations(access));
    const label = ca.name;
    if (offered.size === 0 || read.token === null) {
      const state = connectionOfAccess(access, connection);
      console.warn(
        `[execute] connector '${ca.slug}' (${ca.connectorId}) attached but not usable ` +
          `(${state.state}: ${state.cause}); named in the job's context, no tools lent`,
      );
      withheld.push({ kind: 'connector', label, account: read.account, connection: state });
      continue;
    }

    const credentialId = credentialRef?.id ?? null;
    // OAuth adapters whose token expires take a resolver, called before every
    // request: the credential is read (and refreshed) when it is used.
    const allTools =
      entry.toolFactoryWithResolver && credentialId
        ? entry.toolFactoryWithResolver(async () => {
            try {
              const fresh = await getDecryptedCredentialById(db, credentialId);
              if (!fresh) {
                throw new ConnectionUnavailableError(
                  { kind: 'credential', id: credentialId },
                  {
                    state: 'needs_reauth',
                    cause: 'credential_removed',
                    detail: null,
                    observedAt: new Date(),
                    retryAfter: null,
                  },
                );
              }
              return fresh.payload.accessToken;
            } catch (err) {
              const call = resolverFailures.getStore();
              if (call && err instanceof ConnectionUnavailableError) call.failure = err;
              throw err;
            }
          })
        : entry.toolFactory(read.token);
    const enabled = ca.enabledOperations;
    const ctx: LendContext = {
      db,
      label,
      account: read.account,
      connectorRef,
      credentialRef,
      confirmed,
    };
    const tools = allTools
      .filter((t) => offered.has(t.name) && (enabled === null || enabled.includes(t.name)))
      .map((t) => withConnectionState(t, ctx));
    lendings.push({
      connector: { id: ca.connectorId, slug: ca.slug, name: ca.name, address: read.account },
      tools,
    });
  }
  return { lendings, withheld };
}
