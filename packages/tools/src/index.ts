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
} from './types';

// RiskLevel (re-exported from @nodalai/shared via types.ts) + runtime constant
export type { RiskLevel } from './types';
export { RISK_LEVELS } from './types';

// Errors
export {
  InvalidInputError,
  ApprovalRequiredError,
  ToolNotFoundError,
  WhitelistDriftError,
  WebSearchNotConfiguredError,
} from './errors';

// Registry
export { createToolRegistry } from './registry';

// Execution wrapper
export { executeTool } from './execute';

// tool_choice discipline
export { computeToolChoice } from './tool-choice';
export type { ToolChoiceConfig, ToolChoice } from './tool-choice';

// Whitelist computation
export { computeToolWhitelist } from './whitelist';
export type { WhitelistInput } from './whitelist';

// Built-in tools
export {
  registerBuiltins,
  ALWAYS_ON_TOOLS,
  ALWAYS_ON_TOOL_DOCS,
  returnResultTool,
  saveMemoryTool,
  queryMemoryTool,
  webSearchTool,
} from './builtin/index';
export type { AlwaysOnTool } from './builtin/index';
