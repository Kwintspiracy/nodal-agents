// outbound-columns.ts — the columns of text that leave Nodal, read through the seam.
//
// A read model of the dashboard reads a column of text an agent, a tool or a
// third party wrote (a job's request and result, a chat message, a tool call's
// input and output, a delivery's payload) and hands it to a browser. That is
// text leaving Nodal: it goes through the outbound seam (`@nodal-agents/shared`,
// outbound.ts) AT THE PROJECTION, before any code of the read model sees it —
// so before any cut, any title, any preview.
//
//   - `outboundColumn(col)`     one column, masked as it is read;
//   - `outboundColumns(table)`  every column of a table, its columns of text
//                               masked (a whole row read for a page);
//   - `outboundSql(expr)`       an expression over such columns (an aggregate
//                               that picks the first request of a thread);
//   - `serverOnly(col)`         a column read for the server's own work (a
//                               form validated, a call re-run), NEVER returned
//                               to a browser: the read stays raw, and says so.
//
// `OUTBOUND_TEXT_COLUMNS` is THE list of those columns, beside the schema. The
// web's architecture suite refuses a projection of one of them that does not
// go through a function above (`scanForOutboundBypass`), and this package's
// suite refuses a column of text of these tables that the list does not
// classify (`NOT_OUTBOUND_TEXT_COLUMNS` says why each other one is not text a
// reader outside must not see raw).
//
// The stored rows are never touched: this masks what is READ for a browser.

