// @nodalai/tools — ToolRegistry implementation

import type { z } from 'zod';
import { RISK_LEVELS } from './types.js';
import type {
  ToolDefinition,
  ToolRegistry,
  ToolListFilter,
  AiSdkTool,
  RiskLevel,
} from './types.js';

// ─── createToolRegistry ────────────────────────────────────────────────────────

/**
 * Creates a mutable ToolRegistry instance.
 * Registries are typically created once per application and shared.
 * For tests, create a fresh registry per test.
 */
export function createToolRegistry(): ToolRegistry {
  const _tools = new Map<string, ToolDefinition<z.ZodTypeAny, unknown>>();

  return {
    register<TInput extends z.ZodTypeAny, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
      // Overwrite if already registered (allows adapters to refresh).
      // The double cast is required because TypeScript's strict generic
      // invariance prevents direct assignment: ToolDefinition<TInput, TOutput>
      // is not assignable to ToolDefinition<ZodTypeAny, unknown> because
      // TInput's execute signature uses a concrete inferred type.
      _tools.set(tool.name, tool as unknown as ToolDefinition<z.ZodTypeAny, unknown>);
    },

    get(name: string): ToolDefinition<z.ZodTypeAny, unknown> | undefined {
      return _tools.get(name);
    },

    list(filter?: ToolListFilter): ToolDefinition<z.ZodTypeAny, unknown>[] {
      let tools = Array.from(_tools.values());

      if (filter?.riskLevels && filter.riskLevels.length > 0) {
        // Validate that requested riskLevels are actually in the known set.
        // This catches typos at call-site before they silently return empty lists.
        const validSet = new Set<string>(RISK_LEVELS);
        const allowed = new Set<RiskLevel>(filter.riskLevels.filter((rl) => validSet.has(rl)));
        tools = tools.filter((t) => allowed.has(t.riskLevel));
      }

      if (filter?.names && filter.names.length > 0) {
        const allowed = new Set(filter.names);
        tools = tools.filter((t) => allowed.has(t.name));
      }

      return tools;
    },

    toAiSdkTools(filter?: { names?: string[] }): Record<string, AiSdkTool> {
      const source =
        filter?.names && filter.names.length > 0 ? this.list({ names: filter.names }) : this.list();

      const result: Record<string, AiSdkTool> = {};
      for (const tool of source) {
        result[tool.name] = {
          description: tool.description,
          parameters: tool.inputSchema,
        };
      }
      return result;
    },
  };
}
