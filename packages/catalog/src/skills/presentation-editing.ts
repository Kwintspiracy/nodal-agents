// catalog/skills/presentation-editing.ts — system skill, shipped with the product.
//
// TOKEN-002: the PowerPoint third of `office-editing`. An agent that only
// builds decks assigns this and drops the xlsx_* and docx_* schemas (~5.4k of
// the ~7.2k Office total, every turn).

import type { SystemSkill } from '../types';
import {
  OFFICE_PATH_CONVENTIONS,
  officeReadModifySave,
  OFFICE_COMMON_LIMITS,
} from './office-shared';

export const PPTX_BUILTINS = [
  'pptx_read',
  'pptx_create',
  'pptx_append_slides',
  'pptx_replace_text',
] as const;

export const presentationEditingSkill: SystemSkill = {
  slug: 'presentation-editing',
  name: 'Presentation editing',
  description:
    'Create and edit PowerPoint decks in the agent workspace — slides, bullets, images, tables, ' +
    'speaker notes, append and find/replace. Presentations only (no Excel or Word).',
  requiredBuiltins: [...PPTX_BUILTINS],
  content: `## Presentation editing discipline

This skill unlocks the \`pptx_*\` tools for working with PowerPoint decks stored in the agent's workspace.

${OFFICE_PATH_CONVENTIONS}

${officeReadModifySave('pptx_read', ['pptx_replace_text', 'pptx_append_slides'])}

### Capabilities

Read with \`pptx_read\` (per-slide text); create with \`pptx_create\` (titles, bullets, body, images, tables, speaker notes, colour theme); edit in place with \`pptx_append_slides\` (existing slides untouched) and \`pptx_replace_text\`.

### Known limits — state them, never work around them silently

- **Text replacement is literal and run-scoped**: \`pptx_replace_text\` replaces occurrences that live inside a single text run. Occurrences split across formatting runs are counted in \`skipped_fragmented\` — report them to the user rather than guessing.
${OFFICE_COMMON_LIMITS}

### When to ask for confirmation

- Before \`pptx_create\` with \`overwrite:true\`: confirm the file should be replaced.
`,
};
