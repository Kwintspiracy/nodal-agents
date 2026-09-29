// runner-notes-one-writer.test.ts — `agent_jobs.runner_notes` receives a value
// built by `runnerNotesValue` and nothing else (Codex review of #576, pass 4).
//
// A runner line embeds text the runner did not write (a checker's stderr tail,
// an error code's detail). Written raw into `text[]`, a NUL byte or a lone
// surrogate makes Postgres refuse the whole terminal UPDATE — the run then
// never reaches its failed state. `runnerNotesValue` applies the normalization
// `result` gets. This scan makes a new producer that writes `runnerNotes`
// directly fail here, by name, instead of on a user's machine.
//
// Mutation: `runnerNotes: [line]` in finalize.ts → this test goes red and
// names finalize.ts.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerNotesValue } from '../../job/transcript-text.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : sources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('runner_notes has one writer @cap:reprendre-conversation/moteur', () => {
  it('normalizes each line exactly as result is normalized', () => {
    expect(runnerNotesValue(['a\u0000b', 'x\uD83Dy', 'ok'])).toEqual(['ab', 'x�y', 'ok']);
  });

  it('every value written to runnerNotes comes from runnerNotesValue', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // `runnerNotes: <value>` in an object literal, or `runnerNotes = <value>`.
        const m = /\brunnerNotes\s*[:=]\s*(.+)$/.exec(line);
        if (!m) return;
        const value = m[1]!.trim();
        const allowed =
          value.startsWith('runnerNotesValue(') ||
          value.startsWith('agentJobs.runnerNotes') || // a select, not a write
          value.startsWith("text('runner_notes')") || // the schema column
          /^string\[\]\s*\|\s*null\s*=\s*null;$/.test(value) || // a declaration
          value.startsWith('null;') ||
          value.startsWith('readonly string[]') || // a parameter type
          value.startsWith('Array.isArray(row.runnerNotes)'); // the replay reads it
        if (!allowed) offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
