// autostart-script-runs.test.ts — the start-at-login script, EXECUTED by the
// program that will read it at login (#1231).
//
// `autostart.test.ts` pins the texts. This runs them: the script Nodal writes
// for a home named with any character, launched by the exact line Nodal
// registers under Run (`conhost.exe --headless … cmd.exe /c "<script>"`), must
// reach its target with that home and those arguments, unchanged. The target
// is harmless: a Node script in the same home that writes down what it was
// given. Nothing is registered on this machine: the registry is a fake, the
// files and the processes are real.
//
// Until 2026-11-28 the script was UTF-8 and cmd.exe read it in the console's
// code page (437 or 850): the home became "home ├⌐ ╬⌐ ≡ƒÿÇ" and the target was
// never found, while the switch said ON. The last case is that script, and the
// switch now says what is true about it.
//
// Windows only, by nature: there is no cmd.exe elsewhere. It runs on the
// Windows CI and on any Windows machine.

import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WINDOWS_ENTRY_CANNOT_START_REASON,
  WINDOWS_RUN_KEY,
  WINDOWS_SCRIPT_UNREADABLE_REASON,
  installAutostart,
  readAutostartStatus,
  type AutostartEffects,
  type CommandAnswer,
} from '../lib/autostart.ts';

const onWindows = process.platform === 'win32';

/** Every character the readers treat specially, and letters from four scripts. */
const HOME_NAME = "home A é Ω 李 😀 'q' 100% & !^";

