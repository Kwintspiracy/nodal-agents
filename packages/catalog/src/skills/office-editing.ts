// catalog/skills/office-editing.ts — system skill, shipped with the product.
//
// Gates access to xlsx_*, docx_*, and pptx_* builtins via requiredBuiltins.
// Only agents holding this skill receive these tools in their whitelist.

import type { SystemSkill } from '../types';

export const officeEditingSkill: SystemSkill = {
  slug: 'office-editing',
  name: 'Office editing',
  description:
    'Create and edit Excel, Word, and PowerPoint files stored in the agent workspace. ' +
    'Excel: full lossless in-place edit + formatting. Word/PPT: create, append, and replace text in existing files.',
  requiredBuiltins: [
    'xlsx_read',
    'xlsx_set_cell',
    'xlsx_set_range',
    'xlsx_append_rows',
    'xlsx_add_sheet',
    'xlsx_create',
    'xlsx_delete_rows',
    'xlsx_format_range',
    'xlsx_insert_rows',
    'xlsx_insert_columns',
    'xlsx_delete_columns',
    'xlsx_merge_cells',
    'xlsx_unmerge_cells',
    'xlsx_set_column_widths',
    'xlsx_freeze_panes',
    'xlsx_find_cells',
    'docx_read',
    'docx_create',
    'docx_append_paragraphs',
    'docx_replace_text',
    'pptx_read',
    'pptx_create',
    'pptx_append_slides',
    'pptx_replace_text',
  ],
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
