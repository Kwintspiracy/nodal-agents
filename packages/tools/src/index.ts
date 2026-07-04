// @nodal-agents/tools — public API

// Types
export type {
  ToolDefinition,
  ToolContext,
  ToolProvisioning,
  ProvisionMcpConnect,
  ToolRegistry,
  ToolListFilter,
  AiSdkTool,
  ExecuteOptions,
  ApprovalGateRequest,
  ApprovalRule,
  ToolExecutionResult,
} from './types';

// RiskLevel (re-exported from @nodal-agents/shared via types.ts) + runtime constant
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
export { executeTool, matchApprovalRule } from './execute';
export { isCatastrophicCommand, isDestructiveOrHeavyCommand } from './catastrophic-command';

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
  searchHistoryTool,
  webSearchTool,
  dashboardPublishTool,
  DashboardPublishInputSchema,
} from './builtin/index';
export type { AlwaysOnTool, DashboardPublishInput } from './builtin/index';

// Communication tools (capability-driven — registered per-agent based on agent config)
export {
  createTelegramSendMessageTool,
  createSendImageTool,
  createSendFileTool,
  createSendVideoTool,
  createSendAudioTool,
  createSendVoiceTool,
} from './communication';

// Skill-authoring grounding: the real MCP tool names of a workspace, injected
// into create_skill / update_skill descriptions by the runner so the ROOT agent
// references real tools (not its training-prior conventions) BEFORE authoring.
export { listWorkspaceMcpToolNames } from './builtin/meta-ops/lint-skill-content';
