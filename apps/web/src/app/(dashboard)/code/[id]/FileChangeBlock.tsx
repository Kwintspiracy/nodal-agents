'use client';

// FileChangeBlock — un fichier changé de /code/[id], dessiné comme le bloc
// « fichier » du fil (planche #135).
//
// ET L'ENCART DE LIVRAISON DU FIL SE POSE DESSUS (#369). Il listait des
// chemins ; il montre désormais CETTE plaque, une par fichier, repliée. Les
// groupes viennent du même module qu'ici (`lib/file-change-groups.ts`) et les
// lignes du même `fragmentDiff` : pour un même run, les deux écrans peignent
// les mêmes rangées. Deux différences, et elles sont dans les props : le fil
// replie (`defaultOpen={false}`) et va chercher ses fragments au premier clic
// (`onOpen`, `pending`), parce qu'un fil ne peut pas embarquer le texte de
// cent écritures dans chaque rendu.
//
// `spaces/FileDiff.tsx` dessine encore un TROISIÈME objet, et c'est une autre
// question : le diff git d'un fichier pris dans un instantané, demandé au
// runner depuis la carte « N fichiers » d'un appel d'outil. Une seule chose
// doit rester vraie des trois côtés : les lignes sortent de `fragmentDiff`,
// jamais d'un second moteur.
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
import type { FileChangeGesture, FileChangeGroup } from '@/lib/file-change-groups.ts';

/**
 * LE MOT DU GESTE, celui que git emploie.
 *
 * L'étiquette portait le nom de l'OUTIL (`file_write`, `file_edit`), ce qui
 * n'avait de sens que tant que la liste venait des outils. Depuis #199 elle
 * vient du constat, où un fichier peut avoir été supprimé ou renommé sans
 * qu'aucun outil l'ait nommé — deux gestes que le vocabulaire d'avant ne
 * savait pas dire.
 */
const GESTE_LIBELLE: Record<FileChangeGesture, string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  // `file_write` ECRIT OU ÉCRASE, et sa carte ne distingue pas les deux
  // (Reviewer C, PR #380). Le mot reste celui de la carte plutôt que d'affirmer
  // une création sur chaque écrasement.
  written: 'written',
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

/**
 * Une rangée de la plaque, telle que la planche la dessine (nœud
 * « DeliveryBlock », 560:7076).
 *
 * LE SIGNE VOYAGE AVEC LE TEXTE, ET LA RANGÉE PORTE SA COULEUR. Le signe
 * vivait dans une colonne à part, grise, et tout texte se peignait en
 * `text-code-text` : une ligne retirée se lisait de la même encre qu'une ligne
 * de contexte, et seul son fond la distinguait. La planche colore le texte —
 * `text-err` sur `bg-warn-bg`, `text-ok` sur `bg-ok-bg`. Le signe fait un
 * caractère de large sur TOUTES les rangées, contexte compris (une espace),
 * donc le code reste aligné d'une rangée à l'autre.
 */
function PlateLine({ row }: { row: Extract<PlateRow, { kind: 'line' }> }) {
  const tone =
    row.sign === '+'
      ? 'bg-ok-bg text-ok'
      : row.sign === '-'
        ? 'bg-warn-bg text-err'
        : 'text-code-text';
  return (
    <div className={`flex w-full gap-3 px-3.5 py-px ${tone}`} data-diff={row.sign}>
      <span className="w-7 shrink-0 text-right text-mono-12 text-ink-4 select-none">{row.num}</span>
      <span className="text-mono-12 whitespace-pre">
        {row.sign === ' ' ? ' ' : row.sign}
        {row.text || ' '}
      </span>
    </div>
  );
}

export default function FileChangeBlock({
  group,
  defaultOpen = true,
  onOpen,
  pending = false,
  emptyNote,
  flush = false,
}: {
  group: FileChangeGroup;
  /**
   * La page d'un run ouvre ses plaques d'entrée : la planche montre les
   * fichiers dépliés, et la borne de 80 lignes rend la page finie même sur un
   * pipeline bavard. L'encart de livraison du fil, lui, les REPLIE (#369) : il
   * conclut un travail au milieu d'une conversation, et douze diffs dépliés
   * enterreraient la suite du fil.
   */
  defaultOpen?: boolean;
  /**
   * Appelé quand la plaque S'OUVRE, jamais quand elle se ferme. C'est le signal
   * du chargement paresseux : l'encart du fil n'a que les en-têtes, et va
   * chercher les fragments au premier dépli.
   */
  onOpen?: () => void;
  /**
   * Les fragments sont EN ROUTE. Sans lui, une plaque encore vide dirait « no
   * text recorded » — une absence affirmée alors que la réponse n'est pas
   * arrivée (invariant #4).
   */
  pending?: boolean;
  /**
   * Ce que dit la plaque quand elle n'a AUCUNE ligne à peindre, si la raison
   * n'est pas celle du cas courant (« aucun texte enregistré »). L'encart du
   * fil s'en sert pour dire qu'un chargement a échoué, plutôt que d'affirmer
   * une absence qu'il n'a pas constatée (invariant #4).
   */
  emptyNote?: string;
  /**
   * BORD À BORD, sans cadre à soi (Quentin, 22/09, devant l'encart de
   * livraison : « the diff/file block shall be edge to edge »). La page d'un
   * run pose ses plaques dans une colonne, chacune une carte arrondie ; dans
   * l'encart du fil elles occupent TOUTE la largeur de la boîte, séparées par
   * un simple filet, comme les cellules et la section Proof qui les encadrent.
   *
   * La dernière ne porte pas son filet bas : la section suivante dessine déjà
   * le sien, et deux filets collés font une ligne deux fois trop épaisse.
   */
  flush?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
  const geste: FileChangeGesture =
    group.changeKind ?? (group.edits[0]?.kind === 'write' ? 'added' : 'modified');

  return (
    <div
      className={
        flush
          ? 'w-full bg-paper border-b border-rule-2 first:border-t last:border-b-0'
          : 'overflow-hidden rounded-xl border border-rule-2'
      }
    >
      <DisclosureButton
        open={open}
        // Le signal se donne HORS de la mise à jour d'état : React rejoue les
        // fonctions de mise à jour en mode strict, et un effet posé dedans
        // partirait deux fois.
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onOpen?.();
        }}
        inset="tight"
        // La hauteur reste écrite EN TOUTES LETTRES, la même des deux côtés :
        // `__tests__/DisclosureButton.test.tsx` refuse un `className` en
        // expression sur cette balise, et il a raison — un retrait caché dans
        // un ternaire est exactement le trou que sa garde ferme (#151).
        insetY="none"
        className="h-[42px]"
      >
        {/* GRAS, comme la planche : le mot du geste est ce que le regard
            accroche en premier sur la rangée, avant le chemin. */}
        <span
          className="shrink-0 text-mono-12 font-bold text-feed-tool"
          data-testid="file-change-kind"
        >
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
          {pending && rows.length === 0 ? (
            <p className="px-4 py-2 text-mono-11 text-ink-4">Loading the diff…</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-2 text-mono-11 text-ink-4">
              {emptyNote ?? 'No text recorded for this change.'}
            </p>
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
