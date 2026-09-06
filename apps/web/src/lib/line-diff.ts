// line-diff.ts — a minimal line-level diff, for showing a skill update's real
// text before it is installed (SKILL-003).
//
// The LCS itself lives in `@nodal-agents/shared` (fragment-diff.ts) since P11:
// the conversation feed needs the same comparison to render a `file_edit`'s
// fragment, and two hand-written LCS passes would have drifted at the first
// adjustment. Presenting two different texts as equal is exactly the bug a diff
// must never have, so there is one algorithm and this file is its `op`-shaped
// view — the vocabulary the skill-update preview was already written against.

import { fragmentDiff, FRAGMENT_DIFF_MAX_LINES } from '@nodal-agents/shared';

export type DiffOp = 'same' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  text: string;
}

/** Re-exported under its original name — see FRAGMENT_DIFF_MAX_LINES. */
export const MAX_DIFF_LINES = FRAGMENT_DIFF_MAX_LINES;

const OP: Readonly<Record<' ' | '+' | '-', DiffOp>> = {
  ' ': 'same',
  '+': 'add',
  '-': 'remove',
};

/**
 * Diff two texts by line. Returns the full script of operations in order —
 * `same` lines included, so the caller can show context or collapse it.
 *
 * Beyond MAX_DIFF_LINES on either side, degrades to "remove everything, add
 * everything" instead of hanging the tab.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  return fragmentDiff(before, after).lines.map((l) => ({ op: OP[l.kind], text: l.text }));
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === 'add') added++;
    else if (l.op === 'remove') removed++;
  }
  return { added, removed };
}

/**
 * Drop runs of unchanged lines longer than `context`, keeping `context` lines
 * on each side of every change. Returns the kept lines with `null` marking
 * each elided run, so the UI can render a "… N unchanged lines" separator.
 *
 * A skill's SKILL.md is mostly prose that did not change; showing all of it
 * buries the two lines that did — which is the failure mode this whole finding
 * is about, only in the other direction.
 */
export function collapseUnchanged(lines: DiffLine[], context = 3): Array<DiffLine | null> {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.op === 'same') continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      keep[k] = true;
    }
  }
  const out: Array<DiffLine | null> = [];
  let eliding = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      out.push(lines[i]!);
      eliding = false;
    } else if (!eliding) {
      out.push(null);
      eliding = true;
    }
  }
  return out;
}
