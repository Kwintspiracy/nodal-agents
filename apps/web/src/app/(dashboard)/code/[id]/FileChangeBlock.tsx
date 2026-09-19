'use client';

// FileChangeBlock — un fichier changé de /code/[id], dessiné comme le bloc
// « fichier » du fil (planche #135).
//
// DEUX DESSINS, UN SEUL MOTEUR — ILS RESTENT ALIGNÉS (Reviewer C, #164).
// `spaces/FileDiff.tsx` dessine le même objet dans le fil, autrement : il
// DEMANDE son diff au runner (un diff git pris dans un instantané, chargé au
// premier clic), et le rend sans gouttière. Ici les fragments sont déjà en
// mémoire — la page les tient de son action — et la planche #135 demande la
// plaque numérotée. Fusionner les deux rendus maintenant changerait le fil,
// que cette PR ne doit pas toucher ; le bloc du fil se posera sur cette
// plaque-ci dans la PR #135 qui lui revient, et c'est CE fichier qui fait foi
// pour le dessin. En attendant, une seule chose doit rester vraie des deux
// côtés : les lignes sortent de `fragmentDiff`, jamais d'un second moteur.
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
import type { ConstatedChangeKind } from '@nodal-agents/shared';

/**
 * LE MOT DU GESTE, celui que git emploie.
 *
 * L'étiquette portait le nom de l'OUTIL (`file_write`, `file_edit`), ce qui
 * n'avait de sens que tant que la liste venait des outils. Depuis #199 elle
 * vient du constat, où un fichier peut avoir été supprimé ou renommé sans
 * qu'aucun outil l'ait nommé — deux gestes que le vocabulaire d'avant ne
 * savait pas dire.
 */
const GESTE_LIBELLE: Record<ConstatedChangeKind, string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
};

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
 * Les `budget` premières lignes d'un texte, ET son compte total.
 *
 * LE TEXTE EST COUPÉ AVANT LE DIFF (Reviewer C, #164). Une écriture de cent
 * mille lignes passait entière dans `fragmentDiff`, qui au-delà de sa propre
 * borne rend l'ancien PUIS le nouveau ligne à ligne : cent mille objets
 * construits pour en dessiner quatre-vingts. La plaque ne montre jamais plus
 * de `budget` rangées, donc plus de `budget` lignes de chaque version n'ont
 * aucune chance d'y entrer.
 *
 * Le total, lui, est compté SANS construire le tableau entier : c'est lui qui
 * garde « … and N more lines » exact alors que la comparaison est bornée.
 */
export function budgetedLines(
  text: string | null,
  budget: number,
): { lines: string[]; total: number } {
  if (text === null || text === '') return { lines: [], total: 0 };
  let total = 1;
  let seen = 0;
  let cut = -1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    total++;
    seen++;
    if (seen === budget) cut = i;
  }
  if (budget <= 0) return { lines: [], total };
  const head = cut === -1 ? text : text.slice(0, cut);
  return { lines: head.split('\n'), total };
}

/**
 * Les rangées d'un fichier, ses éditions mises bout à bout dans l'ordre.
 *
 * Deux compteurs, comme tout diff unifié : une ligne retirée porte son numéro
 * d'AVANT, une ligne ajoutée son numéro d'APRÈS, une ligne de contexte fait
 * avancer les deux et montre celui d'après.
 *
 * Ce qui manque est compté PAR VERSION (Reviewer C, passe 2). Une rangée de
 * contexte consomme une ligne de chaque côté, une rangée signée une seule :
 * additionner les deux restes donnait un nombre que rien à l'écran ne
 * représente — un fichier de 200 lignes entièrement réécrit montre 40 + 40
 * rangées et annonçait « 320 lignes de plus ». Jamais un rendu sans fin,
 * jamais une coupe muette, et jamais un compte qui promet des rangées.
 *
 * Comparer les DÉBUTS et non les textes entiers peut, sur un remaniement
 * complet, apparier autrement que ne l'aurait fait le diff global. Les rangées
 * montrées restent celles du début du changement, et ce qui manque est annoncé.
 */
