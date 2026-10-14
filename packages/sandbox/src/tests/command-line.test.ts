// command-line.test.ts — la ligne de commande Windows que MXC reçoit doit
// faire lire à l'enfant EXACTEMENT les arguments que Node lui aurait passés.
// Prouvé deux fois : contre la règle de libuv (cas connus), et, sous Windows,
// par un vrai processus qui relit son argv.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { quoteWindowsArg, windowsCommandLine } from '../command-line';

describe('quoteWindowsArg (règle de libuv quote_cmd_arg)', () => {
  it.each([
    ['', '""'],
    ['plain', 'plain'],
    ['with space', '"with space"'],
    ['C:\\Program Files\\nodejs\\node.exe', '"C:\\Program Files\\nodejs\\node.exe"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['trailing\\ slash\\', '"trailing\\ slash\\\\"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['no-quote\\needed', 'no-quote\\needed'],
  ])('%j ⇒ %j', (arg, quoted) => {
    expect(quoteWindowsArg(arg)).toBe(quoted);
  });
});

describe('windowsCommandLine', () => {
  it('une commande shell prend la forme de `spawn(…, { shell: true })` sous Windows', () => {
    expect(
      windowsCommandLine(
        { command: 'npm install && node build.js' },
        'C:\\WINDOWS\\system32\\cmd.exe',
      ),
    ).toBe('C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npm install && node build.js"');
  });

  it('verbatim : les éléments joints tels quels (la forme de la liste blanche)', () => {
    expect(
      windowsCommandLine(
        {
          file: 'C:\\WINDOWS\\system32\\cmd.exe',
          args: ['/d', '/s', '/c', '"npx.cmd vitest"'],
          windowsVerbatimArguments: true,
        },
        'ignored',
      ),
    ).toBe('C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx.cmd vitest"');
  });

  it.runIf(process.platform === 'win32')(
    'Windows : un vrai processus relit exactement les arguments donnés (Windows only)',
    () => {
      const args = ['a cat', 'say "hi"', 'trailing\\ slash\\', '', '; rm -rf /', '%PATH%'];
      const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
      // La ligne construite ici, passée TELLE QUELLE au système : en verbatim,
      // libuv joint argv0 et les arguments par une espace, sans rien citer.
      const line = windowsCommandLine(
        { file: process.execPath, args: ['-e', script, ...args] },
        'cmd.exe',
      );
      const head = quoteWindowsArg(process.execPath);
      expect(line.startsWith(`${head} `)).toBe(true);
      const r = spawnSync(process.execPath, [line.slice(head.length + 1)], {
        argv0: head,
        shell: false,
        windowsVerbatimArguments: true,
        encoding: 'utf8',
      });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(args);
    },
  );
});
