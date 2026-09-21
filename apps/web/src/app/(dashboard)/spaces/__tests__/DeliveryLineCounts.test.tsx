// DeliveryLineCounts.test.tsx — « +N −M » DIT CE QUE LA PLAQUE DESSINE (#394).
//
// La ligne d'un fichier livré portait un compte de CHURN (les lignes du nouveau
// texte contre celles de l'ancien) au-dessus d'une plaque qui dessine un diff.
// « en défilant je ne vois certainement pas 261 lignes vertes et une seule
// rouge » (Quentin, 21/09/2026). Les deux nombres viennent du même moteur
// depuis, et ce fichier le prouve des deux côtés : le nombre annoncé, et les
// rangées coloriées que l'on peut compter à l'écran.
//
// Les mêmes LIGNES D'AUDIT alimentent les deux : la parité est vérifiée sur un
// rendu, pas sur deux calculs parallèles.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import FileChangeBlock from '@/app/(dashboard)/code/[id]/FileChangeBlock.tsx';
import {
  fileChangesOfAuditRows,
  type AuditRowForChanges,
  type FileChangeGroup,
} from '@/lib/file-change-groups.ts';

const edition = (path: string, oldText: string, newText: string): AuditRowForChanges => ({
  toolName: 'file_edit',
  toolInput: { path, old_string: oldText, new_string: newText },
  toolOutput: '{"ok":true}',
  presented: { card: 'files', total: 1, truncated: false, files: [{ path, action: 'modified' }] },
});

const ecriture = (path: string, content: string): AuditRowForChanges => ({
  toolName: 'file_write',
  toolInput: { path, content },
  toolOutput: '{"ok":true}',
  presented: { card: 'files', total: 1, truncated: false, files: [{ path, action: 'created' }] },
});

const groupe = (rows: AuditRowForChanges[]): FileChangeGroup => {
  const groups = fileChangesOfAuditRows(rows, []);
  const first = groups[0];
  if (first === undefined) throw new Error('aucun fichier changé');
  return first;
};

/** Les rangées COLORIÉES de la plaque, telles qu'elles sortent du rendu. */
const rangees = (group: FileChangeGroup): { added: number; removed: number; html: string } => {
  const html = renderToStaticMarkup(<FileChangeBlock group={group} defaultOpen={true} />);
  return {
    added: html.match(/data-diff="\+"/g)?.length ?? 0,
    removed: html.match(/data-diff="-"/g)?.length ?? 0,
    html,
  };
};

describe('les compteurs d’un fichier livré @cap:verifier-un-livrable/moteur', () => {
  it('le cas de l’issue : 59 lignes remplacées par 261 dont 250 communes ne font pas « +261 −59 »', () => {
    const commun = Array.from({ length: 250 }, (_, i) => `<p>ligne ${i}</p>`);
    const avant = [...commun.slice(0, 50), ...Array.from({ length: 9 }, (_, i) => `<old ${i}>`)];
    const apres = [
      ...commun.slice(0, 50),
      ...Array.from({ length: 11 }, (_, i) => `<new ${i}>`),
      ...commun.slice(50),
    ];
    expect(avant).toHaveLength(59);
    expect(apres).toHaveLength(261);

    const g = groupe([edition('index.html', avant.join('\n'), apres.join('\n'))]);
    expect({ added: g.addedLines, removed: g.removedLines }).toEqual({ added: 211, removed: 9 });
  });

  it('une écriture sans texte précédent compte TOUT son contenu comme ajouté', () => {
    const g = groupe([ecriture('notes.md', ['un', 'deux', 'trois'].join('\n'))]);
    expect({ added: g.addedLines, removed: g.removedLines }).toEqual({ added: 3, removed: 0 });
  });

  it('les éditions successives d’un fichier s’additionnent, chacune sur le résultat de la précédente', () => {
    const g = groupe([
      ecriture('a.ts', ['un', 'deux'].join('\n')),
      edition('a.ts', ['un', 'deux'].join('\n'), ['un', 'DEUX', 'trois'].join('\n')),
    ]);
    expect({ added: g.addedLines, removed: g.removedLines }).toEqual({ added: 4, removed: 1 });
  });
});

// LA BORNE EST DANS L'ÉNONCÉ (Reviewer C, passe 1). La plaque coupe à
// `PLATE_LINE_LIMIT` rangées et compare des DÉBUTS de texte : au-delà, elle
// dessine moins de rangées qu'il n'y a de lignes, et le dit elle-même (« …
// N lines not shown »). La parité rangée à rangée ne vaut donc que sous cette
// borne, et chaque cas ci-dessous s'y tient.
describe('la ligne et sa plaque, sous la borne de la plaque @cap:verifier-un-livrable/ecran', () => {
  it('autant de rangées vertes que de « + », autant de rouges que de « − »', () => {
    // Vingt lignes dont trois changent : la plaque montre TOUT (sa borne est de
    // 80 rangées), donc ce qu'elle colorie et ce que la ligne annonce se
    // comparent rangée par rangée.
    const avant = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const apres = avant.map((l, i) => (i === 3 || i === 11 ? `${l} CHANGÉE` : l));
    apres.splice(7, 0, 'INSÉRÉE');

    const g = groupe([edition('src/a.ts', avant.join('\n'), apres.join('\n'))]);
    const { added, removed, html } = rangees(g);

    expect(added).toBe(g.addedLines);
    expect(removed).toBe(g.removedLines);
    // Et le libellé de la ligne porte ces nombres-là, entiers : une
    // sous-chaîne retrouverait « +3 » dans « +30 ».
    expect(html).toMatch(new RegExp(`>\\+${g.addedLines}<`));
    expect(html).toMatch(new RegExp(`>−${g.removedLines}<`));
    expect({ added, removed }).toEqual({ added: 3, removed: 2 });
  });

  it('une réécriture qui garde le gros du fichier ne peint pas tout en vert', () => {
    const avant = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const apres = [...avant.slice(0, 20), 'NOUVELLE', ...avant.slice(21)];

    const g = groupe([edition('src/b.ts', avant.join('\n'), apres.join('\n'))]);
    const { added, removed } = rangees(g);

    expect(added).toBe(g.addedLines);
    expect(removed).toBe(g.removedLines);
    // Le churn aurait annoncé « +40 −40 » sur une plaque montrant deux rangées.
    expect({ added, removed }).toEqual({ added: 1, removed: 1 });
  });

  it('une écriture entière est verte de bout en bout, et le dit', () => {
    const g = groupe([
      ecriture('notes.md', Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n')),
    ]);
    const { added, removed, html } = rangees(g);

    expect(added).toBe(12);
    expect(added).toBe(g.addedLines);
    expect(removed).toBe(0);
    expect(html).toMatch(/>\+12</);
  });
});
