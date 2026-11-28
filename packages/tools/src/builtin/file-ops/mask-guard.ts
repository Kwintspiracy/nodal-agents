// file-ops/mask-guard.ts — a masked read is never written back.
//
// What a tool returns is masked before the model reads it (`executeTool`, the
// boundary): a key in a file the agent read reaches it as the placeholder
// `[secret hidden]`. Written back, that placeholder would replace the key in
// the file, and the file would be broken with nothing to say so.
//
// So no write tool puts the placeholder in a file that does not already hold
// it there: a write whose new text adds one is refused, and the refusal names
// the lines of the file that were hidden from this agent (from the same
// policy as the mask), so it can change the other lines and leave those. The
// rule is the same for every write tool: it reads the text the agent supplied,
// never the file's own bytes, so a file that legitimately holds the words is
// edited like any other.

import { holdsMaskPlaceholder, REDACTED_TEXT } from '@nodal-agents/shared';
import type { ToolContext } from '../../types';

const count = (text: string): number => text.split(REDACTED_TEXT).length - 1;

/**
 * The refusal of a write that would add the placeholder to the file, or
 * `null` when the write may go on.
 *
 * `before`: the text the write replaces (the whole file for an overwrite, the
 * quoted passage for an edit; `''` for a new file). `after`: what replaces it.
 * `current`: the file's whole content as it is now (`null`: no file yet), to
 * name its hidden lines.
 */
export async function refusePlaceholderWrite(
  ctx: ToolContext,
  args: { path: string; shownPath: string; before: string; after: string; current: string | null },
): Promise<string | null> {
  if (!holdsMaskPlaceholder(args.after) || count(args.after) <= count(args.before)) return null;
  if (!ctx.maskedLinesOf) {
    throw new Error(
      'masked_lines_unavailable: this write tool ran outside executeTool, which gives the ' +
        'masking policy it needs to name the hidden lines.',
    );
  }
  const lines = args.current === null ? [] : await ctx.maskedLinesOf(args.current);
  const where =
    lines.length > 0
      ? ` In "${args.shownPath}", the hidden values are on line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}.`
      : '';
  return (
    `Nothing was written: the text you gave holds "${REDACTED_TEXT}", the mark that stands for a ` +
    `value hidden from you in what a tool returned. Writing it would put the mark in place of ` +
    `the value.${where} Change the other lines only (file_edit, quoting text without the mark); ` +
    `the hidden values stay as they are on disk.`
  );
}

/**
 * The refusal of an edit whose quoted passage holds the placeholder and is not
 * in the file: the agent quoted a line it saw masked.
 */
export async function refuseQuotedPlaceholder(
  ctx: ToolContext,
  args: { path: string; shownPath: string; quoted: string; current: string },
): Promise<string | null> {
  if (!holdsMaskPlaceholder(args.quoted) || args.current.includes(args.quoted)) return null;
  return refusePlaceholderWrite(ctx, {
    path: args.path,
    shownPath: args.shownPath,
    before: '',
    after: args.quoted,
    current: args.current,
  });
}
