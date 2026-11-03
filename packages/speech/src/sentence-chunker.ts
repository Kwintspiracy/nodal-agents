// sentence-chunker.ts — a reply's text deltas, cut into sentences to speak (#943).
//
// WHY: a voice that waits for the whole reply before it says anything waits for
// the whole model AND the whole synthesis. Measured on the owner's stack on
// 2026-11-03: 10.1 s and 12.1 s from release to first sound. Cut into
// sentences, the first one goes to speech as soon as it is written, and the
// first sound waits for one sentence, not for the reply.
//
// It lives HERE, in packages/speech, beside the adapters, and not in the
// runner: any caller that turns a growing text into speech needs the same cut
// (the voice turn today, the spoken announcement of a finished job tomorrow,
// the reference client of #947), and a second copy would cut differently.
//
// The rule, one sentence: a sentence ends at `.`, `!`, `?` or `…` (closing
// quotes and brackets included), followed by whitespace, when the next word
// does not start in lower case and the word before is not a known
// abbreviation. A line break ends one too. Everything else waits:
//   - "3.5" and "19.30" have no whitespace after the full stop;
//   - "e.g. this", "Well... maybe" are followed by a lower-case word;
//   - "M. Dupont", "Dr. Smith", "J. K. Rowling" end on an abbreviation;
//   - `« oui. » Puis` closes its quote before the boundary.
// A boundary is only decided once the next non-space character is visible: a
// delta that ends on "end. " keeps it until the next delta says what follows.
//
// A very long sentence does not hold the first sound back. Past `softMax`
// characters it is cut at its last clause boundary (`,` `;` `:` or a dash
// followed by a space), and past `hardMax` at its last space. A comma without
// a space after it ("3,5") is never a clause boundary.

/** Words that end with a full stop without ending a sentence. Lower case, without the stop. */
const ABBREVIATIONS = new Set([
  // French
  'm',
  'mm',
  'mme',
  'mmes',
  'mlle',
  'mlles',
  'dr',
  'pr',
  'st',
  'ste',
  'av',
  'bd',
  'cf',
  'env',
  'p',
  'pp',
  'tél',
  // English
  'mr',
  'mrs',
  'ms',
  'sr',
  'jr',
  'vs',
  'e.g',
  'i.e',
  'approx',
  'dept',
  'jan',
  'feb',
  'apr',
  'jun',
  'jul',
  'aug',
  'sept',
  'oct',
  'nov',
  'dec',
  'inc',
  'ltd',
]);

const TERMINATORS = '.!?…';
const CLOSERS = '"\'»”’)]}';
const CLAUSE = ',;:';

export interface SentenceChunkerOptions {
  /** Past this many characters, an unfinished sentence is cut at its last clause boundary. */
  softMax?: number;
  /** Past this many, it is cut at its last space. */
  hardMax?: number;
  /** A clause cut never leaves a piece shorter than this. */
  minPiece?: number;
}

export interface SentenceChunker {
  /** A text delta. Returns the sentences it completed, in order. */
  push(delta: string): string[];
  /** The text is complete: what is left, as its last sentence(s). */
  flush(): string[];
}

/** Bounds measured against speech, not typography: 140 characters are about 25 words. */
export const SENTENCE_BOUNDS = { softMax: 140, hardMax: 260, minPiece: 30 } as const;

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

function isLower(ch: string): boolean {
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase();
}

