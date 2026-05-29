// Built-in tools registration
// Call registerBuiltins(registry) once at startup to make all built-in tools available.

import type { ToolRegistry } from '../types';
import { returnResultTool } from './return-result';
import { saveMemoryTool } from './save-memory';
import { queryMemoryTool } from './query-memory';
import { markMemoryHelpfulTool } from './mark-memory-helpful';
import { markMemoryOutdatedTool } from './mark-memory-outdated';
import { webSearchTool } from './web-search';
import { dashboardPublishTool } from './dashboard-publish';
import {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileListTool,
  fileSearchTool,
} from './file-ops';
import { OFFICE_TOOLS } from './office-ops';
import { META_TOOLS } from './meta-ops';

export { returnResultTool } from './return-result';
export { saveMemoryTool } from './save-memory';
export { queryMemoryTool } from './query-memory';
export { markMemoryHelpfulTool } from './mark-memory-helpful';
export { markMemoryOutdatedTool } from './mark-memory-outdated';
export { webSearchTool } from './web-search';
export { dashboardPublishTool, DashboardPublishInputSchema } from './dashboard-publish';
export type { DashboardPublishInput } from './dashboard-publish';
export {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileListTool,
  fileSearchTool,
  WorkspaceError,
} from './file-ops';
export { OFFICE_TOOLS } from './office-ops';
export { META_TOOLS } from './meta-ops';
export { createSkillTool, assignSkillTool, createAgentTool } from './meta-ops';

/**
 * Register all built-in tools into the given registry.
 * Idempotent — calling twice just overwrites with the same tools.
 *
 * Office tools (xlsx_*, docx_*, pptx_*) are registered here but NOT added to
 * ALWAYS_ON_TOOLS — they are gated behind the "office-editing" skill via the
 * skill's requiredBuiltins field. The runner unions each assigned skill's
 * requiredBuiltins into the whitelist alongside alwaysOn.
 */
export function registerBuiltins(registry: ToolRegistry): void {
  registry.register(returnResultTool);
  registry.register(saveMemoryTool);
  registry.register(queryMemoryTool);
  registry.register(markMemoryHelpfulTool);
  registry.register(markMemoryOutdatedTool);
  registry.register(webSearchTool);
  registry.register(dashboardPublishTool);
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(fileEditTool);
  registry.register(fileListTool);
  registry.register(fileSearchTool);
  // Office tools — gated behind the "office-editing" skill, NOT always-on.
  for (const tool of OFFICE_TOOLS) {
    registry.register(tool);
  }
  // Meta-tools (create_agent, create_skill, attach_skill) — gated behind the
  // root agent designation + per-grant toggles in rootGrants. NOT always-on.
  // The runner unions these into alwaysOn only for the entity's root agent.
  for (const tool of META_TOOLS) {
    registry.register(tool);
  }
}

/**
 * Names of the always-on built-in tools.
 * Pass these as alwaysOn to computeToolWhitelist().
 */
export const ALWAYS_ON_TOOLS = [
  'return_result',
  'save_memory',
  'query_memory',
  'mark_memory_helpful',
  'mark_memory_outdated',
  'dashboard_publish',
  'file_read',
  'file_write',
  'file_edit',
  'file_list',
  'file_search',
] as const;
export type AlwaysOnTool = (typeof ALWAYS_ON_TOOLS)[number];

/**
 * Documentation for the always-on built-in tools.
 * Source of truth for the "Built-in capabilities" block injected into every
 * agent's system prompt by buildSystemPrompt() in @nodal-agents/orchestration.
 *
 * Order matches ALWAYS_ON_TOOLS. Adding a new always-on tool requires updating
 * BOTH this array and ALWAYS_ON_TOOLS — keep them in sync. The `{name, description}`
 * shape is data-driven from the underlying tool definitions, so the prompt block
 * always reflects the canonical tool docs.
 */
export const ALWAYS_ON_TOOL_DOCS: ReadonlyArray<{ name: string; description: string }> = [
  { name: returnResultTool.name, description: returnResultTool.description },
  { name: saveMemoryTool.name, description: saveMemoryTool.description },
  { name: queryMemoryTool.name, description: queryMemoryTool.description },
  { name: markMemoryHelpfulTool.name, description: markMemoryHelpfulTool.description },
  { name: markMemoryOutdatedTool.name, description: markMemoryOutdatedTool.description },
  { name: dashboardPublishTool.name, description: dashboardPublishTool.description },
  { name: fileReadTool.name, description: fileReadTool.description },
  { name: fileWriteTool.name, description: fileWriteTool.description },
  { name: fileEditTool.name, description: fileEditTool.description },
  { name: fileListTool.name, description: fileListTool.description },
  { name: fileSearchTool.name, description: fileSearchTool.description },
];
