// shell-pass5.test.ts — the three families the review of PR #682 found open at pass 5 (#667).
//
// - cmd's run-time forms (`%f`, `%%f`, `%~dpnxf`, `%1`, `%*`, `%~1`, `!X!`):
//   a program named by one of them is decided at run time and asks.
// - The desktop editors, viewers, office suites, browsers, mail clients,
//   file managers and terminals of Windows, macOS and Linux open a window
//   (closes #686), while their command-line uses stay unflagged.
// - The exec wrappers (setsid, stdbuf, ionice, strace, watch…): what they run
//   is a command of its own, for every kind and for the catastrophic floor.

import { describe, it, expect } from 'vitest';
import {
  isCatastrophicCommand,
  programDecidedAtRunTime,
  RUNS_ANOTHER_PROGRAMS,
  staticShellCategories,
} from '../catastrophic-command';
import { SHELL_PROGRAMS } from '../shell-programs';

const opensOrSends = (cmd: string, host?: 'windows' | 'posix') =>
  staticShellCategories(cmd, host).includes('open_or_send');

describe("cmd's run-time forms name a program decided at run time (#667, review of #682 pass 5) @cap:executer-une-commande/moteur", () => {
  it('for variables, batch parameters and delayed expansion', () => {
    for (const cmd of [
      'for %f in (*) do %f',
      'for %%f in (*) do %%f',
      'for %f in (*.pdf) do %~dpnxf',
      'for /r %%g in (*.txt) do %%~fg',
      '%1 report.pdf',
      '%~1 report.pdf',
      '%* ',
      '%~dp0tool.exe report.pdf',
      'setlocal enabledelayedexpansion & !P! report.pdf',
      'call %X% report.pdf',
      'call %%f',
    ]) {
      expect(programDecidedAtRunTime(cmd, 'windows'), cmd).toBe(true);
      expect(staticShellCategories(cmd, 'windows'), cmd).toContain('inline_code');
    }
  });

  it('a percent in an argument, or a literal percent, is not a program', () => {
    for (const cmd of [
      'echo 100%',
      'for %f in (*.txt) do type %f',
      'curl https://x.org/a%20b -o a.txt',
      'set /a X=7%%3',
    ]) {
      expect(programDecidedAtRunTime(cmd, 'windows'), cmd).toBe(false);
    }
  });
});

