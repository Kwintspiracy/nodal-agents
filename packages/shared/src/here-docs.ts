// here-docs.ts — the here-documents of a shell text (review of #683).
//
// `bash <<EOF … EOF` feeds the lines between the markers to a program on its
// standard input. To the command reader they are not commands: `cat <<EOF >
// notes.txt` writes them as data. To the program that receives them they may
// be its source (`bash`, `python -`), read in its language.
//
// Only what sh reads as the operator opens one: `<<` outside quotes, outside
// a comment, outside `$(( … ))` arithmetic (review pass 3 of #683: `echo
// "usage: <<END"` or `# <<END` opened a body that swallowed the script). And a
// line is taken out of what is judged only when it belongs to a body that
// ends with its marker: an unterminated one leaves every line read as a
// command. A net may over-ask; it never drops a line it cannot place.
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

interface Operator {
  index: number;
  length: number;
  strip: boolean;
  marker: string;
}

const MARKER = /^<<(-?)[ \t]*\\?(["']?)([A-Za-z_][\w.-]*)\2/;

/** The here-document operators of one line, as sh reads them. */
function operators(line: string): Operator[] {
  const found: Operator[] = [];
  let quote: '"' | "'" | null = null;
  let arithmetic = 0;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k] ?? '';
    if (quote !== null) {
      if (ch === '\\' && quote === '"') k++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      k++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // A comment runs to the end of the line.
    if (ch === '#' && (k === 0 || /[\s;&|(]/.test(line[k - 1] ?? ''))) break;
    if (line.startsWith('$((', k)) {
      arithmetic++;
      k += 2;
      continue;
    }
    if (arithmetic > 0) {
      if (line.startsWith('))', k)) {
        arithmetic--;
        k++;
      }
      continue;
    }
    if (line.startsWith('<<', k) && line[k + 2] !== '<' && line[k - 1] !== '<') {
      const m = MARKER.exec(line.slice(k));
      if (m !== null) {
        found.push({ index: k, length: m[0].length, strip: m[1] === '-', marker: m[3] ?? '' });
        k += m[0].length - 1;
      }
    }
  }
  return found;
}

/**
 * The here-documents of `text` (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`), and
 * the text without them: their operators become spaces and their bodies
 * empty lines, so columns and line numbers hold. A body whose end marker never
 * comes is no here-document here: its lines stay in the text, read as
 * commands.
 */
export function splitHereDocs(text: string): HereDocSplit {
  if (!text.includes('<<')) return { text, docs: [] };
  const lines = text.split('\n');
  const out = [...lines];
  const docs: HereDoc[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let next = i + 1;
    const taken: Operator[] = [];
    for (const op of operators(line)) {
      const body: string[] = [];
      let j = next;
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
      if (!ended) break;
      docs.push({
        before: line.slice(0, op.index),
        body: body.join('\n'),
        line: i,
        raw: lines.slice(next, j + 1).join('\n'),
      });
      for (let k = next; k <= j; k++) out[k] = '';
      taken.push(op);
      next = j + 1;
    }
    // The operators go too: read again, the text has no here-document left.
    if (taken.length > 0) {
      let rewritten = line;
      for (const op of taken)
        rewritten =
          rewritten.slice(0, op.index) +
          ' '.repeat(op.length) +
          rewritten.slice(op.index + op.length);
      out[i] = rewritten;
    }
    i = next - 1;
  }
  return { text: out.join('\n'), docs };
}
