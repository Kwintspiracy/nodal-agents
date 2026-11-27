// scopes.ts — what a connector may do with a credential, from the grant alone.
//
// One rule for every OAuth provider (Google, Microsoft, Airtable, Notion and
// any later one), with no branch on a provider's name:
//   - each operation declares the rights its calls need (`OperationDescriptor.scopes`);
//   - a connector requires the union of its operations' rights;
//   - the rights the provider GRANTED, stored on the credential, are the only
//     truth afterwards: an operation whose rights are not all granted is not
//     offered, and a connector none of whose operations is granted cannot be
//     bound to that credential.
//
// Pure functions: the web (connector card, binding actions, operations grid,
// credential wizard) and the runner (a job's tool list) read the same answer.
// The next layer (a connection's live state: refresh failures, reachability)
// adds kinds to `ConnectorAccess`; it does not replace this computation.

import type { OperationDescriptor, ScopeRequirement } from '../types/operation';

/**
 * The scopes of a grant as the provider wrote them: OAuth 2.0 (RFC 6749 §3.3)
 * carries them as one space-separated string, which is how a credential
 * stores them.
 */
export function parseScopes(value: string | null | undefined): string[] {
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

/** Order-preserving union, without duplicates. */
export function unionScopes(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const scope of list) {
      if (!seen.has(scope)) {
        seen.add(scope);
        out.push(scope);
      }
    }
  }
  return out;
}

function requirementMet(requirement: ScopeRequirement, granted: ReadonlySet<string>): boolean {
  return requirement.some((scope) => granted.has(scope));
}

/** The rights an operation lacks under a grant: the scope Nodal asks for, per unmet requirement. */
export function missingScopesOf(
  operation: OperationDescriptor,
  granted: readonly string[],
): string[] {
  const grantedSet = new Set(granted);
  return unionScopes(
    (operation.scopes ?? [])
      .filter((requirement) => !requirementMet(requirement, grantedSet))
      .map((requirement) => requirement[0]),
  );
}

/**
 * What a connector requires: the union of the scope each of its operations
 * asks for. A provider entry must request at least these.
 */
export function requiredScopes(operations: readonly OperationDescriptor[]): string[] {
  return unionScopes(...operations.map((op) => (op.scopes ?? []).map((req) => req[0])));
}

/**
 * What a connector can do with a grant.
 *
 * `ready`: every operation's rights are granted.
 * `needs_access`: some are not. `grantedOperations` are still offered;
 * `missingOperations` are not, and `missingScopes` is what a new
 * authorisation for this connector must add.
 */
export type ConnectorAccess =
  | { kind: 'ready'; grantedOperations: string[] }
  | {
      kind: 'needs_access';
      grantedOperations: string[];
      missingOperations: string[];
      missingScopes: string[];
    };

export function connectorAccess(
  operations: readonly OperationDescriptor[],
  granted: readonly string[],
): ConnectorAccess {
  const grantedOperations: string[] = [];
  const missingOperations: string[] = [];
  const missing: string[][] = [];
  for (const op of operations) {
    const lacking = missingScopesOf(op, granted);
    if (lacking.length === 0) {
      grantedOperations.push(op.slug);
    } else {
      missingOperations.push(op.slug);
      missing.push(lacking);
    }
  }
  if (missingOperations.length === 0) return { kind: 'ready', grantedOperations };
  return {
    kind: 'needs_access',
    grantedOperations,
    missingOperations,
    missingScopes: unionScopes(...missing),
  };
}

/**
 * Why a credential cannot be bound to a connector, or null when it can.
 *
 * A binding needs at least one operation the grant covers: a connector bound
 * to a grant that covers none of its operations would be shown as installed
 * and do nothing. A partial grant (the person declined part of the consent)
 * binds; what it does not cover stays `needs_access`.
 */
export function bindingRefusal(access: ConnectorAccess): { missingScopes: string[] } | null {
  if (access.kind === 'needs_access' && access.grantedOperations.length === 0) {
    return { missingScopes: access.missingScopes };
  }
  return null;
}
