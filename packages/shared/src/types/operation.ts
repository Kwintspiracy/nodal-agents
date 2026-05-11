// OperationDescriptor — metadata for a single adapter operation.
// Used by the adapter packages to expose their operation lists to the UI
// without requiring an access token (the UI needs to display the grid
// before an agent has a resolved credential).
//
// No Zod schema: this type is pure metadata and never crosses an API
// boundary requiring runtime validation.

export type OperationDescriptor = {
  slug: string; // e.g. 'gmail_send_email' — must match the tool name from the factory
  name: string; // e.g. 'Send email' — human readable label
  risk: 'read' | 'write' | 'destructive';
  requiresApproval: boolean; // default per-operation approval gate
  description?: string; // tooltip for UI
};
