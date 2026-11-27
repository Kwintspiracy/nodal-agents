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

/**
 * How a provider writes the scopes it granted, when that differs from how they
 * are asked for. Data on the provider entry, never a branch on its name.
 *
 * `resourcePrefix`: a scope may come back without it (Microsoft documents
 * `User.Read` as equivalent to `https://graph.microsoft.com/User.Read`).
 * `caseInsensitive`: the provider does not distinguish case in scope names.
 * Absent: scopes compare exactly, as RFC 6749 §3.3 defines them.
 */
export type GrantedScopeForm = {
  resourcePrefix?: string;
  caseInsensitive?: boolean;
};

/** One scope in the form comparisons use. Percent-encoding is undone first. */
export function canonicalScope(scope: string, form?: GrantedScopeForm): string {
  let s = scope;
  if (s.includes('%')) {
    try {
      s = decodeURIComponent(s);
    } catch {
      // Not valid percent-encoding: the scope is compared as written.
    }
  }
  if (form?.caseInsensitive) s = s.toLowerCase();
  const prefix = form?.resourcePrefix
    ? form.caseInsensitive
      ? form.resourcePrefix.toLowerCase()
      : form.resourcePrefix
    : undefined;
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
  return s;
}

function requirementMet(
  requirement: ScopeRequirement,
  granted: ReadonlySet<string>,
  form: GrantedScopeForm | undefined,
): boolean {
  return requirement.some((scope) => granted.has(canonicalScope(scope, form)));
}

/** The rights an operation lacks under a grant: the scope Nodal asks for, per unmet requirement. */
export function missingScopesOf(
  operation: OperationDescriptor,
  granted: readonly string[],
  form?: GrantedScopeForm,
): string[] {
  const grantedSet = new Set(granted.map((scope) => canonicalScope(scope, form)));
  return unionScopes(
    (operation.scopes ?? [])
      .filter((requirement) => !requirementMet(requirement, grantedSet, form))
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
  form?: GrantedScopeForm,
): ConnectorAccess {
  const grantedOperations: string[] = [];
  const missingOperations: string[] = [];
  const missing: string[][] = [];
  for (const op of operations) {
    const lacking = missingScopesOf(op, granted, form);
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
