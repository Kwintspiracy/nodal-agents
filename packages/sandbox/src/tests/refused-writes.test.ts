// refused-writes.test.ts — les refus d'écriture lus dans une sortie réelle.
// Chaque ligne d'entrée est une ligne MESURÉE (essais #731 / #733, ou les
// suites Windows de ce PR), jamais une ligne inventée pour le test.

import { describe, it, expect } from 'vitest';
import { extractRefusedWrites } from '../refused-writes';

const WS = 'C:\\Users\\u\\AppData\\Local\\Temp\\nodal-sbx-x\\ws';
const CANARY = 'C:\\Users\\u\\AppData\\Local\\Temp\\nodal-sbx-x\\canary';

describe('extractRefusedWrites', () => {
  it('Node EPERM : le chemin cité, la ligne telle quelle ; l’écho `code:` n’est pas un second refus', () => {
    const out = [
      "Error: EPERM: operation not permitted, open 'C:\\Users\\u\\AppData\\Local\\Temp\\nodal-sbx-x\\canary\\node.txt'",
      '    at Object.openSync (node:fs:573:18)',
      '  errno: -4048,',
      "  code: 'EPERM',",
      "  syscall: 'open',",
    ].join('\n');
    expect(extractRefusedWrites(out, [WS], WS)).toEqual([
      {
        path: `${CANARY}\\node.txt`,
        error:
          "Error: EPERM: operation not permitted, open 'C:\\Users\\u\\AppData\\Local\\Temp\\nodal-sbx-x\\canary\\node.txt'",
      },
    ]);
  });

  it('Python : le chemin `repr` (antislashs doublés) est ramené au chemin réel', () => {
    const line =
      "PermissionError: [Errno 13] Permission denied: 'C:\\\\Users\\\\u\\\\AppData\\\\Local\\\\Temp\\\\nodal-sbx-x\\\\canary\\\\py.txt'";
    expect(extractRefusedWrites(line, [WS], WS)).toEqual([
      { path: `${CANARY}\\py.txt`, error: line },
    ]);
  });

  it('cmd.exe `Access is denied.` : un refus SANS chemin — on ne devine pas lequel', () => {
    expect(extractRefusedWrites('Access is denied.\r\n', [WS], WS)).toEqual([
      { path: null, error: 'Access is denied.' },
    ]);
  });

  it('shells Unix (EROFS sous bubblewrap, EPERM sous Seatbelt)', () => {
    const out = [
      '/bin/sh: 1: cannot create /tmp/mxc-trial/canary/shell.txt: Read-only file system',
      'rm: cannot remove /tmp/mxc-trial/canary/existing.txt: Operation not permitted',
    ].join('\n');
    expect(
      extractRefusedWrites(out, ['/tmp/mxc-trial/workspace'], '/tmp/mxc-trial/workspace'),
    ).toEqual([
      {
        path: '/tmp/mxc-trial/canary/shell.txt',
        error: '/bin/sh: 1: cannot create /tmp/mxc-trial/canary/shell.txt: Read-only file system',
      },
      {
        path: '/tmp/mxc-trial/canary/existing.txt',
        error: 'rm: cannot remove /tmp/mxc-trial/canary/existing.txt: Operation not permitted',
      },
    ]);
  });

  it('un refus DANS un dossier permis n’est pas imputé au bac à sable (fichier verrouillé…)', () => {
    const inside = `Error: EPERM: operation not permitted, unlink '${WS}\\locked.db'`;
    const relativeInside = "PermissionError: [Errno 13] Permission denied: 'out\\\\locked.txt'";
    expect(extractRefusedWrites(`${inside}\n${relativeInside}`, [WS], WS)).toEqual([]);
  });

  it('un chemin relatif hors des dossiers permis reste écrit tel que la ligne le donne', () => {
    const line = "Error: EACCES: permission denied, mkdir '..\\canary\\x'";
    expect(extractRefusedWrites(line, [WS], WS)).toEqual([{ path: '..\\canary\\x', error: line }]);
  });

  it('rename : les deux chemins, seul celui du dehors est rendu', () => {
    const line = `Error: EPERM: operation not permitted, rename '${WS}\\a.txt' -> '${CANARY}\\a.txt'`;
    expect(extractRefusedWrites(line, [WS], WS)).toEqual([
      { path: `${CANARY}\\a.txt`, error: line },
    ]);
  });

  it('une sortie sans refus ne rend rien ; une boucle de refus est plafonnée à 20', () => {
    expect(extractRefusedWrites('added 1 package in 694ms\n', [WS], WS)).toEqual([]);
    const flood = Array.from(
      { length: 50 },
      (_, i) => `Error: EPERM: operation not permitted, open '${CANARY}\\f${i}.txt'`,
    ).join('\n');
    expect(extractRefusedWrites(flood, [WS], WS)).toHaveLength(20);
  });
});
