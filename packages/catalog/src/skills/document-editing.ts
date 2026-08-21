// catalog/skills/document-editing.ts — system skill, shipped with the product.
//
// TOKEN-002: the Word third of `office-editing`. An agent that only writes
// documents assigns this and drops the xlsx_* and pptx_* schemas (~5.8k of the
// ~7.2k Office total, every turn).

import type { SystemSkill } from '../types';
import {
  OFFICE_PATH_CONVENTIONS,
  officeReadModifySave,
  OFFICE_COMMON_LIMITS,
} from './office-shared';

export const DOCX_BUILTINS = [
  'docx_read',
  'docx_create',
  'docx_append_paragraphs',
  'docx_replace_text',
] as const;

export const documentEditingSkill: SystemSkill = {
  slug: 'document-editing',
  name: 'Document editing',
  description:
    'Create and edit Word documents in the agent workspace — headings, lists, tables, images, ' +
    'append and find/replace. Documents only (no Excel or PowerPoint).',
  requiredBuiltins: [...DOCX_BUILTINS],
  content: `## Document editing discipline

This skill unlocks the \`docx_*\` tools for working with Word documents stored in the agent's workspace.

${OFFICE_PATH_CONVENTIONS}

${officeReadModifySave('docx_read', ['docx_replace_text', 'docx_append_paragraphs'])}

### Capabilities

Read with \`docx_read\` (text including tables); create with \`docx_create\` (headings, bold/italic, bullet and numbered lists, tables, images, page breaks); edit in place with \`docx_append_paragraphs\` (original formatting preserved) and \`docx_replace_text\` (literal find/replace).

### Known limits — state them, never work around them silently

- **Text replacement is literal and run-scoped**: \`docx_replace_text\` replaces occurrences that live inside a single text run. Occurrences split across formatting runs are counted in \`skipped_fragmented\` — report them to the user rather than guessing.
${OFFICE_COMMON_LIMITS}

### When to ask for confirmation

- Before \`docx_create\` with \`overwrite:true\`: confirm the file should be replaced.
`,
};
