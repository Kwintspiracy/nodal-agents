// queries/connection-states.ts — the one writer and the one reader of
// `connection_states` (migration 0171). Every place that learns a
// connection's state writes it through `recordConnectionState`; the
// dashboard, the job and the tool's error read it through
// `readConnectionStates`. No row reads as `NOT_CHECKED`.

import { and, eq, or, sql } from 'drizzle-orm';
import {
  NOT_CHECKED,
  connectionKey,
  isConnectionState,
  type ConnectionCause,
  type ConnectionRef,
  type ConnectionState,
  type ConnectionStateKind,
} from '@nodal-agents/shared';
import { connectionStates, type ConnectionStateRow } from '../schema/connection-states.ts';
import type { AnyDrizzleDb } from '../client.ts';

function fromRow(row: ConnectionStateRow): ConnectionState {
  if (!isConnectionState(row.state, row.cause)) {
    // A row outside the closed set was not written by `recordConnectionState`:
    // said loud, never read as a state it is not (invariant #4).
    throw new Error(
      `connection_states: (${row.state}, ${row.cause}) for ${row.sourceKind}/${row.sourceId} ` +
        'is not a connection state',
    );
  }
  return {
    state: row.state as ConnectionStateKind,
    cause: row.cause as ConnectionCause,
    detail: row.detail,
    observedAt: row.observedAt,
    retryAfter: row.retryAfter,
  };
}

/**
 * Write what was learnt about a connection. Replaces the previous state: a
 * success after a failure puts the row back to `working`, a refusal after a
 * success records the refusal.
 */
export async function recordConnectionState(
  db: AnyDrizzleDb,
  ref: ConnectionRef,
  connection: ConnectionState,
): Promise<void> {
  const values = {
    sourceKind: ref.kind,
    sourceId: ref.id,
    state: connection.state,
    cause: connection.cause,
    detail: connection.detail,
    retryAfter: connection.retryAfter,
    observedAt: connection.observedAt ?? new Date(),
  };
  await db
    .insert(connectionStates)
    .values(values)
    .onConflictDoUpdate({
      target: [connectionStates.sourceKind, connectionStates.sourceId],
      set: {
        state: sql`excluded.state`,
        cause: sql`excluded.cause`,
        detail: sql`excluded.detail`,
        retryAfter: sql`excluded.retry_after`,
        observedAt: sql`excluded.observed_at`,
      },
    });
}

/**
 * Forget what was learnt: the source was set up again with something nothing
 * has used yet (a new API key), so its state is `NOT_CHECKED` until its first
 * use. Never a guess of `working`.
 */
export async function clearConnectionState(db: AnyDrizzleDb, ref: ConnectionRef): Promise<void> {
  await db
    .delete(connectionStates)
    .where(and(eq(connectionStates.sourceKind, ref.kind), eq(connectionStates.sourceId, ref.id)));
}

/** The stored state of each connection, keyed by `connectionKey`; absent ones read `NOT_CHECKED`. */
export async function readConnectionStates(
  db: AnyDrizzleDb,
  refs: readonly ConnectionRef[],
): Promise<Map<string, ConnectionState>> {
  const out = new Map<string, ConnectionState>();
  if (refs.length === 0) return out;
  const rows = await db
    .select()
    .from(connectionStates)
    .where(
      or(
        ...refs.map((r) =>
          and(eq(connectionStates.sourceKind, r.kind), eq(connectionStates.sourceId, r.id)),
        ),
      ),
    );
  for (const row of rows) {
    out.set(
      connectionKey({ kind: row.sourceKind as ConnectionRef['kind'], id: row.sourceId }),
      fromRow(row),
    );
  }
  for (const ref of refs) {
    if (!out.has(connectionKey(ref))) out.set(connectionKey(ref), NOT_CHECKED);
  }
  return out;
}

export async function readConnectionState(
  db: AnyDrizzleDb,
  ref: ConnectionRef,
): Promise<ConnectionState> {
  return (await readConnectionStates(db, [ref])).get(connectionKey(ref)) ?? NOT_CHECKED;
}