import { getTableColumns, sql, type Column, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { outboundValue } from '@nodal-agents/shared';
import { agentJobs } from './schema/jobs.ts';
import { chatMessages, conversations } from './schema/chat-messages.ts';
import { toolCalls } from './schema/tool_calls.ts';
import { approvalRequests } from './schema/approvals.ts';
import { jobDeliveries } from './schema/job-deliveries.ts';
import { verificationRuns } from './schema/verification.ts';
import { agentTasks } from './schema/tasks.ts';
import { connectionStates } from './schema/connection-states.ts';

/** The tables whose rows carry text written by an agent, a tool or a third party. */
export const OUTBOUND_TEXT_TABLES = {
  agentJobs,
  chatMessages,
  conversations,
  toolCalls,
  approvalRequests,
  jobDeliveries,
  verificationRuns,
  agentTasks,
  connectionStates,
} as const;

type TableName = keyof typeof OUTBOUND_TEXT_TABLES;
type ColumnsOf<N extends TableName> = keyof (typeof OUTBOUND_TEXT_TABLES)[N]['_']['columns'] &
  string;

/**
 * The columns of text that leave masked: written by an agent (a reply, a
 * brief, a note), by a tool (an output, a card), or by a third party (a
 * channel's sender, a webhook's payload, a page an agent read).
 */
export const OUTBOUND_TEXT_COLUMNS: { readonly [N in TableName]: readonly ColumnsOf<N>[] } = {
  agentJobs: [
    'task',
    'handoffNote',
    'spokenAnnouncement',
    'triggerContext',
    'systemPrompt',
    'messages',
    'inbox',
    'searchText',
    'result',
    'runnerNotes',
    'error',
    'failureHint',
    'liveProgress',
    'pendingDelegation',
  ],
  chatMessages: ['content'],
  conversations: ['title'],
  toolCalls: ['toolInput', 'toolOutput', 'card', 'presented', 'presentationError'],
  approvalRequests: ['toolInput', 'gateReasons', 'executionOutput'],
  jobDeliveries: ['payload'],
  verificationRuns: ['command', 'stdoutTail', 'stderrTail'],
  agentTasks: ['title', 'description', 'result', 'context'],
  // The provider's own words when a connection failed (0171): a third party's text.
  connectionStates: ['detail'],
};

/**
 * Every OTHER column of text of these tables, and why it is not text a reader
 * outside must not see raw. A column added to one of these tables is in one
 * list or the other, or this package's suite is red.
 */
export const NOT_OUTBOUND_TEXT_COLUMNS: {
  readonly [N in TableName]: Readonly<Partial<Record<ColumnsOf<N>, string>>>;
} = {
  agentJobs: {
    status: 'a state of the platform',
    channel: 'a channel kind',
    replyRendering: 'a rendering kind',
    chatId: 'a platform identifier',
    chatChannel: 'a channel kind',
    systemPromptTools: 'tool names of the whitelist',
    systemPromptVersion: 'a version hash',
    loadedTools: 'tool names',
    toolsUsed: 'tool names',
    resultKind: 'a result kind',
    requestId: 'an identifier',
    parentRequestId: 'an identifier',
    servedProvider: 'a provider name',
    lastFailedDelegationSlug: 'an agent slug',
    jobFolder: 'a folder Nodal chose',
    verificationSkippedSurfaces: 'surface names',
    restartBlockedBy: 'identifiers',
    sweeperObserved: 'what a sweeper observed, as typed fields: identifiers and instants (0173)',
  },
  chatMessages: {
    role: 'a role',
    cutReason: 'a reason code',
  },
  conversations: {
    origin: 'an origin kind',
    channel: 'a channel kind',
    chatId: 'a platform identifier',
  },
  toolCalls: {
    toolName: 'a tool name',
    toolCallId: 'an identifier',
    riskLevel: 'a risk level',
    outcome: 'an outcome code of the closed set (0170)',
    target:
      'a key of what the call acted on (file paths, a chat, an input hash), built by the seam (0170)',
  },
  approvalRequests: {
    toolName: 'a tool name',
    toolCallId: 'an identifier',
    kind: 'a request kind',
    status: 'a state',
    answer: 'the person’s own answer',
    response: 'the person’s own answer to a form',
    draft: 'the person’s own draft, read back into their form',
    resolvedBy: 'an identifier',
    notes: 'the person’s own note',
  },
  jobDeliveries: {
    channel: 'a channel kind',
    chatId: 'a platform identifier',
    outcome: 'an outcome code',
    idempotencyKey: 'a key Nodal drew',
    receipt: 'the platform’s receipt (identifiers)',
    claimedBy: 'an identifier',
  },
  verificationRuns: {
    deliverableType: 'a type',
    canonicalKey: 'a path key',
    manifestHash: 'a hash',
    outcomeKind: 'an outcome kind',
    verdict: 'a verdict code',
    source: 'a source kind',
    sandbox: 'a sandbox kind',
  },
  agentTasks: {
    status: 'a state',
    priority: 'a priority',
    lockedBy: 'an identifier',
    dependsOn: 'identifiers of other tasks',
  },
  connectionStates: {
    sourceKind: 'a source kind of the closed set',
    sourceId: 'an identifier',
    state: 'a state of the closed set',
    cause: 'a cause code of the closed set',
  },
};

type AnyColumn = Column & { readonly _: { readonly data: unknown; readonly notNull: boolean } };
type ColumnValue<C extends AnyColumn> = C['_']['notNull'] extends true
  ? C['_']['data']
  : C['_']['data'] | null;

/** One column of text, masked as it is read for a browser. */
export function outboundColumn<C extends AnyColumn>(column: C): SQL<ColumnValue<C>> {
  return sql`${column}`.mapWith((value: unknown) =>
    outboundValue(column.mapFromDriverValue(value)),
  ) as SQL<ColumnValue<C>>;
}

/** An expression over columns of text (an aggregate), its value masked as it is read. */
export function outboundSql<T>(expression: SQL<T>): SQL<T> {
  return expression.mapWith((value: unknown) => outboundValue(value) as T);
}

const textColumnsOf = (table: PgTable): ReadonlySet<string> => {
  for (const [name, t] of Object.entries(OUTBOUND_TEXT_TABLES)) {
    if (t === table) return new Set(OUTBOUND_TEXT_COLUMNS[name as TableName] as readonly string[]);
  }
  throw new Error('outbound_columns_unknown_table: this table carries no list of text columns');
};

type OutboundRow<T extends PgTable> = {
  [K in keyof T['_']['columns']]: T['_']['columns'][K] extends AnyColumn
    ? SQL<ColumnValue<T['_']['columns'][K]>>
    : never;
};

/**
 * Every column of `table`, for a whole row read for a browser: its columns of
 * text (`OUTBOUND_TEXT_COLUMNS`) masked as they are read, the others as they
 * are. The row has the type `{ job: table }` would have given.
 */
export function outboundColumns<T extends PgTable>(table: T): OutboundRow<T> {
  const text = textColumnsOf(table);
  const out: Record<string, unknown> = {};
  for (const [name, column] of Object.entries(getTableColumns(table))) {
    out[name] = text.has(name) ? outboundColumn(column as AnyColumn) : column;
  }
  return out as OutboundRow<T>;
}

/**
 * A column of text read for the server's own work (a form validated against
 * the request it answers, an input re-run), never returned to a browser. The
 * value stays raw; the call says so where a reviewer reads it.
 */
export function serverOnly<C extends AnyColumn>(column: C): C {
  return column;
}
