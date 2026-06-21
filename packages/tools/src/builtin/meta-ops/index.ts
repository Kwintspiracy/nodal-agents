// meta-ops/index.ts — barrel exporting all meta-tools as a single array.
// Import META_TOOLS in the builtin index.ts to register every meta-tool
// with a single spread.

export { createSkillTool } from './create-skill';
export { updateSkillTool } from './update-skill';
export { assignSkillTool } from './assign-skill';
export { createAgentTool } from './create-agent';
export { updateAgentTool } from './update-agent';
export { attachAgentTool } from './attach-agent';
export { createMcpTool } from './create-mcp';
export { attachMcpTool } from './attach-mcp';
export { createConnectorTool } from './create-connector';
export { attachConnectorTool } from './attach-connector';
export { detachAgentTool } from './detach-agent';
export { detachSkillTool } from './detach-skill';
export { detachMcpTool } from './detach-mcp';
export { detachConnectorTool } from './detach-connector';
export { createScheduleTool, updateScheduleTool, toggleScheduleTool } from './schedule-ops';
export { runScheduleTool } from './run-schedule';

import { createSkillTool } from './create-skill';
import { updateSkillTool } from './update-skill';
import { assignSkillTool } from './assign-skill';
import { createAgentTool } from './create-agent';
import { updateAgentTool } from './update-agent';
import { attachAgentTool } from './attach-agent';
import { createMcpTool } from './create-mcp';
import { attachMcpTool } from './attach-mcp';
import { createConnectorTool } from './create-connector';
import { attachConnectorTool } from './attach-connector';
import { detachAgentTool } from './detach-agent';
import { detachSkillTool } from './detach-skill';
import { detachMcpTool } from './detach-mcp';
import { detachConnectorTool } from './detach-connector';
import { createScheduleTool, updateScheduleTool, toggleScheduleTool } from './schedule-ops';
import { runScheduleTool } from './run-schedule';
import type { ToolDefinition } from '../../types';
import type { z } from 'zod';

export const META_TOOLS: ToolDefinition<z.ZodTypeAny, unknown>[] = [
  createSkillTool,
  updateSkillTool,
  assignSkillTool,
  createAgentTool,
  updateAgentTool,
  attachAgentTool,
  createMcpTool,
  attachMcpTool,
  createConnectorTool,
  attachConnectorTool,
  detachAgentTool,
  detachSkillTool,
  detachMcpTool,
  detachConnectorTool,
  createScheduleTool,
  updateScheduleTool,
  toggleScheduleTool,
  runScheduleTool,
];
