// catalog/skills/office-editing.ts — system skill, shipped with the product.
//
// Gates access to xlsx_*, docx_*, and pptx_* builtins via requiredBuiltins.
// Only agents holding this skill receive these tools in their whitelist.

import type { SystemSkill } from '../types';

export const officeEditingSkill: SystemSkill = {
  slug: 'office-editing',
  name: 'Office editing',
  description:
    'Read and edit Excel, Word, and PowerPoint files stored in the agent workspace. ' +
    'Excel: full lossless in-place edit. Word/PPT: create new + read existing.',
  requiredBuiltins: [
    'xlsx_read',
    'xlsx_set_cell',
    'xlsx_set_range',
    'xlsx_append_rows',
    'xlsx_add_sheet',
    'xlsx_create',
    'xlsx_delete_rows',
    'docx_read',
    'docx_create',
    'docx_append_paragraphs',
    'pptx_read',
    'pptx_create',
  ],
  content: `## Office editing discipline

This skill unlocks the \`xlsx_*\`, \`docx_*\`, and \`pptx_*\` tools for working with Office files stored in the agent's workspace.

### Path conventions

All Office tools take a **workspace-relative path**. For agents with a single workspace the label is optional (e.g. \`report.xlsx\`). For agents with multiple workspaces, prefix with the workspace label and a slash (e.g. \`docs/report.xlsx\` for the workspace labelled "docs"). Never use absolute paths.

### Read → modify → save discipline

1. **Always read before writing.** Call \`xlsx_read\` / \`docx_read\` / \`pptx_read\` first to confirm the file exists and understand its current state.
2. **One operation at a time.** Prefer targeted mutations (\`xlsx_set_cell\`, \`xlsx_set_range\`) over full rewrites when only part of the data changes.
3. **Confirm destructive operations.** \`xlsx_delete_rows\` is irreversible — always confirm the row range with \`xlsx_read\` first and present what will be deleted to the user before proceeding.
4. **Fail loud on error.** If a tool returns \`ok:false\`, surface the \`reason\` to the user immediately. Do NOT silently retry a different path.

### Explicit capability limits (V1)

| Format | Read | Create new | In-place edit |
|--------|------|------------|---------------|
| Excel (.xlsx) | ✅ xlsx_read | ✅ xlsx_create | ✅ Full lossless edit (exceljs preserves formulae, styles, charts) |
| Word (.docx) | ✅ docx_read (plain text) | ✅ docx_create | ⚠ docx_append_paragraphs only — formatting is LOST on rebuild |
| PowerPoint (.pptx) | ✅ pptx_read (plain text) | ✅ pptx_create | ❌ Not supported in V1 |

When a user asks to "edit an existing Word/PPT file", clarify the fidelity limit before proceeding:
- For Word: offer to append paragraphs (with the caveat that original formatting will be stripped) or create a new file.
- For PowerPoint: create a new presentation based on the content read from the existing one.

### 25 MiB file size cap

Office tools enforce a hard 25 MiB cap per file (read and write). Files larger than this cannot be processed — inform the user and suggest splitting or compressing.

### When to ask for confirmation

- Before \`xlsx_delete_rows\`: always confirm row range and expected impact.
- Before \`docx_append_paragraphs\` on a complex document: warn that original formatting will be lost.
- Before \`xlsx_create\` / \`docx_create\` / \`pptx_create\` with \`overwrite:true\`: confirm the file should be replaced.
`,
};
