// catalog/skills/office-editing.ts — system skill, shipped with the product.
//
// Gates access to xlsx_*, docx_*, and pptx_* builtins via requiredBuiltins.
// Only agents holding this skill receive these tools in their whitelist.
//
// TOKEN-002 (audit 2026-08-07): this skill grants ALL THREE formats, which is
// ~7.2k tokens of tool schema on every turn. Most agents need one format, so
// the per-format siblings (spreadsheet-editing, document-editing,
// presentation-editing) now exist and are the better default — an agent that
// only touches workbooks saves ~3k tokens a turn, one that only writes
// documents ~5.8k.
//
// This aggregate stays because dropping it would break every agent already
// assigned to it, and because an agent that genuinely does all three formats
// should carry one skill rather than three. Its tool list is now COMPOSED from
// the three siblings rather than restated, so the four can never drift apart.

import type { SystemSkill } from '../types';
import { XLSX_BUILTINS } from './spreadsheet-editing';
import { DOCX_BUILTINS } from './document-editing';
import { PPTX_BUILTINS } from './presentation-editing';

export const officeEditingSkill: SystemSkill = {
  slug: 'office-editing',
  name: 'Office editing (all formats)',
  description:
    'Create and edit Excel, Word, and PowerPoint files stored in the agent workspace. ' +
    'Grants all three formats at once — if the agent only needs one, assign Spreadsheet, ' +
    'Document or Presentation editing instead and save the other formats’ context cost.',
  requiredBuiltins: [...XLSX_BUILTINS, ...DOCX_BUILTINS, ...PPTX_BUILTINS],
  toolGroup: true,
  content: `## Office editing discipline

This skill unlocks the \`xlsx_*\`, \`docx_*\`, and \`pptx_*\` tools for working with Office files stored in the agent's workspace.

### Path conventions

All Office tools take a **workspace-relative path**. For agents with a single workspace the label is optional (e.g. \`report.xlsx\`). For agents with multiple workspaces, prefix with the workspace label and a slash (e.g. \`docs/report.xlsx\` for the workspace labelled "docs"). Never use absolute paths.

### Read → modify → save discipline

1. **Always read before writing.** Call \`xlsx_read\` / \`docx_read\` / \`pptx_read\` first to confirm the file exists and understand its current state. Use \`xlsx_find_cells\` to locate data before mutating it.
2. **One operation at a time.** Prefer targeted mutations (\`xlsx_set_cell\`, \`xlsx_set_range\`, \`docx_replace_text\`, \`pptx_replace_text\`) over full rewrites when only part of the content changes.
3. **Confirm destructive operations.** \`xlsx_delete_rows\` and \`xlsx_delete_columns\` are irreversible — confirm the range with \`xlsx_read\` first and present what will be deleted before proceeding.
4. **Fail loud on error.** If a tool returns \`ok:false\`, surface the \`reason\` to the user immediately. Do NOT silently retry a different path.

### Capabilities

| Format | Read | Create new | In-place edit |
|--------|------|------------|---------------|
| Excel (.xlsx) | ✅ xlsx_read, xlsx_find_cells | ✅ xlsx_create | ✅ Full edit: values, formulae (\`=SUM(...)\`), formatting (xlsx_format_range), structure (insert/delete rows and columns, merge, widths, freeze panes). Existing styles and formulae elsewhere in the workbook are preserved. Workbooks containing charts or pivot tables are REFUSED for editing (see limits). |
| Word (.docx) | ✅ docx_read (text incl. tables) | ✅ docx_create (headings, bold/italic, bullet/numbered lists, tables, images, page breaks) | ✅ docx_append_paragraphs (faithful — original formatting preserved) and docx_replace_text (literal find/replace) |
| PowerPoint (.pptx) | ✅ pptx_read (per-slide text) | ✅ pptx_create (titles, bullets, body, images, tables, speaker notes, colour theme) | ✅ pptx_append_slides (existing slides untouched) and pptx_replace_text |

### Known limits — state them, never work around them silently

- **Formulae are written, not computed**: \`=SUM(B2:B10)\` is stored and recalculates when the user opens the file. Reading a formula cell returns the formula (and the last cached value if present), not a fresh computation.
- **No pivot-table or chart support** in .xlsx (library limit): they cannot be created, and the library cannot preserve existing ones through an edit either — so any mutation tool REFUSES a workbook that contains charts or pivot tables (\`ok:false\` with the reason) instead of silently destroying them. Tell the user why, and offer to work on a copy without the charts, or compute the aggregation yourself and write a formatted summary sheet with formulas.
- **Text replacement is literal and run-scoped**: \`docx_replace_text\` / \`pptx_replace_text\` replace occurrences that live inside a single text run. Occurrences split across formatting runs are counted in \`skipped_fragmented\` — report them to the user rather than guessing.
- **25 MiB cap per file** (read and write). Inform the user and suggest splitting if exceeded.

### When to ask for confirmation

- Before \`xlsx_delete_rows\` / \`xlsx_delete_columns\`: always confirm range and expected impact.
- Before \`xlsx_create\` / \`docx_create\` / \`pptx_create\` with \`overwrite:true\`: confirm the file should be replaced.
`,
};