/** A piece worth speaking: it carries at least one letter or digit. */
function speakable(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

/** The word right before index `end` (exclusive), without its own terminators. */
function wordBefore(text: string, end: number): string {
  let start = end;
  while (start > 0 && !isSpace(text[start - 1])) start--;
  return text
    .slice(start, end)
    .replace(/^["'«“‘([{]+/, '')
    .toLowerCase();
}

/**
 * Where the first complete sentence of `text` ends (exclusive), or -1 when no
 * boundary can be decided yet.
 */
function findBoundary(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') {
      if (speakable(text.slice(0, i))) return i + 1;
      continue;
    }
    if (!TERMINATORS.includes(ch)) continue;
    // The run of terminators ("?!", "...", "…").
    let j = i;
    while (j < text.length && TERMINATORS.includes(text[j]!)) j++;
    // Closing quotes and brackets right after the stop, and a French closing
    // guillemet after its space (« oui. »). Only `»` may stand after a space:
    // a `"` there is as likely to OPEN the next sentence.
    let k = j;
    for (;;) {
      if (k < text.length && CLOSERS.includes(text[k]!)) {
        k++;
        continue;
      }
      let s = k;
      while (s < text.length && isSpace(text[s]) && text[s] !== '\n') s++;
      if (s > k && text[s] === '»') k = s + 1;
      else break;
    }
    if (k >= text.length) return -1; // what follows is not written yet
    if (!isSpace(text[k])) {
      i = j - 1; // "3.5", "e.g.x": not a boundary
      continue;
    }
    // The next non-space character decides.
    let n = k;
    while (n < text.length && isSpace(text[n]) && text[n] !== '\n') n++;
    if (n >= text.length) return -1;
    if (text[n] === '\n') return n + 1;
    const next = text[n]!;
    const single = j - i === 1 && ch === '.';
    if (isLower(next)) {
      i = j - 1;
      continue;
    }
    if (single) {
      const word = wordBefore(text, i);
      // An abbreviation, or a single capital initial ("J. K. Rowling").
      const initial = word.length === 1 && /^\p{Lu}$/u.test(text.slice(i - 1, i));
      if (ABBREVIATIONS.has(word) || initial) {
        i = j - 1;
        continue;
      }
    }
    return k;
  }
  return -1;
}

/** Where to cut a sentence that is too long, or -1 to keep waiting. */
function clauseAt(text: string, i: number): boolean {
  const ch = text[i]!;
  const dash = (ch === '—' || ch === '–') && isSpace(text[i - 1]);
  return (CLAUSE.includes(ch) || dash) && isSpace(text[i + 1]);
}

/**
 * Where to cut a sentence that is too long, or -1 to keep waiting. The cut
 * depends only on the first `hardMax` characters, never on how many have
 * arrived: the last clause boundary before `softMax`, else the first one
 * after it, else the last space before `hardMax`. A stream cut one character
 * at a time and the same text in one delta give the same pieces.
 */
function findCut(text: string, softMax: number, hardMax: number, minPiece: number): number {
  if (text.length <= softMax) return -1;
  const limit = Math.min(text.length - 1, hardMax);
  let before = -1;
  for (let i = minPiece; i < limit; i++) {
    if (!clauseAt(text, i)) continue;
    if (i < softMax) before = i + 1;
    else return before !== -1 ? before : i + 1;
  }
  if (before !== -1) return before;
  if (text.length <= hardMax) return -1;
  const space = text.lastIndexOf(' ', hardMax);
  return space > minPiece ? space : hardMax;
}

export function createSentenceChunker(opts: SentenceChunkerOptions = {}): SentenceChunker {
  const softMax = opts.softMax ?? SENTENCE_BOUNDS.softMax;
  const hardMax = opts.hardMax ?? SENTENCE_BOUNDS.hardMax;
  const minPiece = opts.minPiece ?? SENTENCE_BOUNDS.minPiece;
  let buffer = '';

  const take = (end: number, out: string[]): void => {
    const piece = buffer.slice(0, end).trim();
    buffer = buffer.slice(end);
    if (speakable(piece)) out.push(piece);
  };

  const push = (delta: string): string[] => {
    buffer += delta;
    const out: string[] = [];
    for (;;) {
      const end = findBoundary(buffer);
      // A sentence too long is cut whether or not its end has arrived:
      // the cut is computed on the sentence alone, so it is the same.
      const cut = findCut(end === -1 ? buffer : buffer.slice(0, end), softMax, hardMax, minPiece);
      if (cut !== -1) take(cut, out);
      else if (end !== -1) take(end, out);
      else break;
    }
    return out;
  };

  return {
    push,
    flush() {
      // The text is complete: what follows it is a line break, which settles
      // every boundary still waiting on the next character.
      const out = push('\n');
      take(buffer.length, out);
      return out;
    },
  };
}

/** A whole text, cut the same way: what the chunker yields for it as one delta. */
export function splitSentences(text: string, opts?: SentenceChunkerOptions): string[] {
  const chunker = createSentenceChunker(opts);
  return [...chunker.push(text), ...chunker.flush()];
}
