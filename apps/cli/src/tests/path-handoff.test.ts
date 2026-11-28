// path-handoff.test.ts — a path handed to another program reaches it exactly,
// or is refused by name (#1231).
//
// The readers that DECODE bytes (PostgreSQL, cmd.exe) are proven against the
// real programs by `non-ascii-home.pg.test.ts` and
// `autostart-script-runs.test.ts`. This file holds the rule itself, and the
// other side of the table: a Node child (the runner, the web server) receives
// the home in its environment, its working folder and its arguments with no
// encoding step in between, on every system — proven on a real child, spawned
// the way `spawnRunner` / `spawnWeb` spawn theirs.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  BATCH_PRELUDE,
  PathNotReadableError,
  WINDOWS_RUN_LINE_READER,
  batchScriptBytes,
  batchScriptReadable,
  checkPathsFor,
  encodeForReader,
  type PathReader,
} from '../lib/path-handoff.ts';
import { childProcessEnv } from '../lib/env.ts';

const UTF8: PathReader = { program: 'a UTF-8 program', codePage: 65001 };
const WESTERN: PathReader = {
  program: 'a code page program',
  codePage: 1252,
  remedy: 'Move it.',
};
/** A code page Nodal has no table for: ASCII is the part every page shares. */
const UNKNOWN_PAGE: PathReader = { program: 'an EBCDIC-era program', codePage: 37 };

/** Letters from four scripts, an emoji outside the BMP, and the shells' special characters. */
const NAME = "home A é Ω 李 😀 'q' 100% & !^ (x)";

const root = mkdtempSync(join(tmpdir(), 'nodal-path-handoff-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a path for a reader that decodes bytes @cap:installer-et-demarrer/moteur', () => {
  it('a UTF-8 reader gets bytes that decode back to the exact path', () => {
    const path = join(root, NAME, 'logs');
    const bytes = encodeForReader(UTF8, `log_directory = '${path}'\n`, [path]);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(
      `log_directory = '${path}'\n`,
    );
  });

  it('a code page reader takes what the page holds and refuses the rest by name, with its remedy', () => {
    expect(() => checkPathsFor(WESTERN, [join(root, 'Zoë')])).not.toThrow();
    const path = join(root, 'Zoë 😀');
    expect(() => checkPathsFor(WESTERN, [join(root, 'plain'), path])).toThrow(
      new PathNotReadableError(
        'a code page program',
        path,
        'it holds "😀", which code page 1252 cannot carry. Move it.',
      ),
    );
    // The whole character, never half of a surrogate pair.
    expect(() => checkPathsFor(WESTERN, [join(root, 'x 😀')])).toThrow('holds "😀"');
  });

  it('a code page with no table: ASCII only, said as such', () => {
    expect(() => checkPathsFor(UNKNOWN_PAGE, [join(root, "a 'q' 100% & !^ (x)")])).not.toThrow();
    expect(() => checkPathsFor(UNKNOWN_PAGE, [join(root, 'Zoë')])).toThrow(
      /holds "ë", and Nodal cannot encode for code page 37, so only ASCII is exact/,
    );
  });

  it('a character no encoding carries is refused even by a UTF-8 reader', () => {
    const path = join(root, `lone \uD83D surrogate`);
    expect(() => encodeForReader(UTF8, path, [path])).toThrow(/unpaired UTF-16 surrogate/);
    // A complete pair is a character like any other.
    expect(() => encodeForReader(UTF8, '😀', ['😀'])).not.toThrow();
  });

  it('the Run line refuses a %NAME% Windows would expand, and takes a lone %', () => {
    expect(() =>
      checkPathsFor(WINDOWS_RUN_LINE_READER, ['C:\\Users\\a %USERNAME% b\\autostart.cmd']),
    ).toThrow(/holds "%USERNAME%", which Windows and cmd\.exe replace/);
    expect(() =>
      checkPathsFor(WINDOWS_RUN_LINE_READER, ['C:\\Users\\100% sure\\autostart.cmd']),
    ).not.toThrow();
  });
});

describe('a batch script cmd.exe reads the same in every console code page @cap:installer-et-demarrer/moteur', () => {
  it('starts in ASCII with the switch to UTF-8, then carries the lines exactly', () => {
    const home = join(root, NAME);
    const bytes = batchScriptBytes([`set "NODALAI_HOME=${home}"`], [home]);
    const text = bytes.toString('utf8');
    expect(text.startsWith(`${BATCH_PRELUDE.join('\r\n')}\r\n`)).toBe(true);
    expect(text).toContain(`set "NODALAI_HOME=${home}"\r\n`);
    expect(batchScriptReadable(bytes)).toBe(true);
  });

  it('judges a script already on disk the way cmd.exe would read it', () => {
    const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');
    // What versions before #1231 wrote: readable only while the home was ASCII.
    expect(batchScriptReadable(utf8('@echo off\r\nset "H=C:\\Users\\q"\r\n'))).toBe(true);
    expect(batchScriptReadable(utf8('@echo off\r\nset "H=C:\\Users\\Zoë"\r\n'))).toBe(false);
    // A non-ASCII byte BEFORE the switch is read in the console's code page.
    expect(batchScriptReadable(utf8('@echo é\r\nchcp 65001 >nul\r\n'))).toBe(false);
    // After the switch, the bytes must be UTF-8.
    expect(
      batchScriptReadable(Buffer.from('chcp 65001 >nul\r\nset "H=Zo\xeb"\r\n', 'latin1')),
    ).toBe(false);
  });
});

describe('a Node child receives the home with no encoding step @cap:installer-et-demarrer/moteur', () => {
  /** A child that writes down its environment, working folder and arguments. */
  function echoChild(): { script: string; out: string; home: string } {
    const home = join(root, 'child', NAME);
    mkdirSync(home, { recursive: true });
    const script = join(home, 'echo.cjs');
    const out = join(root, `received-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({` +
        `home: process.env.NODALAI_HOME, cwd: process.cwd(), argv: process.argv.slice(1) }));\n`,
    );
    return { script, out, home };
  }

  it('spawned directly (bundled mode: node + script path), every value arrives exactly', async () => {
    const { script, out, home } = echoChild();
    const r = await execa(process.execPath, [script, home], {
      cwd: home,
      env: childProcessEnv(process.env, { NODALAI_HOME: home }),
      extendEnv: false,
      windowsHide: true,
      reject: false,
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      home,
      cwd: home,
      argv: [script, home],
    });
  });

  it('spawned through the shell (dev mode on Windows), the environment and folder arrive exactly', async () => {
    const { script, out, home } = echoChild();
    // The dev wiring: `shell: true` on Windows puts cmd.exe in between. The
    // home travels in the environment and the working folder, never on that
    // command line, so the script is named relatively.
    const r = await execa('node', ['echo.cjs'], {
      cwd: home,
      env: childProcessEnv(process.env, { NODALAI_HOME: home }),
      extendEnv: false,
      windowsHide: true,
      reject: false,
      shell: process.platform === 'win32',
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      home,
      cwd: home,
      argv: [script],
    });
  });
});
