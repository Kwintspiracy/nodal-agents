// outbound-exits.ts — no text leaves Nodal beside the outbound seam.
//
// Text written by an agent, a tool or a third party leaves Nodal through the
// functions of `packages/shared/src/outbound.ts`, which apply the single
// masker. Where the sink is Nodal's own (the runner's event format, the MCP
// answer builder), the compiler holds the rule: the sink takes `Outbound<T>`
// only. Where it is not (a platform SDK's send, a web read model's database
// projection, a module re-exported by a package index), this scanner holds
// it. Each package's `architecture.test.ts` names its exits; this module reads
// them.
//
// Two kinds of exit:
//
//   - a FORBIDDEN FORM (`pattern`): a shape that is an exit around the seam
//     by itself (a raw projection of a column of agent text, a value import of
//     a channel module, a cast to the brand). Every match is a violation;
//   - a CALL (`call`): a sink reached directly (an SDK's send). The call's
//     arguments, read to their closing parenthesis, must go through one of
//     the outbound functions. A call that carries its text raw is a
//     violation.
//
// Read on the source with comments removed, across lines (a call is often
// spread over several). Tests are not read (`ScanOptions.skipDirs`): their
// fixtures name sinks on purpose.

import { readFileSync } from 'node:fs';
import { listSourceFiles, stripComments, type ScanOptions, type Violation } from './architecture';

/** The functions of the seam: an argument that calls one of them went through it. */
export const OUTBOUND_FUNCTIONS: readonly string[] = [
  'outboundText',
  'outboundValue',
  'outboundFields',
  'outboundAsIs',
  'createOutboundStream',
  // The web's database projections (`@nodal-agents/db`): a column of agent
  // text read for a browser goes through the seam at the projection.
  'outboundColumn',
  'outboundColumns',
  'outboundSql',
] as const;

const SEAM_CALL_SOURCE = String.raw`\b(?:${OUTBOUND_FUNCTIONS.join('|')})\s*[(<]`;
const SEAM_CALL = new RegExp(SEAM_CALL_SOURCE);
const STARTS_WITH_SEAM_CALL = new RegExp(String.raw`^\s*(?:await\s+)?${SEAM_CALL_SOURCE}`);

/** Do the arguments carry every field of `fields` through the seam? */
function fieldsGoThroughSeam(rawArgs: string, fields: readonly string[]): boolean {
  // What is already inside a call of the seam went through it: blanked, so
  // that a `text:` of its own argument is not read as a raw field.
  let args = rawArgs;
  for (const m of rawArgs.matchAll(new RegExp(SEAM_CALL_SOURCE, 'g'))) {
    const open = rawArgs.indexOf('(', m.index);
    const close = open === -1 ? -1 : closingParen(rawArgs, open);
    if (close === -1) continue;
    args = args.slice(0, open + 1) + ' '.repeat(close - open - 1) + args.slice(close);
  }
  let carried = false;
  for (const f of fields) {
    if (new RegExp(String.raw`[{,]\s*${f}\s*[,}]`).test(args)) return false;
    for (const m of args.matchAll(new RegExp(String.raw`\b${f}\s*:`, 'g'))) {
      carried = true;
      if (!STARTS_WITH_SEAM_CALL.test(args.slice(m.index + m[0].length))) return false;
    }
  }
  // A call that names none of its text fields (its payload built elsewhere,
  // `reply(payload)`) cannot be read here: it carries its text through the
  // seam as a whole, or it is refused.
  return carried || SEAM_CALL.test(rawArgs);
}

export type OutboundExit =
  | {
      /** Named in the violation. */
      rule: string;
      /** A form that is an exit around the seam wherever it appears. */
      pattern: RegExp;
    }
  | {
      rule: string;
      /**
       * The start of a sink call, ending at (or just before) its opening
       * parenthesis: `/\bchat\.postMessage\s*\(/`.
       */
      call: RegExp;
      /**
       * The properties of the call's object argument that carry text (`text`,
       * `content`). When given, EACH of them must be a call of the seam (a
       * raw value beside a masked one is still a raw exit), a shorthand
       * (`{ text }`) is refused, and a call that names none of them (its
       * payload built elsewhere) must take a seam call as its argument. When
       * absent, the arguments as a whole must go through the seam.
       */
      fields?: readonly string[];
    };

/**
 * The index of the parenthesis that closes the one opened at `open`, strings
 * and template literals skipped; -1 when the source ends first.
 */
function closingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      for (i++; i < src.length && src[i] !== quote; i++) {
        if (src[i] === '\\') i++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every exit of `exits` in the source under `opts.srcDir` that skips the seam. */
export function scanForOutboundBypass(
  opts: ScanOptions,
  exits: readonly OutboundExit[],
): Violation[] {
  const skip = opts.skipFiles ?? [];
  const files = listSourceFiles(opts.srcDir, {
    skipDirs: opts.skipDirs ?? ['tests', '__tests__'],
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
  }).filter((f) => {
    const norm = f.split('\\').join('/');
    return !skip.some((s) => norm.endsWith(s.split('\\').join('/')));
  });
  const out: Violation[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf-8'));
    const lineOf = (at: number): number => src.slice(0, at).split('\n').length;
    const textAt = (at: number): string =>
      (src.split('\n')[lineOf(at) - 1] ?? '').trim().slice(0, 120);
    for (const exit of exits) {
      if ('pattern' in exit) {
        const flags = exit.pattern.flags.includes('g')
          ? exit.pattern.flags
          : `${exit.pattern.flags}g`;
        for (const m of src.matchAll(new RegExp(exit.pattern.source, flags))) {
          out.push({ file, line: lineOf(m.index), text: textAt(m.index), rule: exit.rule });
        }
        continue;
      }
      const flags = exit.call.flags.includes('g') ? exit.call.flags : `${exit.call.flags}g`;
      for (const m of src.matchAll(new RegExp(exit.call.source, flags))) {
        const open = src.indexOf('(', m.index + m[0].length - 1);
        const close = open === -1 ? -1 : closingParen(src, open);
        const args = close === -1 ? src.slice(m.index) : src.slice(open + 1, close);
        const through = exit.fields ? fieldsGoThroughSeam(args, exit.fields) : SEAM_CALL.test(args);
        if (!through) {
          out.push({ file, line: lineOf(m.index), text: textAt(m.index), rule: exit.rule });
        }
      }
    }
  }
  return out;
}

/**
 * A cast to the brand: only the seam's own module may say a value went
 * through it. Anywhere else, `as Outbound<…>` would be a mask claimed and not
 * applied.
 */
export const OUTBOUND_BRAND_CAST: OutboundExit = {
  rule: 'outbound-brand-cast',
  pattern: /\bas\s+Outbound\s*</,
};

/**
 * The exits of a read model that hands database text to a reader outside: every
 * way a query can PROJECT a column of `columns` (table variable → its columns
 * of text) without the seam's projection functions. A filter (`eq(t.c, x)`)
 * is not a projection and is not read.
 *
 *   - `key: table.column`            a column projected raw;
 *   - `key: table`                   a whole row projected raw;
 *   - `key: sql`…${table.column}…``  an expression over such a column;
 *   - `.select().from(table)`        every column, implicitly;
 *   - `.query.table.`                the relational API (every column);
 *   - `.returning()`                 every column of what was written.
 */
export function outboundProjectionExits(
  columns: Readonly<Record<string, readonly string[]>>,
): OutboundExit[] {
  const tables = Object.keys(columns);
  const one = tables
    .filter((t) => (columns[t] ?? []).length > 0)
    .map((t) => String.raw`${t}\.(?:${(columns[t] ?? []).join('|')})`)
    .join('|');
  const anyTable = tables.join('|');
  return [
    { rule: 'raw-projection', pattern: new RegExp(String.raw`\b\w+\s*:\s*(?:${one})\b`) },
    {
      rule: 'raw-row-projection',
      pattern: new RegExp(String.raw`\b\w+\s*:\s*(?:${anyTable})\s*(?=[,}\n])`),
    },
    {
      rule: 'raw-sql-projection',
      pattern: new RegExp(
        String.raw`\b\w+\s*:\s*sql\s*(?:<[^>\x60]*>)?\s*\x60[^\x60]*\$\{\s*(?:${one})\b`,
      ),
    },
    {
      rule: 'raw-implicit-projection',
      pattern: new RegExp(String.raw`\.select\(\s*\)\s*\.from\(\s*(?:${anyTable})\s*\)`),
    },
    { rule: 'raw-relational-query', pattern: new RegExp(String.raw`\.query\.(?:${anyTable})\.`) },
    { rule: 'raw-returning', pattern: /\.returning\(\s*\)/ },
  ];
}
