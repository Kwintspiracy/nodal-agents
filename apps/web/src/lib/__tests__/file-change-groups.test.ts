// file-change-groups.test.ts — UN SEUL MOTEUR POUR DEUX ÉCRANS (issue #369).
//
// Ce que ce fichier prouve : pour LES MÊMES lignes d'audit, l'encart de
// livraison du fil et le panneau Changes de la page d'un run rangent les
// écritures sous les mêmes fichiers, comptent les mêmes lignes, et — une fois
// la plaque peinte — dessinent EXACTEMENT les mêmes rangées.
//
// C'est la question que la duplication posait : le regroupement vivait à
// l'intérieur de `getCodingProcessDetailAction`, donc dans un fichier
// `'use server'` où rien de synchrone ne s'exporte, et la seule façon de le
// donner au fil aurait été de le recopier. Deux copies auraient divergé au
// premier outil ajouté ; ce test échoue si quelqu'un en refait une.

import { describe, it, expect } from 'vitest';
import {
  fileChangesOfAuditRows,
  groupFileChanges,
  type AuditRowForChanges,
  type FileChangeCall,
} from '../file-change-groups.ts';
import { extractChange, isRefusedToolCall } from '../coding-changes.ts';
import { buildPlateRows, PLATE_LINE_LIMIT } from '@/app/(dashboard)/code/[id]/FileChangeBlock.tsx';

const ecriture = (path: string, content: string): AuditRowForChanges => ({
  toolName: 'file_write',
  toolInput: { path, content },
  toolOutput: '{"ok":true}',
  presented: { card: 'files', total: 1, truncated: false, files: [{ path, action: 'created' }] },
});

const edition = (path: string, oldText: string, newText: string): AuditRowForChanges => ({
  toolName: 'file_edit',
  toolInput: { path, old_string: oldText, new_string: newText },
  toolOutput: '{"ok":true}',
  presented: { card: 'files', total: 1, truncated: false, files: [{ path, action: 'modified' }] },
});

const lecture = (path: string): AuditRowForChanges => ({
  toolName: 'file_read',
  toolInput: { path },
  toolOutput: '{"ok":true}',
  presented: { card: 'files', total: 1, truncated: false, files: [{ path, action: 'listed' }] },
});

/**
 * Ce que fait la page d'un run avec les mêmes lignes : elle lit l'entrée de
 * chaque appel, écarte les refus, et passe le reste au regroupement partagé.
 * C'est la boucle de `getCodingProcessDetailAction`, sans ses requêtes.
 */
function commePageCode(
  rows: readonly AuditRowForChanges[],
  workspaceRoots: readonly string[],
): ReturnType<typeof groupFileChanges> {
  const calls: FileChangeCall[] = [];
  for (const row of rows) {
    const change = extractChange(row.toolName, row.toolInput);
    if (change === null) continue;
    if (isRefusedToolCall(row.toolOutput)) continue;
    calls.push({ change });
  }
  return groupFileChanges(calls, workspaceRoots);
}

describe('regroupement par fichier @cap:travailler-sur-des-fichiers/moteur', () => {
  const rows = [
    ecriture('src/a.ts', 'alpha\nbeta\ngamma'),
    lecture('src/lu.ts'),
    edition('src/a.ts', 'beta', 'BETA'),
    ecriture('src/b.ts', 'seul'),
  ];

  it('le fil et la page de code rendent LES MÊMES rangées pour les mêmes lignes d’audit', () => {
    const duFil = fileChangesOfAuditRows(rows, []);
    const deLaPage = commePageCode(rows, []);

    // Mêmes fichiers, dans le même ordre, avec les mêmes compteurs.
    expect(duFil.map((g) => g.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(deLaPage.map((g) => g.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(duFil.map((g) => [g.addedLines, g.removedLines])).toEqual(
      deLaPage.map((g) => [g.addedLines, g.removedLines]),
    );

    // Et les MÊMES rangées une fois la plaque peinte — le vrai enjeu : deux
    // écrans qui s'accordent sur le nombre de lignes mais pas sur leur contenu
    // resteraient deux moteurs.
    for (const [i, groupe] of duFil.entries()) {
      expect(buildPlateRows(groupe.edits, PLATE_LINE_LIMIT)).toEqual(
        buildPlateRows(deLaPage[i]!.edits, PLATE_LINE_LIMIT),
      );
    }

    // Ce que ces rangées disent vraiment, pour que le test ne compare pas deux
    // silences : la ligne remplacée et celle qui l'a remplacée sont là.
    const signees = buildPlateRows(duFil[0]!.edits, PLATE_LINE_LIMIT)
      .rows.filter((r): r is Extract<typeof r, { kind: 'line' }> => r.kind === 'line')
      .map((r) => [r.sign, r.text]);
    expect(signees).toContainEqual(['-', 'beta']);
    expect(signees).toContainEqual(['+', 'BETA']);
    expect(signees).toContainEqual(['+', 'alpha']);
  });

  it('les compteurs sont le churn des deux écritures du fichier', () => {
    const [a] = fileChangesOfAuditRows(rows, []);
    // Trois lignes écrites, puis une ligne écrite en remplacement d'une ligne.
    expect(a).toMatchObject({ filePath: 'src/a.ts', addedLines: 4, removedLines: 1 });
    expect(a?.edits).toHaveLength(2);
  });

  it('un fichier seulement LU n’est pas un fichier livré', () => {
    expect(fileChangesOfAuditRows([lecture('src/lu.ts')], [])).toEqual([]);
  });

  it('un appel REFUSÉ par le harnais n’apporte aucun fragment', () => {
    const refus: AuditRowForChanges = {
      ...ecriture('src/a.ts', 'jamais\nécrit'),
      toolOutput: '<tool_use_error>No such tool available: Write</tool_use_error>',
    };
    // La carte nomme encore le fichier — c'est ce que l'outil a présenté — mais
    // rien n'a été écrit, donc la plaque n'a aucune ligne à peindre.
    const [g] = fileChangesOfAuditRows([refus], []);
    expect(g).toMatchObject({ filePath: 'src/a.ts', addedLines: 0, removedLines: 0 });
    expect(buildPlateRows(g?.edits ?? [], PLATE_LINE_LIMIT).rows).toEqual([]);
  });

  it('le chemin ABSOLU et le chemin RELATIF du même fichier n’en font qu’un', () => {
    const racine = 'D:/ws/projet';
    const groupes = fileChangesOfAuditRows(
      [
        {
          ...ecriture('src/a.ts', 'un'),
          presented: {
            card: 'files',
            total: 1,
            truncated: false,
            files: [{ path: `${racine}/src/a.ts`, action: 'created' }],
          },
        },
        edition('src/a.ts', 'un', 'deux'),
      ],
      [racine],
    );
    expect(groupes.map((g) => g.filePath)).toEqual(['src/a.ts']);
    expect(groupes[0]?.edits).toHaveLength(2);
  });
});
