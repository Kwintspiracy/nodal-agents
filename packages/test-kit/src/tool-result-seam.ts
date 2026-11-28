// tool-result-seam.ts — no tool result reaches the model or a store beside the seam.
//
// A tool's result is masked once, in `executeTool` (packages/tools), where it
// becomes both what the runner turns into the model's message and the
// `tool_calls` row. Two forms would go around that seam, and this scanner
// refuses both, in the source of every package that runs or records tools:
//
//   - a TOOL RUN beside `executeTool`: a call `x.execute(input, ctx)` (two
//     arguments, a tool's signature; a database's `execute(sql)` takes one).
//     Its result would reach whoever called it unmasked;
//   - a TOOL ROW WRITTEN beside the seam: an `.insert(toolCalls)` or an
//     `.update(toolCalls)` whose `values`/`set` writes a `toolOutput` that is
//     neither `null` nor a call of the seam's function
//     (`toolOutput: maskToolResultText(…)`). A recorder that builds its row
//     elsewhere does it in the module the caller names as its seam
//     (`skipFiles`), and spreads that row.
//
// Each caller names its seam files and its exemptions; each exemption is a
// reason (an adapter's search run INSIDE the `web_search` tool, whose result
// goes through the seam as that tool's).
//
// Read on the source with comments removed, across lines. Tests are skipped
// (`ScanOptions.skipDirs`): their fixtures run tools directly on purpose.

import { readFileSync } from 'node:fs';
import { listSourceFiles, stripComments, type ScanOptions, type Violation } from './architecture';

/** The index of the parenthesis closing the one at `open`, strings skipped; -1 if none. */
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
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return ch === ')' ? i : -1;
    }
  }
  return -1;
}

/** How many arguments, at the top level, between `open` and `close`. */
function argumentCount(src: string, open: number, close: number): number {
  const inner = src.slice(open + 1, close);
  if (inner.trim() === '') return 0;
  let depth = 0;
  let count = 1;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      for (i++; i < inner.length && inner[i] !== quote; i++) {
        if (inner[i] === '\\') i++;
      }
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0 && inner.slice(i + 1).trim() !== '') count++;
  }
  return count;
}

/** `text` with what is inside its parentheses blanked: its own level only. */
function ownLevel(text: string): string {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === ')') depth--;
    out += depth > 0 ? ' ' : ch;
    if (ch === '(') depth++;
  }
  return out;
}

export interface ToolResultSeamOptions extends ScanOptions {
  /**
   * Runs of a tool's `execute` that are not a bypass, each with its reason,
   * matched by a substring of the line (`'searchTool.execute('`).
   */
  exemptRuns?: ReadonlyArray<{ line: string; reason: string }>;
}

/** Every tool run beside `executeTool` and every tool row written beside the seam. */
export function scanForToolResultBypass(opts: ToolResultSeamOptions): Violation[] {
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
    const lines = src.split('\n');
    const lineOf = (at: number): number => src.slice(0, at).split('\n').length;
    const textAt = (at: number): string => (lines[lineOf(at) - 1] ?? '').trim().slice(0, 120);

    for (const m of src.matchAll(/\.execute\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = closingParen(src, open);
      if (close === -1 || argumentCount(src, open, close) !== 2) continue;
      const text = textAt(m.index);
      if ((opts.exemptRuns ?? []).some((e) => text.includes(e.line))) continue;
      out.push({ file, line: lineOf(m.index), text, rule: 'tool-run-beside-execute-tool' });
    }

    for (const m of src.matchAll(/\.(?:insert|update)\(\s*toolCalls\s*\)/g)) {
      const after = src.slice(m.index + m[0].length);
      const call = /^\s*\.(?:values|set)\s*\(/.exec(after);
      if (!call) continue;
      const open = m.index + m[0].length + call[0].length - 1;
      const close = closingParen(src, open);
      const args = close === -1 ? src.slice(open) : src.slice(open + 1, close);
      // Only the row's own properties: what is inside a call of it (the
      // arguments of a row builder it spreads) is that builder's input.
      const written = /\btoolOutput\s*:\s*([\w.]+)/.exec(ownLevel(args));
      if (written && written[1] !== 'null' && written[1] !== 'maskToolResultText') {
        out.push({
          file,
          line: lineOf(m.index),
          text: textAt(m.index),
          rule: 'tool-row-beside-the-seam',
        });
      }
    }
  }
  return out;
}
