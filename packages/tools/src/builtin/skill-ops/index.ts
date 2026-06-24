// skill-ops — builtins for reading the bundled files of installed community
// skills. Gated behind a skill's requiredBuiltins (NOT always-on): an agent
// only receives skill_file_read / skill_file_list when it holds a skill that
// declares them.

import type { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { skillFileReadTool, skillFileListTool } from './skill-files';

export {
  skillFileReadTool,
  skillFileListTool,
  skillFileWriteTool,
  SkillFileError,
  SkillFileReadInputSchema,
  SkillFileListInputSchema,
  SkillFileWriteInputSchema,
} from './skill-files';
export type {
  SkillFileReadInput,
  SkillFileReadOutput,
  SkillFileListInput,
  SkillFileListOutput,
  SkillFileWriteInput,
  SkillFileWriteOutput,
} from './skill-files';

/**
 * Read-only skill-ops tools, for bulk registration. Gated behind a skill's
 * requiredBuiltins. skill_file_write is intentionally NOT here — it is
 * registered separately and whitelisted per agent × skill via the
 * files_writable flag (like run_skill_script), not via requiredBuiltins.
 */
export const SKILL_TOOLS: ToolDefinition<z.ZodTypeAny, unknown>[] = [
  skillFileReadTool,
  skillFileListTool,
];
