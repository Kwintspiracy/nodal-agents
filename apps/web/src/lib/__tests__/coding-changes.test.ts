// coding-changes.test.ts — la lecture d'une écriture dans un appel d'outil.
//
// Ces fonctions vivaient dans `actions.ts`, non exportées et donc non
// testables : la page Code les éprouvait de très loin, par une action serveur
// entière. Extraites (P2bis), elles se prouvent ici, appel par appel — et
// c'est le même code qui alimente les compteurs « −a +b » du fil.

import { describe, it, expect } from 'vitest';
import {
  canonicalChangePath,
  changeLineCounts,
  extractChange,
  extractFilePath,
  findLineCounts,
  isRefusedToolCall,
  lineCountsOfCall,
  sumLineCounts,
} from '../coding-changes.ts';

describe('extractFilePath', () => {
  it('lit les trois formes de chemin des outils du dépôt', () => {
    expect(extractFilePath({ file_path: 'a.ts' })).toBe('a.ts');
    expect(extractFilePath({ notebook_path: 'b.ipynb' })).toBe('b.ipynb');
    expect(extractFilePath({ path: 'c.md' })).toBe('c.md');
    expect(extractFilePath({ query: 'x' })).toBeNull();
    expect(extractFilePath(null)).toBeNull();
  });
});

describe('isRefusedToolCall', () => {
  it('reads the outcome of the row (#1184): failed, refused or held changed nothing', () => {
    expect(isRefusedToolCall('failed')).toBe(true);
    expect(isRefusedToolCall('refused')).toBe(true);
    expect(isRefusedToolCall('awaiting_approval')).toBe(true);
    expect(isRefusedToolCall('done')).toBe(false);
    // Unknown may have acted; a row older than the column is counted, not dropped.
    expect(isRefusedToolCall('unknown')).toBe(false);
    expect(isRefusedToolCall(null)).toBe(false);
    expect(isRefusedToolCall(undefined)).toBe(false);
  });

  it('a value outside the closed set is a broken writer, said loud', () => {
    expect(() => isRefusedToolCall('<tool_use_error>')).toThrow(/TOOL_CALL_OUTCOME_OUT_OF_SET/);
  });
});

