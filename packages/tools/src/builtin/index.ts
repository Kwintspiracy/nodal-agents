// Built-in tools registration
// Call registerBuiltins(registry) once at startup to make all built-in tools available.

import type { ToolRegistry } from '../types';
import { returnResultTool } from './return-result';
import { saveMemoryTool } from './save-memory';
import { queryMemoryTool } from './query-memory';
import { webSearchTool } from './web-search';
import { dashboardPublishTool } from './dashboard-publish';

export { returnResultTool } from './return-result';
export { saveMemoryTool } from './save-memory';
export { queryMemoryTool } from './query-memory';
export { webSearchTool } from './web-search';
export { dashboardPublishTool, DashboardPublishInputSchema } from './dashboard-publish';
export type { DashboardPublishInput } from './dashboard-publish';

/**
 * Register all built-in tools into the given registry.
 * Idempotent — calling twice just overwrites with the same tools.
 */
export function registerBuiltins(registry: ToolRegistry): void {
  registry.register(returnResultTool);
  registry.register(saveMemoryTool);
  registry.register(queryMemoryTool);
  registry.register(webSearchTool);
  registry.register(dashboardPublishTool);
}

/**
 * Names of the always-on built-in tools.
 * Pass these as alwaysOn to computeToolWhitelist().
 */
export const ALWAYS_ON_TOOLS = [
  'return_result',
  'save_memory',
  'query_memory',
  'dashboard_publish',
] as const;
export type AlwaysOnTool = (typeof ALWAYS_ON_TOOLS)[number];

/**
 * Documentation for the always-on built-in tools.
 * Source of truth for the "Built-in capabilities" block injected into every
 * agent's system prompt by buildSystemPrompt() in @nodalai/orchestration.
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
  { name: dashboardPublishTool.name, description: dashboardPublishTool.description },
];
