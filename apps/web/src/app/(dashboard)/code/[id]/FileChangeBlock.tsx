'use client';

// FileChangeBlock — un fichier changé de /code/[id], dessiné comme le bloc
// « fichier » du fil (planche #135, GO Quentin 18/09).
//
// CE QUI DISPARAÎT AVEC LUI. La page rendait un diff SPLIT maison
// (`buildSplitRows`, `SplitDiffCell`, `FileSplitDiff`) : deux demi-colonnes où
// toute ligne de code réelle était coupée au bord, et un dessin qui n'existait
// que sur cet écran. La planche ne garde qu'un seul dessin de « ce qui a
// changé », le diff UNIFIÉ que le fil montre depuis P11.
//
// LE MÊME MOTEUR QUE LE FIL. Les lignes sortent de `fragmentDiff`
// (`packages/shared`), la fonction que le panneau du fil appelle déjà pour un
// `file_edit` : deux chaînes, aucun `git`, aucun instantané. Rien n'est
// recalculé ici, donc les deux écrans ne peuvent pas diverger sur ce qu'ils
// appellent une ligne ajoutée.
//
// LES NUMÉROS SONT CEUX DU FRAGMENT, PAS DU FICHIER. Une ligne d'audit
// `file_edit` porte l'avant et l'après du FRAGMENT remplacé, jamais l'endroit
// où il se trouvait : à ce stade personne ne sait que c'était la ligne 84. La
// gouttière numérote donc depuis 1, en continu sur toutes les éditions du même
// fichier — exactement ce que le côte à côte faisait déjà de ses numéros.

import { useMemo, useState } from 'react';
import { fragmentDiff } from '@nodal-agents/shared';
import DisclosureButton from '@/components/ui/DisclosureButton';
import type { CodingChangeView } from '@/lib/coding-changes.ts';
import type { CodingFileChangeGroup } from '@/lib/actions.ts';

/**
 * Au-delà, la plaque s'arrête et le dit. La page portait déjà une borne (80
 * rangées de côte à côte) : un pipeline de quinze fichiers × deux mille lignes
 * ne se dessine pas, et un écran qui essaie ne rend plus la main.
 */
export const PLATE_LINE_LIMIT = 80;

/** Une rangée de la plaque : une ligne de diff, ou la barre entre deux éditions. */
export type PlateRow =
  | { kind: 'line'; sign: '+' | '-' | ' '; num: number; text: string }
  | { kind: 'edit-sep' };

/**
 * Les rangées d'un fichier, ses éditions mises bout à bout dans l'ordre.
 *
 * Deux compteurs, comme tout diff unifié : une ligne retirée porte son numéro
 * d'AVANT, une ligne ajoutée son numéro d'APRÈS, une ligne de contexte fait
 * avancer les deux et montre celui d'après. `hidden` compte les lignes que la
 * borne a laissées dehors — jamais un rendu sans fin, jamais une coupe muette.
 */
export function buildPlateRows(
  edits: readonly CodingChangeView[],
  limit: number,
): { rows: PlateRow[]; hidden: number; simplified: boolean } {
  const rows: PlateRow[] = [];
  let oldNum = 0;
  let newNum = 0;
  let shown = 0;
  let hidden = 0;
  let simplified = false;
  // La barre d'édition n'est posée qu'au moment où une ligne la suit : sans
  // ça, une édition entièrement coupée par la borne laissait une barre
  // orpheline en bas de la plaque.
  let pendingSep = false;

  edits.forEach((edit, index) => {
    if (index > 0) pendingSep = true;
    const diff = fragmentDiff(edit.oldText ?? '', edit.newText ?? '');
    if (diff.truncated) simplified = true;
    for (const line of diff.lines) {
      let num: number;
      if (line.kind === '-') {
        num = ++oldNum;
      } else if (line.kind === '+') {
        num = ++newNum;
      } else {
        oldNum++;
        num = ++newNum;
      }
      if (shown >= limit) {
        hidden++;
        continue;
      }
      if (pendingSep) {
        rows.push({ kind: 'edit-sep' });
        pendingSep = false;
      }
      shown++;
      rows.push({ kind: 'line', sign: line.kind, num, text: line.text });
    }
  });

  return { rows, hidden, simplified };
}