const root = mkdtempSync(join(tmpdir(), 'nodal-autostart-run-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fresh home holding a harmless target, which writes down what it received. */
function homeWithTarget(name: string): { home: string; target: string; out: string } {
  const base = mkdtempSync(join(root, 'case-'));
  const home = join(base, name);
  mkdirSync(home, { recursive: true });
  const target = join(home, 'target.cjs');
  const out = join(base, 'received.json');
  writeFileSync(
    target,
    `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(` +
      `{ home: process.env.NODALAI_HOME, argv: process.argv.slice(2) }));\n`,
  );
  return { home, target, out };
}

/** A registry in memory (nothing touches the machine's), and the real file system. */
function effects(nodalDir: string): {
  fx: AutostartEffects;
  runLine: () => string;
  setRunLine: (line: string) => void;
} {
  const values = new Map<string, string>();
  const fx: AutostartEffects = {
    platform: 'win32',
    home: root,
    user: 'tester',
    nodalDir,
    run: async (cmd, args): Promise<CommandAnswer | null> => {
      if (cmd === 'schtasks') return { exitCode: 1, stdout: 'ERROR: not found' };
      if (cmd !== 'reg') return null;
      const [verb, key, , name] = args;
      const id = `${String(key)}|${String(name)}`;
      if (verb === 'add') {
        values.set(id, String(args[args.indexOf('/d') + 1]));
        return { exitCode: 0, stdout: 'ok' };
      }
      if (verb === 'delete') {
        values.delete(id);
        return { exitCode: 0, stdout: 'ok' };
      }
      const v = values.get(id);
      return v === undefined
        ? { exitCode: 1, stdout: 'ERROR: not found' }
        : { exitCode: 0, stdout: `${String(name)}    REG_EXPAND_SZ    ${v}` };
    },
    writeFile: (path, data) => writeFile(path, data),
    readFile: async (path) => (existsSync(path) ? readFile(path) : null),
    removeFile: (path) => rm(path, { force: true }),
    exists: async (path) => (await stat(path).catch(() => null)) !== null,
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
  };
  const runLine = (): string => {
    const line = [...values.entries()].find(([k]) => k.startsWith(`${WINDOWS_RUN_KEY}|`))?.[1];
    if (line === undefined) throw new Error('nothing was registered under Run');
    return line;
  };
  const setRunLine = (line: string): void => {
    const key = [...values.keys()].find((k) => k.startsWith(`${WINDOWS_RUN_KEY}|`));
    if (key === undefined) throw new Error('nothing was registered under Run');
    values.set(key, line);
  };
  return { fx, runLine, setRunLine };
}

/**
 * Launch a Run line the way Windows does: `%SystemRoot%` expanded (it is a
 * REG_EXPAND_SZ), the program first, the rest of the line handed over as it is.
 * conhost needs real standard handles to host its console: pipes.
 */
function launch(line: string): void {
  const expanded = line.replace(/%SystemRoot%/g, process.env['SystemRoot'] ?? 'C:\\Windows');
  const space = expanded.indexOf(' ');
  const child = spawn(expanded.slice(0, space), [expanded.slice(space + 1)], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    stdio: 'pipe',
  });
  child.stdout?.resume();
  child.stderr?.resume();
}

async function received(
  out: string,
  waitMs: number,
): Promise<{ home: string; argv: string[] } | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (existsSync(out)) {
      try {
        return JSON.parse(readFileSync(out, 'utf8')) as { home: string; argv: string[] };
      } catch {
        /* still being written */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

describe.skipIf(!onWindows)(
  'the start-at-login script, run by cmd.exe from a home named with any character @cap:installer-et-demarrer/moteur',
  () => {
    it('reaches its target with the exact home and arguments, and the switch says ON', async () => {
      const { home, target, out } = homeWithTarget(HOME_NAME);
      const { fx, runLine } = effects(home);
      expect(await installAutostart([process.execPath, target], fx)).toEqual({
        state: 'at_login',
      });
      launch(runLine());
      expect(await received(out, 20_000)).toEqual({ home, argv: ['up'] });
    }, 30_000);

    it('a script an earlier version wrote for that home: the switch says it would not start, and it does not', async () => {
      const { home, target, out } = homeWithTarget(HOME_NAME);
      const { fx, runLine } = effects(home);
      await installAutostart([process.execPath, target], fx);
      // The script exactly as versions before #1231 wrote it: UTF-8, no switch.
      writeFileSync(
        join(home, 'autostart.cmd'),
        `@echo off\r\nset "NODALAI_HOME=${home}"\r\n"${process.execPath}" "${target}" up\r\n`,
        'utf8',
      );
      expect(await readAutostartStatus(fx)).toEqual({
        state: 'off',
        reason: WINDOWS_SCRIPT_UNREADABLE_REASON,
      });
      launch(runLine());
      expect(await received(out, 8_000)).toBeNull();
    }, 30_000);

    /** The Run line exactly as versions before #1231 registered it. */
    const legacyLine = (script: string): string =>
      `%SystemRoot%\\System32\\conhost.exe --headless %SystemRoot%\\System32\\cmd.exe /c "${script}"`;

    it('a Run line an earlier version registered, for a folder cmd cuts it at: OFF, and it does not start', async () => {
      const { home, target, out } = homeWithTarget('home R&D ^1');
      const { fx, runLine, setRunLine } = effects(home);
      await installAutostart([process.execPath, target], fx);
      setRunLine(legacyLine(join(home, 'autostart.cmd')));
      expect(await readAutostartStatus(fx)).toEqual({
        state: 'off',
        reason: WINDOWS_ENTRY_CANNOT_START_REASON,
      });
      launch(runLine());
      expect(await received(out, 8_000)).toBeNull();
    }, 30_000);

    it('the same earlier line for a folder it carries: still ON, and it does start', async () => {
      const { home, target, out } = homeWithTarget('home plain');
      const { fx, runLine, setRunLine } = effects(home);
      await installAutostart([process.execPath, target], fx);
      setRunLine(legacyLine(join(home, 'autostart.cmd')));
      expect(await readAutostartStatus(fx)).toEqual({ state: 'at_login' });
      launch(runLine());
      expect(await received(out, 20_000)).toEqual({ home, argv: ['up'] });
    }, 30_000);
  },
);

describe.skipIf(onWindows)('the start-at-login script elsewhere', () => {
  it('is a Windows reader: cmd.exe does not exist on this system', () => {
    // Said, not silently absent: the Windows CI runs the cases above.
    expect(process.platform).not.toBe('win32');
  });
});
