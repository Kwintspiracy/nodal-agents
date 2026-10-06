// here-docs.ts — the here-documents of a shell text (review of #683).
//
// `bash <<EOF … EOF` feeds the lines between the markers to a program on its
// standard input: to `bash` or `python -`, its source, read in its language.
//
// Where an operator stands is read by THE scanner of sh (`hereDocOperators`,
// catastrophic-command.ts): `<<` in quotes, in a comment, in arithmetic or in
// `[[ ]]` opens nothing (review passes 3 and 4 of #683). Nothing here takes
// a line away from what is judged: every line of a body is still read as a
// command too, which may over-ask, never under-report. Only a body that ends
// with its marker is a source; an unterminated one is no here-document.
//
// Pure: no filesystem.

import { hereDocOperators } from './catastrophic-command';

/** One here-document: where it opens, what it feeds, as written. */
export interface HereDoc {
  /** The opening line, up to the `<<` operator: where its program is. */
  before: string;
  /** The lines between the opening line and the end marker. */
  body: string;
  /** 0-based index of the opening line in the text's lines. */
  line: number;
  /** The body and the end marker, as written: what the opening line carries. */
  raw: string;
}

/**
 * The here-documents of `text` that end with their marker. A `<<` inside a
 * body already taken is part of that body, not an operator.
 */
export function hereDocs(text: string): HereDoc[] {
  if (!text.includes('<<')) return [];
  const lines = text.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  const lineOf = (index: number): number => {
    let i = 0;
    while (i + 1 < starts.length && (starts[i + 1] ?? 0) <= index) i++;
    return i;
  };
  const docs: HereDoc[] = [];
  // The line the next body of an opening line starts on: operators on one
  // line feed bodies in turn, and nothing inside a body taken is an operator.
  const bodyFrom = new Map<number, number>();
  let taken = -1;
  for (const op of hereDocOperators(text)) {
    const i = lineOf(op.index);
    if (i <= taken && !bodyFrom.has(i)) continue;
    const from = bodyFrom.get(i) ?? i + 1;
    const body: string[] = [];
    let j = from;
    let ended = false;
    while (j < lines.length) {
      const l = (lines[j] ?? '').replace(/\r$/, '');
      if ((op.strip ? l.replace(/^\t+/, '') : l) === op.marker) {
        ended = true;
        break;
      }
      body.push(op.strip ? l.replace(/^\t+/, '') : l);
      j++;
    }
    if (!ended) continue;
    const line = lines[i] ?? '';
    docs.push({
      before: line.slice(0, op.index - (starts[i] ?? 0)),
      body: body.join('\n'),
      line: i,
      raw: lines.slice(from, j + 1).join('\n'),
    });
    bodyFrom.set(i, j + 1);
    taken = Math.max(taken, j);
  }
  return docs;
}
