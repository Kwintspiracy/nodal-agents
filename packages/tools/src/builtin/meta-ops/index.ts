// meta-ops/index.ts — barrel exporting all meta-tools as a single array.
// Import META_TOOLS in the builtin index.ts to register every meta-tool
// with a single spread.

export { createSkillTool } from './create-skill';
export { updateSkillTool } from './update-skill';
export { assignSkillTool } from './assign-skill';
export { createAgentTool } from './create-agent';
export { createMcpTool } from './create-mcp';
export { createConnectorTool } from './create-connector';

import { createSkillTool } from './create-skill';
import { updateSkillTool } from './update-skill';
import { assignSkillTool } from './assign-skill';
import { createAgentTool } from './create-agent';
import { createMcpTool } from './create-mcp';
import { createConnectorTool } from './create-connector';
import type { ToolDefinition } from '../../types';
import type { z } from 'zod';

export const META_TOOLS: ToolDefinition<z.ZodTypeAny, unknown>[] = [
  createSkillTool,
  updateSkillTool,
  assignSkillTool,
  createAgentTool,
  createMcpTool,
  createConnectorTool,
];
