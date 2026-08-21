// line-diff.ts — a minimal line-level diff, for showing a skill update's real
// text before it is installed (SKILL-003).
//
// Written here rather than pulled from a package: the whole point of this diff
// is to let someone trust what they are about to put into their agents' system
// prompts, and adding a dependency to render it would be a strange trade. It is
// a textbook LCS over lines — no heuristics, no fuzzy matching, nothing that
// could quietly present two different texts as equal.

export type DiffOp = 'same' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  text: string;
}

/**
 * Lines beyond this are not diffed line-by-line. LCS is O(n×m): two 5000-line
 * texts would be 25M cells, computed in the browser, to render a wall nobody
 * reads. Past the cap the caller gets a whole-file replace, which is honest
 * about being coarse rather than pretending to be precise.
 */
export const MAX_DIFF_LINES = 2000;

/**
 * Diff two texts by line. Returns the full script of operations in order —
 * `same` lines included, so the caller can show context or collapse it.
 *
 * Beyond MAX_DIFF_LINES on either side, degrades to "remove everything, add
 * everything" instead of hanging the tab.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length === 0 ? [] : before.split('\n');
  const b = after.length === 0 ? [] : after.split('\n');

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text): DiffLine => ({ op: 'remove', text })),
      ...b.map((text): DiffLine => ({ op: 'add', text })),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: 'remove', text: a[i]! });
      i++;
    } else {
      out.push({ op: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ op: 'remove', text: a[i++]! });
  while (j < b.length) out.push({ op: 'add', text: b[j++]! });
  return out;
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
