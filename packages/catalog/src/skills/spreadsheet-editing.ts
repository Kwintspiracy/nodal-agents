// catalog/skills/spreadsheet-editing.ts — system skill, shipped with the product.
//
// TOKEN-002: the spreadsheet third of `office-editing`. An agent that only
// works on workbooks assigns this instead and stops carrying the docx_* and
// pptx_* schemas (~3k tokens of the ~7.2k Office total, every turn).
//
// `office-editing` still ships and still grants all three families — an agent
// that genuinely does all of it keeps one skill instead of three, and no
// existing assignment breaks.

import type { SystemSkill } from '../types';
import {
  OFFICE_PATH_CONVENTIONS,
  officeReadModifySave,
  OFFICE_COMMON_LIMITS,
} from './office-shared';

export const XLSX_BUILTINS = [
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
] as const;

export const spreadsheetEditingSkill: SystemSkill = {
  slug: 'spreadsheet-editing',
  name: 'Spreadsheet editing',
  description:
    'Create and edit Excel workbooks in the agent workspace — values, formulae, formatting, ' +
    'rows/columns, merges and freeze panes. Spreadsheets only (no Word or PowerPoint).',
  requiredBuiltins: [...XLSX_BUILTINS],
  toolGroup: true,
  content: `## Spreadsheet editing discipline

This skill unlocks the \`xlsx_*\` tools for working with Excel workbooks stored in the agent's workspace.

${OFFICE_PATH_CONVENTIONS}

${officeReadModifySave('xlsx_read', ['xlsx_set_cell', 'xlsx_set_range'])}

Use \`xlsx_find_cells\` to locate data before mutating it. \`xlsx_delete_rows\` and \`xlsx_delete_columns\` are irreversible — confirm the range with \`xlsx_read\` first and present what will be deleted before proceeding.

### Capabilities

Read with \`xlsx_read\` and \`xlsx_find_cells\`; create with \`xlsx_create\`; edit in place with full fidelity — values, formulae (\`=SUM(...)\`), formatting (\`xlsx_format_range\`), and structure (insert/delete rows and columns, merge, widths, freeze panes). Styles and formulae elsewhere in the workbook are preserved.

### Known limits — state them, never work around them silently

- **Formulae are written, not computed**: \`=SUM(B2:B10)\` is stored and recalculates when the user opens the file. Reading a formula cell returns the formula (and the last cached value if present), not a fresh computation.
- **No pivot-table or chart support** (library limit): they cannot be created, and the library cannot preserve existing ones through an edit either — so any mutation tool REFUSES a workbook that contains charts or pivot tables (\`ok:false\` with the reason) instead of silently destroying them. Tell the user why, and offer to work on a copy without the charts, or compute the aggregation yourself and write a formatted summary sheet with formulas.
${OFFICE_COMMON_LIMITS}

### When to ask for confirmation

- Before \`xlsx_delete_rows\` / \`xlsx_delete_columns\`: always confirm range and expected impact.
- Before \`xlsx_create\` with \`overwrite:true\`: confirm the file should be replaced.
`,
};
