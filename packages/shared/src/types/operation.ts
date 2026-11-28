// OperationDescriptor — metadata for a single adapter operation.
// Used by the adapter packages to expose their operation lists to the UI
// without requiring an access token (the UI needs to display the grid
// before an agent has a resolved credential).
//
// No Zod schema: this type is pure metadata and never crosses an API
// boundary requiring runtime validation.

/**
 * One OAuth right an operation needs. The first scope is the one Nodal asks
 * the provider for; the others are broader scopes the provider's own API
 * reference also accepts for the same calls. A grant holding ANY of them meets
 * the requirement (e.g. the Sheets API accepts the Drive scope).
 */
export type ScopeRequirement = readonly [requested: string, ...alsoAccepted: string[]];

export type OperationDescriptor = {
  slug: string; // e.g. 'gmail_send_email' — must match the tool name from the factory
  name: string; // e.g. 'Send email' — human readable label
  risk: 'read' | 'write' | 'destructive';
  requiresApproval: boolean; // default per-operation approval gate
  description?: string; // tooltip for UI
  /**
   * The owner's two texts on the Approvals tab (issue #382): a short imperative
   * title, and one or two sentences saying what the operation does and what it
   * costs them. Rolled out connector by connector, so both stay optional: an
   * operation that declares neither keeps showing `name` and `description`,
   * which is what the screen showed before. No em dash, a person reads these.
   */
  label?: string;
  summary?: string;
  /**
   * The OAuth rights the operation's calls need, ALL of them (each met by any
   * of its scopes). This is the single declaration of a connector's rights:
   * what a connector requires is the union of its operations', an operation
   * whose rights the credential's grant does not hold is not given to a job,
   * and the provider entry must request every one of them (enforced by
   * `connector-scopes.test.ts` in runner-adapters). Absent on connectors whose
   * provider has no scopes (API keys, Notion's capabilities).
   */
  scopes?: readonly ScopeRequirement[];
};
