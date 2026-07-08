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
// Command classifiers moved to @nodal-agents/shared (2026-07-08) so the
// approval-impact line (shared, rendered by runner AND web) can reuse the
// SAME verdicts as the gate — re-exported here so existing consumers
// (runner) keep importing them from tools.
export {
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
  isInlineInterpreterEvalCommand,
} from '@nodal-agents/shared';

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
  buildChildEnv,
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
  DELIVERY_TOOL_NAMES,
} from './communication';

// Skill-authoring grounding: the real MCP tool names of a workspace, injected
// into create_skill / update_skill descriptions by the runner so the ROOT agent
// references real tools (not its training-prior conventions) BEFORE authoring.
export { listWorkspaceMcpToolNames } from './builtin/meta-ops/lint-skill-content';

// Canonical label of the entity's built-in shared workspace. The runner builds
// its workspace list with this label and the D1 overwrite gate keys off it —
// exported so the two sides can never drift apart.
export { SHARED_WORKSPACE_LABEL } from './builtin/file-ops/workspace';
