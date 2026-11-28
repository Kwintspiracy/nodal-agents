// tool-sources.ts — in a job, a tool name designates exactly one target.
//
// A job's tools come from several sources: Nodal's built-ins, the delegation
// tools, the channel delivery tools, the agent's connectors and its MCP
// servers. The model calls a tool by its NAME, and the runner routes the call
// by that name alone. Two sources that lend one name therefore cannot both be
// reached: whichever comes last answers, and nothing the model, the approval
// card or the audit row reads says which. The assembly of a job's tools
// (`oneTargetPerName`) refuses such a list, loud, naming both sources, for
// every source alike — the rule MCP servers already had (#661) is the rule
// for all.
//
// Several connectors of ONE service are not a clash: they are accounts of
// that service (a personal and a work mailbox). Their tools appear once, with
// an `account` argument whose values are the connectors' names
// (`lendConnectorTools`); the call says which account, and the argument is
// required whenever there is a choice. Never a default account (invariant #4).

import { z } from 'zod';
import {
  accountNameKey,
  connectorService,
  findIndistinctAccounts,
  indistinctAccountsMessage,
} from '@nodal-agents/shared';
import type { ToolDefinition } from './types';

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

/** Where a tool of the job comes from, as a person names it. */
export interface ToolSource {
  readonly kind: 'builtin' | 'delegation' | 'delivery' | 'connector' | 'mcp';
  /** How the refusal names it: `the MCP server "Fetch" (mcp-fetch)`. */
  readonly label: string;
}

/** The tools one source lends a job. */
export interface LentTools<T extends { name: string } = AnyTool> {
  readonly source: ToolSource;
  readonly tools: readonly T[];
}

export const BUILTIN_TOOLS_SOURCE: ToolSource = {
  kind: 'builtin',
  label: "Nodal's built-in tools",
};
export const DELEGATION_TOOLS_SOURCE: ToolSource = {
  kind: 'delegation',
  label: 'the delegation tools',
};
export const DELIVERY_TOOLS_SOURCE: ToolSource = {
  kind: 'delivery',
  label: 'the channel delivery tools',
};

export function mcpServerSource(server: { name: string; slug: string }): ToolSource {
  return { kind: 'mcp', label: `the MCP server "${server.name}" (${server.slug})` };
}

/** The connectors that lend one set of tools: one connector, or the accounts of one service. */
export function connectorSource(accounts: readonly { name: string; slug: string }[]): ToolSource {
  const named = accounts.map((a) => `"${a.name}" (${a.slug})`);
  return {
    kind: 'connector',
    label:
      named.length === 1
        ? `the connector ${named[0]}`
        : `the connectors ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`,
  };
}

/** The refusal of a job lent one tool name by two sources. */
export function toolNameCollisionMessage(toolName: string, a: ToolSource, b: ToolSource): string {
  return (
    `${capitalise(a.label)} and ${b.label} both lend this agent a tool named "${toolName}", ` +
    `so a call could not tell them apart. Untick it on one of them in the agent's Connectors ` +
    `tab, detach one, or give the other to a different agent.`
  );
}

export class ToolNameCollisionError extends Error {
  constructor(
    readonly toolName: string,
    readonly sources: readonly [ToolSource, ToolSource],
  ) {
    super(toolNameCollisionMessage(toolName, sources[0], sources[1]));
    this.name = 'ToolNameCollisionError';
  }
}

/**
 * The tools of a job, in the order of `lent`, each name lent by ONE source.
 * Throws `ToolNameCollisionError` on the first name two sources (or one source
 * twice) lend: the call could reach only one of them, and nothing would say
 * which.
 */
export function oneTargetPerName<T extends { name: string }>(lent: readonly LentTools<T>[]): T[] {
  const lentBy = new Map<string, ToolSource>();
  const tools: T[] = [];
  for (const { source, tools: lentTools } of lent) {
    for (const tool of lentTools) {
      const first = lentBy.get(tool.name);
      if (first) throw new ToolNameCollisionError(tool.name, [first, source]);
      lentBy.set(tool.name, source);
      tools.push(tool);
    }
  }
  return tools;
}