describe('extractChange', () => {
  it('file_edit et cli:Edit rendent l’avant et l’après', () => {
    expect(extractChange('file_edit', { path: 'a.ts', old_string: 'x', new_string: 'y' })).toEqual({
      filePath: 'a.ts',
      kind: 'edit',
      oldText: 'x',
      newText: 'y',
    });
    expect(
      extractChange('cli:Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
    ).toEqual({ filePath: 'a.ts', kind: 'edit', oldText: 'x', newText: 'y' });
  });

  it('file_write et cli:Write n’ont pas d’avant : c’est une écriture', () => {
    expect(extractChange('file_write', { path: 'a.ts', content: 'hello' })).toEqual({
      filePath: 'a.ts',
      kind: 'write',
      oldText: null,
      newText: 'hello',
    });
  });

  it('cli:MultiEdit concatène ses sous-éditions', () => {
    expect(
      extractChange('cli:MultiEdit', {
        file_path: 'a.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      }),
    ).toEqual({ filePath: 'a.ts', kind: 'edit', oldText: 'a\nc', newText: 'b\nd' });
  });

  it('cli:NotebookEdit sans old_source passe pour une écriture', () => {
    expect(
      extractChange('cli:NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'x' }),
    ).toEqual({ filePath: 'n.ipynb', kind: 'write', oldText: null, newText: 'x' });
  });

  it('un outil qui n’écrit pas de texte ne rend rien', () => {
    expect(extractChange('xlsx_write', { path: 'b.xlsx', rows: [] })).toBeNull();
    expect(extractChange('file_read', { path: 'a.ts' })).toBeNull();
  });
});

describe('lineCountsOfCall — les compteurs « −a +b »', () => {
  it('compte les lignes écrites et les lignes remplacées', () => {
    expect(
      lineCountsOfCall(
        'file_edit',
        { path: 'src/session.ts', old_string: 'a\nb', new_string: 'c\nd\ne' },
        null,
      ),
    ).toEqual({ 'src/session.ts': { added: 3, removed: 2 } });
  });

  it('un appel REFUSÉ n’a aucun compteur : il n’a rien écrit', () => {
    expect(
      lineCountsOfCall('cli:Write', { file_path: 'a.ts', content: 'x\ny\nz' }, 'failed'),
    ).toEqual({});
  });

  it('un outil sans texte (un classeur) n’a aucun compteur', () => {
    expect(lineCountsOfCall('xlsx_write', { path: 'b.xlsx' }, 'done')).toEqual({});
  });

  it('cli:file_change compte TOUS les fichiers de l’appel, pas seulement le premier', () => {
    expect(
      lineCountsOfCall(
        'cli:file_change',
        {
          path: 'a.ts',
          changes: [
            { path: 'a.ts', kind: 'update', diff: 'l1\nl2' },
            { path: 'b.ts', kind: 'add', diff: 'l1\nl2\nl3' },
          ],
        },
        null,
      ),
    ).toEqual({ 'a.ts': { added: 2, removed: 0 }, 'b.ts': { added: 3, removed: 0 } });
  });

  it('deux écritures du même fichier dans un seul appel s’additionnent', () => {
    expect(
      lineCountsOfCall(
        'cli:file_change',
        {
          path: 'a.ts',
          changes: [
            { path: 'a.ts', kind: 'update', diff: 'l1' },
            { path: 'a.ts', kind: 'update', diff: 'l2\nl3' },
          ],
        },
        null,
      ),
    ).toEqual({ 'a.ts': { added: 3, removed: 0 } });
  });
});

describe('findLineCounts — le compteur d’un fichier de la carte du MÊME appel', () => {
  it('un appel qui n’a écrit qu’un fichier : tout chemin de sa carte le désigne (résolu ou relatif)', () => {
    // `file_write` présente le chemin résolu, son entrée porte le relatif.
    const un = { 'notes/bonjour.html': { added: 12, removed: 0 } };
    expect(
      findLineCounts(un, 'C:\\Users\\q\\.nodalai\\workspaces\\shared\\notes\\bonjour.html'),
    ).toEqual({
      added: 12,
      removed: 0,
    });
    expect(findLineCounts(un, 'notes/bonjour.html')).toEqual({ added: 12, removed: 0 });
  });

  it('un appel à plusieurs fichiers : par égalité de chemin, jamais par suffixe (passes 56-57)', () => {
    const deux = {
      'a/index.ts': { added: 2, removed: 0 },
      'b/index.ts': { added: 9, removed: 1 },
    };
    expect(findLineCounts(deux, 'b/index.ts')).toEqual({ added: 9, removed: 1 });
    expect(findLineCounts(deux, 'index.ts')).toBeNull();
    expect(findLineCounts(deux, 'D:/ws/b/index.ts')).toBeNull();
  });

  it('rend null quand l’appel n’a rien écrit', () => {
    expect(findLineCounts({}, 'src/a.ts')).toBeNull();
  });
});

describe('canonicalChangePath — la règle de la page Code, partagée', () => {
  const roots = ['C:\\Users\\q\\.nodalai\\workspaces\\shared', '/home/q/ws'];

  it('retire la racine connue, insensible à la casse sur Windows, et normalise les barres', () => {
    expect(
      canonicalChangePath('c:\\users\\Q\\.nodalai\\workspaces\\shared\\notes\\bonjour.html', roots),
    ).toBe('notes/bonjour.html');
    expect(canonicalChangePath('/home/q/ws/src/a.ts', roots)).toBe('src/a.ts');
  });

  it('laisse un chemin relatif tel quel (sans « ./ »), et un absolu hors racine tel quel', () => {
    expect(canonicalChangePath('./notes/bonjour.html', roots)).toBe('notes/bonjour.html');
    expect(canonicalChangePath('index.ts', roots)).toBe('index.ts');
    expect(canonicalChangePath('/tmp/x.ts', roots)).toBe('/tmp/x.ts');
  });

  it('`index.ts` et `<racine>/a/index.ts` restent DEUX fichiers (passe 57)', () => {
    const a = canonicalChangePath('index.ts', roots);
    const b = canonicalChangePath('/home/q/ws/a/index.ts', roots);
    expect(a).not.toBe(b);
    expect(b).toBe('a/index.ts');
  });
});

describe('changeLineCounts et sumLineCounts', () => {
  it('un texte vide ne compte aucune ligne', () => {
    expect(
      changeLineCounts({ filePath: 'a', kind: 'write', oldText: null, newText: null }),
    ).toEqual({ added: 0, removed: 0 });
  });

  it('la somme additionne tous les fichiers de tous les appels', () => {
    expect(
      sumLineCounts([
        { 'a.ts': { added: 3, removed: 1 }, 'b.ts': { added: 2, removed: 0 } },
        { 'a.ts': { added: 4, removed: 2 } },
      ]),
    ).toEqual({ added: 9, removed: 3 });
  });
});
