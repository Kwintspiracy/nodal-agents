// router/served-tools.ts — every tool DEFINITION the runner can serve a job
// that does not come from a connector or an MCP server.
//
// Three families, and this file is the one place that lists all of them:
//   - the built-in registry (`registerBuiltins`);
//   - the per-job factories of @nodal-agents/tools the runner instantiates in
//     execute.ts (the delivery tools, `list_conversations`, `load_tools`);
//   - the per-job delegation tools of this package (`assign_<teammate>`,
//     `create_task`, `list_tasks`), built from the same constructors the
//     runner's job uses.
// Connector operations and MCP tools are classified by their ORIGIN instead
// (`computeAgentToolOrigins`).
//
// It exists so that what reads a property of "every tool Nodal ships" reads
// the same complete list: the `egress` exhaustiveness test, and the bench
// space's pre-trial check, which names the tools it does not cover. A factory
// added to the runner and not here is the gap this file is the fix for: add it
// here, the test then requires its declaration.
//
// The definitions are READ, never executed: the delegation tools are built for
// a placeholder agent, and their database handle is never reached.

import {
  createListConversationsTool,
  createLoadToolsTool,
  createSendAudioTool,
  createSendFileTool,
  createSendImageTool,
  createSendVideoTool,
  createSendVoiceTool,
  createTelegramSendMessageTool,
  createToolRegistry,
  registerBuiltins,
} from '@nodal-agents/tools';
import type { z } from 'zod';
import { generateTaskTools } from '../planner/task-tools';
import { buildAssignTool } from './assign-tools';
import type { AgentId, AnyDrizzleDb, ToolDefinition } from '../types';

export type ServedTool = ToolDefinition<z.ZodTypeAny, unknown>;

/** Every non-connector, non-MCP tool the runner can serve, one definition per name. */
export function servedToolDefinitions(): ServedTool[] {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  const unreachedDb = null as unknown as AnyDrizzleDb;
  const perJob = [
    createTelegramSendMessageTool(),
    createSendImageTool(),
    createSendFileTool(),
    createSendVideoTool(),
    createSendAudioTool(),
    createSendVoiceTool(),
    createListConversationsTool(),
    createLoadToolsTool([]),
    buildAssignTool('Teammate', 'teammate'),
    ...generateTaskTools('placeholder' as AgentId, unreachedDb),
  ] as unknown as ServedTool[];
  const byName = new Map<string, ServedTool>();
  for (const t of [...registry.list(), ...perJob]) byName.set(t.name, t);
  return [...byName.values()];
}
