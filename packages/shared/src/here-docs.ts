// here-docs.ts — the here-documents of a shell text (review of #683).
//
// `bash <<EOF … EOF` feeds the lines between the markers to a program on its
// standard input. To the command reader they are not commands: `cat <<EOF >
// notes.txt` writes them as data. To the program that receives them they may
// be its source (`bash`, `python -`), read in its language.
//
// Pure: no filesystem.

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

export interface HereDocSplit {
  /** The text with each body and end marker replaced by empty lines. */
  text: string;
  docs: HereDoc[];
}

const OPERATOR = /(?<!<)<<(?!<)(-?)[ \t]*(["']?)([A-Za-z_][\w.-]*)\2/g;

/**
 * The here-documents of `text` (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`), and
 * the text without them: their operators become spaces and their bodies
 * empty lines, so columns and line numbers hold. An unterminated body runs to
 * the end of the text, as in sh.
 */
export function splitHereDocs(text: string): HereDocSplit {
  if (!text.includes('<<')) return { text, docs: [] };
  const lines = text.split('\n');
  const out = [...lines];
  const docs: HereDoc[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let next = i + 1;
    for (const m of line.matchAll(OPERATOR)) {
      const strip = m[1] === '-';
      const marker = m[3] ?? '';
      const body: string[] = [];
      let j = next;
      while (j < lines.length) {
        const l = (lines[j] ?? '').replace(/\r$/, '');
        if ((strip ? l.replace(/^\t+/, '') : l) === marker) break;
        body.push(strip ? l.replace(/^\t+/, '') : l);
        j++;
      }
      const end = Math.min(j, lines.length - 1);
      docs.push({
        before: line.slice(0, m.index ?? 0),
        body: body.join('\n'),
        line: i,
        raw: lines.slice(next, end + 1).join('\n'),
      });
      for (let k = next; k <= end; k++) out[k] = '';
      next = end + 1;
    }
    // The operators go too: read again, the text has no here-document left.
    if (next > i + 1) out[i] = line.replace(OPERATOR, (op) => ' '.repeat(op.length));
    i = next - 1;
  }
  return { text: out.join('\n'), docs };
}
