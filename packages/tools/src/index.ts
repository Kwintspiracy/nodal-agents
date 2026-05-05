// @nodalai/tools — public API

// Types
export type {
  ToolDefinition,
  ToolContext,
  ToolRegistry,
  ToolListFilter,
  AiSdkTool,
  ExecuteOptions,
  ApprovalGateRequest,
  ApprovalRule,
  ToolExecutionResult,
} from './types.js';

// RiskLevel (re-exported from @nodalai/shared via types.ts) + runtime constant
export type { RiskLevel } from './types.js';
export { RISK_LEVELS } from './types.js';

// Errors
export {
  InvalidInputError,
  ApprovalRequiredError,
  ToolNotFoundError,
  WhitelistDriftError,
  WebSearchNotConfiguredError,
} from './errors.js';

// Registry
export { createToolRegistry } from './registry.js';

// Execution wrapper
export { executeTool } from './execute.js';

// tool_choice discipline
export { computeToolChoice } from './tool-choice.js';
export type { ToolChoiceConfig, ToolChoice } from './tool-choice.js';

// Whitelist computation
export { computeToolWhitelist } from './whitelist.js';
export type { WhitelistInput } from './whitelist.js';

// Built-in tools
export {
  registerBuiltins,
  ALWAYS_ON_TOOLS,
  ALWAYS_ON_TOOL_DOCS,
  returnResultTool,
  saveMemoryTool,
  queryMemoryTool,
  webSearchTool,
} from './builtin/index.js';
export type { AlwaysOnTool } from './builtin/index.js';
