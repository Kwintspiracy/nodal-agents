// @nodal-agents/tools — error classes
// All errors carry typed codes — no user-facing strings

// ─── InvalidInputError ────────────────────────────────────────────────────────

export class InvalidInputError extends Error {
  readonly code = 'invalid_input' as const;

  constructor(
    public readonly toolName: string,
    public readonly detail: string,
  ) {
    super(`invalid_input: ${toolName}: ${detail}`);
    this.name = 'InvalidInputError';
  }
}

// ─── ApprovalRequiredError ────────────────────────────────────────────────────

export class ApprovalRequiredError extends Error {
  readonly code = 'approval_required' as const;

  constructor(
    public readonly toolName: string,
    public readonly approvalRequestId: string,
  ) {
    super(`approval_required: ${toolName}: ${approvalRequestId}`);
    this.name = 'ApprovalRequiredError';
  }
}

// ─── ToolNotFoundError ────────────────────────────────────────────────────────

export class ToolNotFoundError extends Error {
  readonly code = 'tool_not_found' as const;

  constructor(public readonly toolName: string) {
    super(`tool_not_found: ${toolName}`);
    this.name = 'ToolNotFoundError';
  }
}

// ─── WhitelistDriftError ──────────────────────────────────────────────────────

/**
 * Raised when an agent references a tool not present in the registry.
 * This enforces invariant 9: no undeclared defaults.
 */
export class WhitelistDriftError extends Error {
  readonly code = 'whitelist_drift' as const;

  constructor(
    public readonly agentId: string,
    public readonly undeclaredTools: string[],
  ) {
    super(
      `whitelist_drift: agent ${agentId} references undeclared tools: ${undeclaredTools.join(', ')}`,
    );
    this.name = 'WhitelistDriftError';
  }
}

// ─── WebSearchNotConfiguredError ──────────────────────────────────────────────

export class WebSearchNotConfiguredError extends Error {
  readonly code = 'web_search_not_configured' as const;

  constructor() {
    super('web_search_not_configured');
    this.name = 'WebSearchNotConfiguredError';
  }
}

// ─── ToolFailedWithOutput ─────────────────────────────────────────────────────

/**
 * A tool's own failure that comes WITH a result: an MCP server's `isError`
 * reply carries content blocks and structuredContent like a success. The
 * message is what the model reads; `output` is what the tool_calls row keeps,
 * whole, as it keeps a success's output (review pass 5 of #665).
 */
export class ToolFailedWithOutput extends Error {
  constructor(
    message: string,
    public readonly output: unknown,
  ) {
    super(message);
    this.name = 'ToolFailedWithOutput';
  }
}
