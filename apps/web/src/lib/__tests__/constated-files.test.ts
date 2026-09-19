// constated-files.test.ts — LA LISTE VIENT DU CONSTAT (issue #199).
//
// Ce que ces cas prouvent : que la liste montrée est celle du constat, que le
// diff d'un fichier qu'un outil a aussi nommé la suit, qu'un fichier DÉCLARÉ
// mais jamais constaté disparaît, et qu'un run sans aucune ligne de constat
// garde sa liste d'avant plutôt que de se vider.
//
// Les assertions portent sur les LIGNES rendues — leur chemin, leur genre,
// leurs fragments — jamais sur un nombre d'appels.

import { describe, it, expect } from 'vitest';
import {
  faconsDeConstater,
  labelDuConstat,
  rapprocherConstat,
  type ConstatRow,
} from '../constated-files.ts';

const ROOTS = ['D:/projets/monapp'];

const ligne = (
  path: string,
  kind: ConstatRow['changeKind'],
  par: ConstatRow['constatedBy'] = 'git',
): ConstatRow => ({
  path,
  changeKind: kind,
  constatedBy: par,
  renamedFrom: null,
});

const declare = (filePath: string, texte: string) => ({
  filePath,
  addedLines: 1,
  removedLines: 0,
  edits: [{ filePath, kind: 'write' as const, oldText: null, newText: texte }],
});

describe('rapprocherConstat @cap:travailler-sur-des-fichiers/moteur', () => {
  it('rend la liste du CONSTAT, et lui accroche le diff quand un outil l’a nommé', () => {
    const out = rapprocherConstat({
      rows: [
        ligne('D:/projets/monapp/src/a.ts', 'modified'),
        ligne('D:/projets/monapp/dist/genere.js', 'added'),
      ],
      declared: [declare('src/a.ts', 'const a = 1;')],
      workspaceRoots: ROOTS,
    });

    expect(out.map((o) => [o.filePath, o.changeKind, o.declared !== null])).toEqual([
      ['src/a.ts', 'modified', true],
      ['dist/genere.js', 'added', false],
    ]);
    expect(out[0]?.declared?.edits[0]?.newText).toBe('const a = 1;');
  });

  it('un fichier DÉCLARÉ que rien n’a constaté ne paraît plus', () => {
    // Le cas symétrique de celui qui manquait : un `file_edit` dont le
    // fragment est introuvable n'écrit rien, et la page l'annonçait quand même.
    const out = rapprocherConstat({
      rows: [ligne('D:/projets/monapp/src/vrai.ts', 'modified')],
      declared: [declare('src/vrai.ts', 'ok'), declare('src/jamais-ecrit.ts', 'non')],
      workspaceRoots: ROOTS,
    });

    expect(out.map((o) => o.filePath)).toEqual(['src/vrai.ts']);
  });

  it('le même fichier vu deux fois ne fait qu’une ligne', () => {
    const out = rapprocherConstat({
      rows: [
        ligne('D:/projets/monapp/src/a.ts', 'added'),
        ligne('D:/projets/monapp/src/a.ts', 'modified'),
      ],
      declared: [],
      workspaceRoots: ROOTS,
    });

    expect(out.map((o) => [o.filePath, o.changeKind])).toEqual([['src/a.ts', 'added']]);
  });

  it('la casse d’un chemin Windows ne dédouble pas le fichier', () => {
    // git rend `src/A.ts`, l'outil a écrit `D:/Projets/MonApp/src/A.ts` : le
    // même fichier. Une comparaison sensible à la casse le montrerait deux
    // fois, une fois avec son diff et une fois sans.
    const out = rapprocherConstat({
      rows: [ligne('d:/projets/monapp/src/A.ts', 'modified')],
      declared: [declare('src/a.ts', 'const a = 1;')],
      workspaceRoots: ROOTS,
    });

    expect(out).toHaveLength(1);
    expect(out[0]?.declared?.edits[0]?.newText).toBe('const a = 1;');
  });
});

describe('ce qui fait foi pour la liste @cap:travailler-sur-des-fichiers/moteur', () => {
  it('un run qui a écrit des deux côtés porte les deux mots', () => {
    const rows = [
      ligne('D:/projets/monapp/src/a.ts', 'modified', 'git'),
      ligne('D:/documents/note.docx', 'added', 'disk'),
    ];
    expect(faconsDeConstater(rows)).toEqual(['git', 'disk']);
    expect(labelDuConstat(faconsDeConstater(rows))).toBe(
      'Constated by git, and on disk for the files outside a repository',
    );
  });

  it('aucune ligne de constat se DIT, plutôt que de passer pour un constat', () => {
    expect(faconsDeConstater([])).toEqual([]);
    expect(labelDuConstat([])).toBe('Declared by the tools, not constated');
  });

  it('chacun des deux mots a sa phrase', () => {
    expect(labelDuConstat(['git'])).toBe(
      'Constated by git: the delta of git status around each run',
    );
    expect(labelDuConstat(['disk'])).toBe(
      'Constated on disk: the files the tools named, read before and after',
    );
  });
});
