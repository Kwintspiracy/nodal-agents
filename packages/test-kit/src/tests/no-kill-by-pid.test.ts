// no-kill-by-pid.test.ts — a test never kills a process by its bare number
// (#841).
//
// On CI Windows, vitest workers died several times a day with nothing but
// `Worker exited unexpectedly`, in apps/runner, apps/cli and packages/tools.
// The cleanup of two bench tests killed, by number, every launcher pid they had
// started: most of those launchers had exited long before, and the process
// audit of the runner (run 39786905701) showed their pids already handed to
// processes of other packages — `pnpm test` runs three packages at once. On
// Windows a pid is free again as soon as no handle holds its process, and
// `process.kill(pid)` is a TerminateProcess on whoever has it now: exit code 1,
// no output. A vitest worker killed that way loses its file without a word.
//
// The rule: a test kills a process through what HOLDS it — the `ChildProcess`
// it spawned (`child.kill()` goes through the process handle and does nothing
// once the child has exited), or a `watchProcess` watch opened when the pid was
// learned (`watch.kill()`; while the watch is open the pid can name nobody
// else). This guard reads every test source as TypeScript and refuses, in it:
//   - `process.kill(x, signal)`, except the probe `process.kill(x, 0)` and a
//     process signalling itself (`process.kill(process.pid, …)`);
//   - any call given the literal `'taskkill'` (a tree kill by number).
// `killPidTree` is not on the list: its own suites drive it against a mocked
// process table, and its callers here pass a pid they hold (a child guarded by
// `exitCode === null`, or a watch).
// A call that is safe for a reason the guard cannot see (the group of a child
// held alive, a child guarded by `exitCode === null`) says why on the line, or
// on one of the three lines above: `// kill-by-pid: <the reason>`.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', '.claude', '.git', 'coverage']);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const MARKER = /kill-by-pid:\s*\S/;

/** Test sources: anything under a `tests` / `__tests__` directory, or named `*.test.*`. */
function testSources(dir: string, inTests = false, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).map((d) =>
      d.isDirectory() ? `${d.name}${sep}` : d.name,
    );
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.endsWith(sep)) {
      const bare = name.slice(0, -1);
      if (SKIP.has(bare)) continue;
      testSources(join(dir, bare), inTests || bare === 'tests' || bare === '__tests__', out);
    } else if (SOURCE.test(name) && (inTests || /\.test\.[^.]+$/.test(name))) {
      out.push(join(dir, name));
    }
  }
  return out;
}

export interface KillByPid {
  line: number;
  text: string;
}

/** The kills by number in `source` that carry no `kill-by-pid:` reason. */
export function killsByPid(source: string, fileName = 'x.test.ts'): KillByPid[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = source.split(/\r?\n/);
  const found: KillByPid[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && refused(node)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
      const said = lines.slice(Math.max(0, line - 3), line + 1).some((l) => MARKER.test(l));
      if (!said) found.push({ line: line + 1, text: node.getText(file).split('\n')[0] ?? '' });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function refused(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && callee.getText() === 'process.kill') {
    const [target, signal] = call.arguments;
    if (signal !== undefined && ts.isNumericLiteral(signal) && signal.text === '0') return false;
    if (target !== undefined && target.getText() === 'process.pid') return false;
    return true;
  }
  const first = call.arguments[0];
  return (
    first !== undefined && ts.isStringLiteralLike(first) && first.text.toLowerCase() === 'taskkill'
  );
}

describe('killsByPid', () => {
  it('refuses a kill by number and a taskkill', () => {
    const found = killsByPid(
      [
        'process.kill(pid);',
        "process.kill(launcher.pid!, 'SIGKILL');",
        "spawn('taskkill', ['/PID', String(pid), '/T', '/F']);",
        "execa('TASKKILL', ['/F', '/PID', String(pid)]);",
      ].join('\n'),
    );
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4]);
  });

  it('allows the probe, a process signalling itself, and the kills that go through a holder', () => {
    expect(
      killsByPid(
        [
          'process.kill(pid, 0);',
          "process.kill(process.pid, 'SIGKILL');",
          'child.kill();',
          "watch.kill('SIGKILL');",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('allows a kill that says why, on its line or just above, and only with a reason', () => {
    expect(
      killsByPid(
        [
          '// kill-by-pid: the group of a child we hold, alive',
          "process.kill(-runner.pid, 'SIGKILL');",
          'process.kill(pid); // kill-by-pid: the postmaster we started',
        ].join('\n'),
      ),
    ).toEqual([]);
    expect(killsByPid(['// kill-by-pid:', 'process.kill(pid);'].join('\n'))).toHaveLength(1);
  });
});

describe('no test of the repository kills a process by its bare number (#841)', () => {
  it('every kill in a test source goes through a holder, or says why it may not', () => {
    const offenders: string[] = [];
    for (const top of ['apps', 'packages', 'scripts']) {
      for (const path of testSources(join(REPO_ROOT, top))) {
        for (const k of killsByPid(readFileSync(path, 'utf8'), path)) {
          offenders.push(`${relative(REPO_ROOT, path).split(sep).join('/')}:${k.line} ${k.text}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan reaches the suites this rule was written for', () => {
    const scanned = ['apps', 'packages', 'scripts']
      .flatMap((top) => testSources(join(REPO_ROOT, top)))
      .map((p) => relative(REPO_ROOT, p).split(sep).join('/'));
    expect(scanned).toEqual(
      expect.arrayContaining([
        'packages/bench/src/campaign/tests/lifecycle.test.ts',
        'packages/bench/src/campaign/tests/harness.ts',
        'apps/cli/src/tests/detach.test.ts',
        'scripts/tests/boot-stack.test.mjs',
      ]),
    );
  });
});