function PlateLine({ row }: { row: Extract<PlateRow, { kind: 'line' }> }) {
  const bg = row.sign === '+' ? 'bg-ok-bg' : row.sign === '-' ? 'bg-warn-bg' : '';
  return (
    <div className={`flex w-full ${bg}`} data-diff={row.sign}>
      <span className="w-12 shrink-0 pr-3 text-right text-mono-11 text-ink-4 select-none">
        {row.num}
      </span>
      <span className="w-3 shrink-0 text-mono-12 text-ink-4 select-none">
        {row.sign === ' ' ? '' : row.sign}
      </span>
      <span className="pr-4 text-mono-12 whitespace-pre text-code-text">{row.text || ' '}</span>
    </div>
  );
}

export default function FileChangeBlock({ group }: { group: CodingFileChangeGroup }) {
  // Ouvert d'entrée : la planche montre les fichiers dépliés, et la borne de
  // 80 lignes rend la page finie même sur un pipeline bavard.
  const [open, setOpen] = useState(true);
  const { rows, hidden, simplified } = useMemo(
    () => buildPlateRows(group.edits, PLATE_LINE_LIMIT),
    [group.edits],
  );
  // Le geste porté sur ce fichier, dit dans le vocabulaire du fil. Le groupe
  // rassemble plusieurs appels sur un même chemin : c'est le PREMIER qui le
  // nomme — un fichier écrit puis retouché a bien été écrit.
  const written = group.edits[0]?.kind === 'write';

  return (
    <div className="overflow-hidden rounded-xl border border-rule-2">
      <DisclosureButton
        open={open}
        onClick={() => setOpen((v) => !v)}
        inset="tight"
        className="h-[42px] py-0"
      >
        <span className="shrink-0 text-mono-12 text-feed-tool">
          {written ? 'file_write' : 'file_edit'}
        </span>
        {/* Le chemin se tronque par la GAUCHE : c'est sa fin qui porte le nom
            du fichier (même règle que `FileName` dans le fil). */}
        <span
          dir="rtl"
          title={group.filePath}
          className="min-w-0 flex-1 truncate text-left text-mono-12 text-feed-path"
        >
          <bdi dir="ltr">{group.filePath}</bdi>
        </span>
        <span className="shrink-0 text-mono-11">
          {group.addedLines > 0 && <span className="text-ok">+{group.addedLines}</span>}
          {group.addedLines > 0 && group.removedLines > 0 && ' '}
          {group.removedLines > 0 && <span className="text-err">−{group.removedLines}</span>}
        </span>
      </DisclosureButton>
      {open && (
        <div className="border-t border-rule-2 bg-code-bg">
          {/* Un appel d'écriture sans texte (un classeur, une ligne d'audit
              ancienne) n'a rien à peindre : ça se dit, plutôt que de laisser
              une plaque vide passer pour « aucun changement ». */}
          {rows.length === 0 ? (
            <p className="px-4 py-2 text-mono-11 text-ink-4">No text recorded for this change.</p>
          ) : (
            <div className="max-h-[480px] overflow-auto">
              <div className="min-w-max py-2">
                {rows.map((row, i) =>
                  row.kind === 'edit-sep' ? (
                    <div key={i} className="my-2 border-t border-rule-2" />
                  ) : (
                    <PlateLine key={i} row={row} />
                  ),
                )}
              </div>
            </div>
          )}
          {simplified && (
            <p className="border-t border-rule-2 px-4 py-1.5 text-mono-11 text-ink-4">
              diff simplified: too long to compare line by line
            </p>
          )}
          {hidden > 0 && (
            <p className="border-t border-rule-2 px-4 py-1.5 text-mono-11 text-ink-4">
              … and {hidden} more lines
            </p>
          )}
        </div>
      )}
    </div>
  );
}