// ─── Several accounts of one service ──────────────────────────────────────────

/** The argument that says which account a call acts on. */
export const ACCOUNT_KEY = 'account';

/** A connector of the agent, as the account it is. */
export interface ConnectorAccount {
  readonly id: string;
  readonly slug: string;
  /** The connector's name, as the owner sees and edits it: the argument's value. */
  readonly name: string;
  /** What identifies the account at the provider (its address), when the provider gives it. */
  readonly address: string | null;
}

/** What one connector lends this job: the operations its assignment and its grant allow. */
export interface ConnectorLending {
  readonly connector: ConnectorAccount;
  readonly tools: readonly AnyTool[];
}

/** What a successful call on one of several accounts returns: the account, then the result. */
export interface AccountResult {
  readonly account: string;
  readonly result: unknown;
}

/** The accounts of one service cannot be lent as they are: the job is refused, loud. */
export class ConnectorAccountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorAccountsError';
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The connector tools of a job, one set per service.
 *
 * A service the agent holds through ONE connector lends its tools unchanged.
 * A service it holds through several (`connectorService`) lends each tool
 * name once: the tool takes an `account` argument whose values are the
 * accounts that lend THAT operation (an operation allowed on one account only
 * is offered with that account alone), and the call runs on that account's
 * own tool, with that account's credential. The order of `lendings` decides
 * nothing: accounts are read in the order of their names.
 *
 * Throws `ConnectorAccountsError` when two accounts of one service carry names
 * a model could not tell apart, and `ToolNameCollisionError` when two accounts
 * lend one name under two different definitions.
 */
export function lendConnectorTools(lendings: readonly ConnectorLending[]): LentTools[] {
  const byService = new Map<string, ConnectorLending[]>();
  for (const lending of lendings) {
    const service = connectorService(lending.connector.slug);
    byService.set(service, [...(byService.get(service) ?? []), lending]);
  }
  const lent: LentTools[] = [];
  for (const service of [...byService.keys()].sort(compareText)) {
    const accounts = [...byService.get(service)!].sort(
      (a, b) =>
        compareText(accountNameKey(a.connector.name), accountNameKey(b.connector.name)) ||
        compareText(a.connector.name, b.connector.name) ||
        compareText(a.connector.id, b.connector.id),
    );
    if (accounts.length === 1) {
      lent.push({ source: connectorSource([accounts[0]!.connector]), tools: accounts[0]!.tools });
      continue;
    }
    const clash = findIndistinctAccounts(accounts.map((a) => a.connector));
    if (clash) throw new ConnectorAccountsError(indistinctAccountsMessage(clash[0], clash[1]));

    const lenders = new Map<string, Lender[]>();
    for (const { connector, tools } of accounts) {
      for (const tool of tools) {
        lenders.set(tool.name, [...(lenders.get(tool.name) ?? []), { connector, tool }]);
      }
    }
    lent.push({
      source: connectorSource(accounts.map((a) => a.connector)),
      tools: [...lenders.entries()].map(([name, of]) => accountTool(name, of)),
    });
  }
  return lent;
}

interface Lender {
  readonly connector: ConnectorAccount;
  readonly tool: AnyTool;
}

/** `"Work" (me@work.com)`: the value, then what identifies it at the provider. */
function describeAccount(c: ConnectorAccount): string {
  return c.address && accountNameKey(c.address) !== accountNameKey(c.name)
    ? `"${c.name}" (${c.address})`
    : `"${c.name}"`;
}

/** What the model reads of the argument. */
function accountDescription(lenders: readonly Lender[]): string {
  return (
    `Which account this call acts on: ${lenders.map((l) => describeAccount(l.connector)).join(', ')}. ` +
    `This agent holds several accounts of this service and none is chosen for you.`
  );
}

