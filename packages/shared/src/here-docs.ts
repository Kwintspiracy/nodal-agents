// here-docs.ts — the here-documents of a shell text (review of #683).
//
// `bash <<EOF … EOF` feeds the lines between the markers to a program on its
// standard input: to `bash` or `python -`, its source, read in its language.
//
// Where a here-document stands, and where its body ends, is read by THE
// scanner of sh (`hereDocuments`, catastrophic-command.ts): `<<` in quotes, in
// a comment, in arithmetic or in `[[ ]]` opens nothing, and a body is data to
// the scan (reviews 3, 4 and 5 of #683). Only a body that ends with its
// marker is a here-document; an unterminated one stays read as lines.
//
// Pure: no filesystem.

import { hereDocuments, type StdinReceiver } from './catastrophic-command';

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
  /** Who reads the body, by the common reading of its line. */
  receiver: StdinReceiver;
}

/** The here-documents of `text` that end with their marker, as sh's scan finds them. */
export function hereDocs(text: string): HereDoc[] {
  if (!text.includes('<<')) return [];
  return hereDocuments(text).map((doc) => {
    const lineStart = text.lastIndexOf('\n', doc.index - 1) + 1;
    const body = text.slice(doc.bodyStart, doc.bodyEnd).replace(/\r$/gm, '');
    return {
      before: text.slice(lineStart, doc.index),
      body: doc.strip ? body.replace(/^\t+/gm, '') : body,
      line: text.slice(0, doc.index).split('\n').length - 1,
      raw: text.slice(doc.bodyStart, doc.end).replace(/\r?\n$/, ''),
      receiver: doc.receiver,
    };
  });
}
