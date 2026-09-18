// cli-write-tools.test.ts — ce qu'une ligne d'outil CLI déclare d'un fichier.
//
// Issue #102 : ces déclarations sont la SEULE façon de savoir quels fichiers
// regarder après un run de harnais, puisque ses écritures ne passent par aucun
// outil de Nodal. Ce qui est lu ici décide donc de ce qui sera constaté sur le
// disque — et de ce qui ne le sera pas.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { pathsDeclaredByCliWrite } from '../cli-write-tools';

afterEach(() => vi.restoreAllMocks());

describe('pathsDeclaredByCliWrite @cap:verifier-un-livrable/moteur', () => {
  it('lit un chemin par appel chez Claude Code, une écriture', () => {
    expect(pathsDeclaredByCliWrite('cli:Write', { file_path: '/ws/a.ts', content: 'x' })).toEqual([
      { path: '/ws/a.ts', kind: 'write' },
    ]);
    expect(pathsDeclaredByCliWrite('cli:Edit', { file_path: '/ws/b.ts' })).toEqual([
      { path: '/ws/b.ts', kind: 'write' },
    ]);
  });

  it('lit PLUSIEURS fichiers chez Codex, avec leur genre', () => {
    const lus = pathsDeclaredByCliWrite('cli:file_change', {
      changes: [
        { path: '/ws/a.ts', kind: 'add', diff: '+1' },
        { path: '/ws/b.ts', kind: 'update', diff: '+2' },
        { path: '/ws/c.ts', kind: 'delete', diff: '-3' },
      ],
    });
    expect(lus).toEqual([
      { path: '/ws/a.ts', kind: 'write' },
      { path: '/ws/b.ts', kind: 'write' },
      { path: '/ws/c.ts', kind: 'delete' },
    ]);
  });

  it('un genre INCONNU est traité en écriture, et DIT', () => {
    // Revue C de la PR #196, passe 3. Le cas qui viendra est un `rename` : le
    // rabattre en silence ferait chercher le fichier à son ancien chemin, et
    // mettre son absence au compte d'une écriture ratée.
    const dits: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      dits.push(args.map(String).join(' '));
    });

    const lus = pathsDeclaredByCliWrite('cli:file_change', {
      changes: [{ path: '/ws/ancien.ts', kind: 'rename', diff: '' }],
    });

    expect(lus).toEqual([{ path: '/ws/ancien.ts', kind: 'write' }]);
    expect(
      dits.some((l) => l.includes('HARNESS_UNKNOWN_CHANGE_KIND') && l.includes('rename')),
    ).toBe(true);
  });

  it('le même genre inconnu ne se dit qu’UNE fois', () => {
    // Un CLI qui renomme trente fichiers en écrirait trente lignes, et
    // l'avertissement deviendrait le bruit qui fait ignorer les avertissements.
    const dits: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      dits.push(args.map(String).join(' '));
    });

    for (let i = 0; i < 3; i += 1) {
      pathsDeclaredByCliWrite('cli:file_change', {
        changes: [{ path: `/ws/f${i}.ts`, kind: 'sorcellerie' }],
      });
    }

    expect(dits.filter((l) => l.includes('sorcellerie'))).toHaveLength(1);
  });

  it('un outil qui n’écrit pas, ou une entrée informe, ne déclare rien', () => {
    expect(pathsDeclaredByCliWrite('cli:Read', { file_path: '/ws/a.ts' })).toEqual([]);
    expect(pathsDeclaredByCliWrite('cli:Write', null)).toEqual([]);
    expect(pathsDeclaredByCliWrite('cli:Write', { file_path: '   ' })).toEqual([]);
    expect(pathsDeclaredByCliWrite('cli:file_change', { changes: [{ kind: 'add' }] })).toEqual([]);
  });
});