describe('desktop programs open a window, on every OS (#667, closes #686) @cap:executer-une-commande/moteur', () => {
  it('editors, viewers, office, browsers, mail, file managers and terminals', () => {
    for (const cmd of [
      'code C:\\shared\\outputs\\rapport.pdf',
      'code-insiders .',
      'cursor report.md',
      'codium report.md',
      'zed report.md',
      'subl report.md',
      'atom report.md',
      'notepad++ report.txt',
      'gedit report.txt',
      'gnome-text-editor report.txt',
      'kate report.txt',
      'mousepad report.txt',
      'gvim report.txt',
      'mvim report.txt',
      'emacs report.txt',
      'bbedit report.txt',
      'evince report.pdf',
      'okular report.pdf',
      'eog chart.png',
      'gimp chart.png',
      'vlc clip.mp4',
      'sumatrapdf report.pdf',
      'thunderbird -compose "to=bob@example.com"',
      'outlook /c ipm.note',
      'nautilus .',
      'dolphin .',
      'gnome-terminal',
      'wt',
      'calc',
      'brave-browser https://example.com',
      'xdg-email bob@example.com',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(true);
    }
  });

  it('their command-line uses open no window', () => {
    for (const cmd of [
      'code --version',
      'code --install-extension ms-python.python',
      'code --uninstall-extension ms-python.python',
      'code --list-extensions',
      'cursor --list-extensions --show-versions',
      'emacs --batch -l build.el',
      'emacs -nw notes.txt',
      'inkscape chart.svg --export-filename=chart.png',
      'inkscape --export-type=pdf chart.svg',
      'soffice --headless --convert-to pdf report.docx',
      'gimp -i -b "(script)" -b "(gimp-quit 0)"',
      'vlc -I dummy clip.mp4 --sout file/ts:out.ts vlc://quit',
      'vim notes.txt',
      'nano notes.txt',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(false);
    }
  });
});

describe('exec wrappers: what they run is read (#667, review of #682 pass 5) @cap:executer-une-commande/moteur', () => {
  it('the floor sees through them', () => {
    for (const cmd of [
      'setsid rm -rf /',
      'setsid -f rm -rf /',
      'stdbuf -o0 rm -rf /',
      'stdbuf -o L -e 0 rm -rf /',
      'ionice -c 3 rm -rf /',
      'chrt -f 10 rm -rf /',
      'taskset -c 0,1 rm -rf /',
      'taskset 0x3 rm -rf /',
      'unbuffer rm -rf /',
      'strace -f -o trace.log rm -rf /',
      'ltrace rm -rf /',
      'valgrind --leak-check=full rm -rf /',
      'watch -n 5 rm -rf /',
      'flock /tmp/x.lock rm -rf /',
      'flock -w 10 /tmp/x.lock -c "rm -rf /"',
      'chroot /mnt/root rm -rf /',
      'unshare -m rm -rf /',
      'nsenter -t 1 -m rm -rf /',
      'systemd-run --user --wait rm -rf /',
      'firejail --noprofile rm -rf /',
      'caffeinate -i rm -rf /',
      'gtimeout 5 rm -rf /',
      'builtin command rm -rf /',
      'pkexec rm -rf /',
      'su -c "rm -rf /"',
      'runuser -u me -- rm -rf /',
      'proxychains4 rm -rf /',
      'torsocks rm -rf /',
      'eatmydata rm -rf /',
      'fakeroot rm -rf /',
      'dbus-launch rm -rf /',
      'expect -c "spawn rm -rf /"',
    ]) {
      expect(isCatastrophicCommand(cmd, 'posix'), cmd).toBe(true);
    }
  });

  it('every kind too, and their own uses run nothing', () => {
    expect(opensOrSends('setsid xdg-open report.pdf', 'posix')).toBe(true);
    expect(opensOrSends('caffeinate -i open report.pdf', 'posix')).toBe(true);
    for (const cmd of [
      'ionice -p 1234',
      'taskset -p 1234',
      'chrt -p 1234',
      'strace -p 1234',
      'flock 9',
      'chroot /mnt/root',
      'watch -n 5 df -h',
      'stdbuf -oL tail -f log.txt',
      'caffeinate -t 60',
    ]) {
      expect(staticShellCategories(cmd, 'posix'), cmd).toEqual([]);
    }
  });

  // What the net does NOT promise, pinned so nobody reads more into it: a
  // wrapper absent from the table stays ONE unit, its own program; what it
  // runs is not read. Keeping an agent in bounds is the sandbox's job (#628).
  it('a wrapper not in the table stays one unit: what it runs is not read', () => {
    expect(isCatastrophicCommand('xvfb-run rm -rf /', 'posix')).toBe(false);
    expect(staticShellCategories('mywrapper lpr report.pdf', 'posix')).toEqual([]);
  });

  it('the allowlist refuses them, as every program that runs another', () => {
    for (const program of [
      'setsid',
      'stdbuf',
      'ionice',
      'chrt',
      'taskset',
      'nice',
      'unbuffer',
      'strace',
      'ltrace',
      'valgrind',
      'watch',
      'flock',
      'chroot',
      'unshare',
      'nsenter',
      'systemd-run',
      'firejail',
      'caffeinate',
      'gtimeout',
      'time',
      'builtin',
      'expect',
      'pkexec',
      'su',
      'runuser',
    ]) {
      expect(SHELL_PROGRAMS, program).toContain(program);
      expect(RUNS_ANOTHER_PROGRAMS, program).toContain(program);
    }
  });
});
