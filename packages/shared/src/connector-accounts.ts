// connector-accounts.ts — several accounts of one service on one agent.
//
// An agent may hold several connectors of one service: a personal and a work
// mailbox, or one Notion workspace by its API key and another by OAuth. Each
// lends the same tool names. In a job those names appear ONCE, with an
// `account` argument whose values are the connectors' names
// (`lendConnectorTools`, @nodal-agents/tools). The rules every layer shares:
//
//   - which connectors are accounts of one service (`connectorService`);
//   - two accounts of one service on one agent carry names a model can tell
//     apart (`sameAccountName`): every attach path and every rename refuses
//     the second, and a job that still holds two such accounts is refused
//     when it is built. Never a default account (invariant #4).

import { CONNECTOR_CATALOG } from './connector-catalog';

/** The service a connector of catalog `slug` connects to (its own slug unless declared). */
export function connectorService(slug: string): string {
  return CONNECTOR_CATALOG.find((c) => c.slug === slug)?.service ?? slug;
}

/** The form under which two account names are the same name to a reader. */
export function accountNameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** What the account rules read of a connector. */
export interface NamedConnector {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * Two DIFFERENT connectors that are accounts of one service under names a
 * model could not tell apart (equal once trimmed and case-folded).
 */
export function sameAccountName(a: NamedConnector, b: NamedConnector): boolean {
  return (
    a.id !== b.id &&
    connectorService(a.slug) === connectorService(b.slug) &&
    accountNameKey(a.name) === accountNameKey(b.name)
  );
}

/** The first two connectors of `held` that `sameAccountName` refuses together, or null. */
export function findIndistinctAccounts<T extends NamedConnector>(
  held: readonly T[],
): [T, T] | null {
  for (let i = 0; i < held.length; i++) {
    for (let j = i + 1; j < held.length; j++) {
      if (sameAccountName(held[i]!, held[j]!)) return [held[i]!, held[j]!];
    }
  }
  return null;
}

/** The refusal, the same words on every surface: both connectors, and the way out. */
export function indistinctAccountsMessage(a: NamedConnector, b: NamedConnector): string {
  return (
    `The connectors "${a.name}" (${a.slug}) and "${b.name}" (${b.slug}) are two accounts of ` +
    `the same service on one agent, under names that cannot be told apart, so a call could ` +
    `not say which account it means. Rename one of them on the Connectors page, or give it ` +
    `to a different agent.`
  );
}
