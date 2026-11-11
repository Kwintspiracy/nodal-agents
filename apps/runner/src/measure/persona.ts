// measure/persona.ts — the sheet (personality) a spoken-reasoning measure plays
// with, and how a record says which one it was (#995).
//
// A measure that varies the sheet must be able to prove, for every turn, WHICH
// sheet that turn played. This module holds the three small pieces of that:
// reading a variant from a file (and refusing a file that cannot be one), the
// fingerprint a record carries, and the line a report prints.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** A sheet variant: the text to play, and the file it came from. */
export interface PersonaVariant {
  /** The text the measured agent's `personality` takes, on the turn's copy only. */
  text: string;
  /** The file's base name (never its directory: a record is shared). */
  file: string;
}

/**
 * Which sheet a turn played. `file`: the variant of `--persona-file`. `stored`:
 * the sheet the database holds, unchanged. `sha256` is the first 12 hex digits
 * of the SHA-256 of the sheet's UTF-8 bytes; `length` is its length in
 * characters.
 */
export interface PersonaInfo {
  source: 'file' | 'stored';
  /** Present when `source` is `file`. */
  file?: string;
  sha256: string;
  length: number;
}

export function personaFingerprint(text: string): { sha256: string; length: number } {
  return {
    sha256: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12),
    length: text.length,
  };
}

/** The `PersonaInfo` of a turn, from the sheet the turn's copy holds. */
export function personaInfo(text: string, variant: PersonaVariant | undefined): PersonaInfo {
  return variant
    ? { source: 'file', file: variant.file, ...personaFingerprint(text) }
    : { source: 'stored', ...personaFingerprint(text) };
}

/**
 * Reads a sheet variant. Throws, before any turn is played, when the file is
 * missing or unreadable, is not valid UTF-8, or holds nothing but blanks
 * (invariant #4: a measure must never quietly play the stored sheet instead).
 * A leading byte-order mark (what Windows editors write) is not part of the
 * sheet and is dropped by the decoder; the rest is kept as written, trailing newline included.
 */
export function loadPersonaFile(path: string): PersonaVariant {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new Error(`persona file ${path}: cannot be read (${(err as Error).message})`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`persona file ${path}: is not valid UTF-8`);
  }
  if (text.trim() === '') throw new Error(`persona file ${path}: is empty`);
  return { text, file: basename(path) };
}

/** One line for a report header and the console. */
export function describePersona(p: PersonaInfo): string {
  return p.source === 'file'
    ? `persona: file ${p.file ?? '?'}, sha256 ${p.sha256}, ${p.length} chars`
    : `persona: the stored sheet, unchanged, sha256 ${p.sha256}, ${p.length} chars`;
}

/**
 * The persona line of a stored run, for `--rescore`: the header's when the run
 * wrote one, else what its records say, else that nothing was recorded (a run
 * measured before `--persona-file` is not guessed at, invariant #4).
 */
export function describeStoredPersona(
  header: PersonaInfo | undefined,
  records: ReadonlyArray<{ persona?: PersonaInfo }>,
): string {
  if (header) return describePersona(header);
  const seen = new Map<string, PersonaInfo>();
  for (const r of records) {
    if (r.persona)
      seen.set(`${r.persona.source}|${r.persona.file ?? ''}|${r.persona.sha256}`, r.persona);
  }
  if (seen.size === 0) return 'persona: not recorded (measured before --persona-file existed)';
  return [...seen.values()].map(describePersona).join('\n');
}
