// catalog/skills/office-shared.ts — the discipline every Office skill shares.
//
// TOKEN-002 (audit 2026-08-07) split the single `office-editing` skill into
// per-format siblings, so an agent that only ever touches spreadsheets no
// longer carries the Word and PowerPoint tool schemas. Measured on the real
// definitions: 24 tools ≈ 7.2k tokens of schema, split xlsx 4.1k / pptx 1.7k /
// docx 1.3k — so a spreadsheets-only agent drops ~3k tokens per turn, and a
// documents-only agent ~5.8k.
//
// The guidance itself is identical across formats, so it lives here ONCE.
// Duplicating it into three files is how three copies quietly drift apart.

/** Path rules — identical for xlsx, docx and pptx. */
export const OFFICE_PATH_CONVENTIONS = `### Path conventions

All Office tools take a **workspace-relative path**. For agents with a single workspace the label is optional (e.g. \`report.xlsx\`). For agents with multiple workspaces, prefix with the workspace label and a slash (e.g. \`docs/report.xlsx\` for the workspace labelled "docs"). Never use absolute paths.`;

/** The read → modify → save loop, stated per format via the tool names passed in. */
export function officeReadModifySave(readTool: string, targetedTools: string[]): string {
  return `### Read → modify → save discipline

1. **Always read before writing.** Call \`${readTool}\` first to confirm the file exists and understand its current state.
2. **One operation at a time.** Prefer targeted mutations (${targetedTools
    .map((t) => `\`${t}\``)
    .join(', ')}) over full rewrites when only part of the content changes.
3. **Fail loud on error.** If a tool returns \`ok:false\`, surface the \`reason\` to the user immediately. Do NOT silently retry a different path.`;
}

/** Limits that hold across every format. */
export const OFFICE_COMMON_LIMITS = `- **25 MiB cap per file** (read and write). Inform the user and suggest splitting if exceeded.`;