export function buildPlateRows(
  edits: readonly CodingChangeView[],
  limit: number,
): { rows: PlateRow[]; hiddenOld: number; hiddenNew: number } {
  const rows: PlateRow[] = [];
  let oldNum = 0;
  let newNum = 0;
  let shown = 0;
  let hiddenOld = 0;
  let hiddenNew = 0;
  // La barre d'édition n'est posée qu'au moment où une ligne la suit : sans
  // ça, une édition entièrement coupée par la borne laissait une barre
  // orpheline en bas de la plaque.
  let pendingSep = false;

  edits.forEach((edit, index) => {
    if (index > 0) pendingSep = true;
    const budget = Math.max(0, limit - shown);
    const before = budgetedLines(edit.oldText, budget);
    const after = budgetedLines(edit.newText, budget);
    const diff = fragmentDiff(before.lines.join('\n'), after.lines.join('\n'));
    let usedOld = 0;
    let usedNew = 0;
    for (const line of diff.lines) {
      if (shown >= limit) break;
      let num: number;
      if (line.kind === '-') {
        num = ++oldNum;
        usedOld++;
      } else if (line.kind === '+') {
        num = ++newNum;
        usedNew++;
      } else {
        oldNum++;
        num = ++newNum;
        usedOld++;
        usedNew++;
      }
      if (pendingSep) {
        rows.push({ kind: 'edit-sep' });
        pendingSep = false;
      }
      shown++;
      rows.push({ kind: 'line', sign: line.kind, num, text: line.text });
    }
    hiddenOld += before.total - usedOld;
    hiddenNew += after.total - usedNew;
  });

  return { rows, hiddenOld, hiddenNew };
}

/**
 * Le pied de la plaque, ou `null` quand elle a tout montré.
 *
 * Une seule version tronquée — le cas courant, une écriture — se dit d'une
 * phrase. Les deux tronquées se disent en deux nombres : additionner ferait
 * croire à autant de rangées de plus.
 */
export function hiddenNote(hiddenOld: number, hiddenNew: number): string | null {
  if (hiddenOld > 0 && hiddenNew > 0) {
    return `… ${hiddenOld} old, ${hiddenNew} new lines not shown`;
  }
  const only = hiddenOld + hiddenNew;
  return only > 0 ? `… and ${only} more lines` : null;
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
  const { rows, hiddenOld, hiddenNew } = useMemo(
    () => buildPlateRows(group.edits, PLATE_LINE_LIMIT),
    [group.edits],
  );
  const note = hiddenNote(hiddenOld, hiddenNew);
  // Le geste porté sur ce fichier, dit dans le vocabulaire du fil. Le groupe
  // rassemble plusieurs appels sur un même chemin : c'est le PREMIER qui le
  // nomme — un fichier écrit puis retouché a bien été écrit.
  //
  // LE CONSTAT PASSE AVANT LA DÉCLARATION (issue #199). `changeKind` vient de
  // ce que git a vu autour du run ; les appels d'outils, eux, ne disent que ce
  // qu'ils ont TENTÉ, et ils ne savent pas dire « supprimé ». Un fichier que
  // git a vu et qu'aucun outil n'a nommé n'a que ce mot-là.
  const geste: ConstatedChangeKind =
    group.changeKind ?? (group.edits[0]?.kind === 'write' ? 'added' : 'modified');

  return (
    <div className="overflow-hidden rounded-xl border border-rule-2">
      <DisclosureButton
        open={open}
        onClick={() => setOpen((v) => !v)}
        inset="tight"
        className="h-[42px] py-0"
      >
        <span className="shrink-0 text-mono-12 text-feed-tool" data-testid="file-change-kind">
          {GESTE_LIBELLE[geste]}
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
          {note !== null && (
            <p className="border-t border-rule-2 px-4 py-1.5 text-mono-11 text-ink-4">{note}</p>
          )}
        </div>
      )}
    </div>
  );
}