/** What the model reads when a call names no account, or one that is not (or no longer) there. */
export function accountInstruction(
  toolName: string,
  accounts: readonly ConnectorAccount[],
  given: unknown,
): string {
  const list = accounts.map(describeAccount).join(', ');
  const asked =
    typeof given === 'string'
      ? `"${given}" is not one of the accounts "${toolName}" can act on for this agent.`
      : `"${toolName}" acts on one of several accounts of this agent and none is chosen for you.`;
  return (
    `account_required: ${asked} This call did NOT run. Call "${toolName}" again with the same ` +
    `input plus \`${ACCOUNT_KEY}\` set to one of: ${list}.`
  );
}

/**
 * Hooks that read one call's input or output. The account tool would have to
 * route each to the account's own tool; no connector declares one today, so a
 * connector that does is refused loud rather than routed by guess.
 */
const PER_CALL_HOOKS = [
  'preflight',
  'present',
  'toModelOutput',
  'replacesSharedFile',
  'resolveMutationTargets',
] as const;

/** What must be identical for one name to be one operation on every account. */
function operationSignature(tool: AnyTool): string {
  return JSON.stringify({
    input: z.toJSONSchema(tool.inputSchema, { io: 'input', unrepresentable: 'any' }),
    riskLevel: tool.riskLevel,
    defaultApproval: tool.defaultApproval ?? null,
    asksUser: tool.asksUser ?? false,
    loading: tool.loading ?? 'deferred',
  });
}

/** One tool name of a service held through several accounts. */
function accountTool(name: string, lenders: readonly Lender[]): AnyTool {
  const base = lenders[0]!.tool;
  const schema = base.inputSchema;
  if (!(schema instanceof z.ZodObject)) {
    throw new ConnectorAccountsError(
      `The connector tool "${name}" takes no object input, so it cannot take the ` +
        `\`${ACCOUNT_KEY}\` argument that says which of this agent's accounts a call acts on.`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(schema.shape, ACCOUNT_KEY)) {
    throw new ConnectorAccountsError(
      `The connector tool "${name}" already has an argument named "${ACCOUNT_KEY}", so it ` +
        `cannot say which of this agent's accounts a call acts on.`,
    );
  }
  for (const hook of PER_CALL_HOOKS) {
    if (base[hook] !== undefined) {
      throw new ConnectorAccountsError(
        `The connector tool "${name}" declares \`${hook}\`, which the tool of several accounts ` +
          `does not route to one account.`,
      );
    }
  }
  const signature = operationSignature(base);
  for (const other of lenders.slice(1)) {
    if (operationSignature(other.tool) !== signature) {
      throw new ToolNameCollisionError(name, [
        connectorSource([lenders[0]!.connector]),
        connectorSource([other.connector]),
      ]);
    }
  }

  const accounts = lenders.map((l) => l.connector);
  const byName = new Map(lenders.map((l) => [l.connector.name, l]));
  const names = accounts.map((a) => a.name) as [string, ...string[]];
  const field = z
    .enum(names, { error: (issue) => accountInstruction(name, accounts, issue.input) })
    .describe(accountDescription(lenders));

  return {
    ...base,
    inputSchema: schema.extend({ [ACCOUNT_KEY]: field }),
    // The outcome a tool declares reads ITS output (#1184): here, the result
    // of the account's own tool, which the account tool wraps with the
    // account's name. Routed to that account's tool, never read on the wrapper.
    ...(base.outcomeOf !== undefined
      ? {
          outcomeOf: (output: unknown) => {
            const { account, result } = output as AccountResult;
            const declare = byName.get(account)?.tool.outcomeOf;
            if (declare === undefined) {
              throw new Error(
                `account_tool_outcome_unroutable: "${name}" returned for the account ` +
                  `"${account}", whose tool declares no outcome.`,
              );
            }
            return declare(result);
          },
        }
      : {}),
    execute: async (input, ctx) => {
      const { [ACCOUNT_KEY]: account, ...rest } = input as Record<string, unknown>;
      const lender = typeof account === 'string' ? byName.get(account) : undefined;
      if (!lender) throw new Error(accountInstruction(name, accounts, account));
      const result: AccountResult = {
        account: lender.connector.name,
        result: await lender.tool.execute(rest, ctx),
      };
      return result;
    },
  };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
