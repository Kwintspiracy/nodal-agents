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
  SkillFileError,
  SkillFileReadInputSchema,
  SkillFileListInputSchema,
} from './skill-files';
export type {
  SkillFileReadInput,
  SkillFileReadOutput,
  SkillFileListInput,
  SkillFileListOutput,
} from './skill-files';

/** All skill-ops tools, for bulk registration. */
export const SKILL_TOOLS: ToolDefinition<z.ZodTypeAny, unknown>[] = [
  skillFileReadTool,
  skillFileListTool,
];
