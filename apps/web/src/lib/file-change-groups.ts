// file-change-groups.ts — UN FICHIER CHANGÉ, ET CE QU'IL A PRIS DE LIGNES.
//
// UN SEUL MOTEUR, DEUX ÉCRANS (issue #369). La page d'un process de code
// dessine depuis août une plaque de diff unifié par fichier ; l'encart de
// livraison du fil, lui, ne listait que des chemins. Il dessine la même plaque
// depuis #369, et la question devenait : deux regroupements, ou un seul ?
//
// Un seul. Le regroupement vivait à l'intérieur de `getCodingProcessDetailAction`
// (`actions.ts`, un fichier `'use server'` où rien de synchrone ne peut
// s'exporter), donc hors de portée du fil et hors de portée d'un test. Il est
// ici, pur, et les deux écrans l'appellent. Recopier la boucle aurait fait
// diverger les deux surfaces au premier outil ajouté — exactement ce que
// `coding-changes.ts` avait déjà eu à réparer pour les compteurs.
//
// CE MODULE NE COMPARE RIEN. Les lignes d'un diff sortent de `fragmentDiff`
// (`@nodal-agents/shared`), appelé par la plaque au moment de peindre. Ici on
// ne fait que RASSEMBLER : quel fichier, quelles éditions, combien de lignes
// ajoutées et retirées. Les compteurs sortent du MÊME diff que la plaque
// (`changeLineCounts`, issue #394), la même lecture que la page Code.

import {
  canonicalChangePath,
  changeLineCounts,
  extractChange,
  isRefusedToolCall,
  type CodingChangeView,
} from './coding-changes.ts';
import { callHappened, outcomeOfToolOutput, parsePresented } from './tool-card-payload.ts';
import type { ConstatedChangeKind } from '@nodal-agents/shared';

/**
 * LE MOT DU GESTE porte sur un fichier, tel que la plaque le dit.
 *
 * Aux quatre mots du constat (`ConstatedChangeKind`) s'ajoute `written`, et il
 * manquait (Reviewer C, PR #380). `file_write` écrit OU écrase, et sa carte dit
 * `written` dans les deux cas : le ranger d'office dans `added` affirmait une
 * création sur chaque écrasement. Le mot de la carte est le seul vrai.
 */
export type FileChangeGesture = ConstatedChangeKind | 'written';

/**
 * L'HISTOIRE COMPLÈTE D'UN FICHIER dans un pipeline — l'unité du panneau
 * Changes de la page Code, et celle de l'encart de livraison depuis #369.
 */
export type FileChangeGroup = {
  filePath: string;
  /**
   * Le diff de chaque édition de ce fichier, sommé — pas un diff fusionné des
   * deux versions extrêmes : chaque édition agit sur le résultat de la
   * précédente, et c'est aussi ce que la plaque dessine, édition par édition.
   */
  addedLines: number;
  removedLines: number;
  /**
   * Chronologiques, racine et délégués mêlés. Chacune est son propre morceau :
   * une édition agit sur le RÉSULTAT de la précédente, les coller en un seul
   * bloc mentirait sur la séquence.
   */
  edits: CodingChangeView[];
  /**
   * Ce que le CONSTAT dit de ce fichier (issue #199) : créé, modifié, supprimé,
   * renommé. Absent d'un run d'avant la migration 0113, dont la liste est
   * encore celle que les outils ont déclarée — et `written` quand c'est la
   * carte de l'outil qui le dit, elle qui ne distingue pas les deux.
   */
  changeKind?: FileChangeGesture;
};

/**
 * Une écriture retenue, prête à être rangée sous son fichier.
 *
 * `resolvedPath` est le chemin ABSOLU quand l'appelant sait le résoudre (la
 * page Code le fait, par les dossiers de travail de l'agent qui a passé
 * l'appel). Sans lui, le chemin de l'appel sert tel quel.
 */
export type FileChangeCall = {
  change: CodingChangeView;
  resolvedPath?: string | null;
};

/**
 * Les écritures, rangées par fichier, dans l'ordre où les fichiers ont été
 * touchés pour la première fois.
 *
 * La clé est le chemin CANONIQUE (`canonicalChangePath`) : la forme absolue du
 * CLI et la forme relative des outils Nodal se rejoignent sur un seul fichier
 * au lieu de deux. Par ÉGALITÉ, jamais par suffixe — `index.ts` et `a/index.ts`
 * sont deux fichiers.
 */
export function groupFileChanges(
  calls: readonly FileChangeCall[],
  workspaceRoots: readonly string[],
): FileChangeGroup[] {
  const groups = new Map<string, FileChangeGroup>();
  for (const { change, resolvedPath } of calls) {
    const canonical = canonicalChangePath(resolvedPath ?? change.filePath, workspaceRoots);
    const group = groups.get(canonical) ?? {
      filePath: canonical,
      addedLines: 0,
      removedLines: 0,
      edits: [],
    };
    const counts = changeLineCounts(change);
    group.addedLines += counts.added;
    group.removedLines += counts.removed;
    group.edits.push({ ...change, filePath: canonical });
    groups.set(canonical, group);
  }
  return [...groups.values()];
}

/**
 * Une ligne d'audit, réduite à ce que ce module en lit.
 *
 * ELLE ARRIVE DÉJÀ MASQUÉE (`redactAuditRow`, #150 et Reviewer C du 18/09) :
 * l'entrée d'une écriture est DESSINÉE par la plaque — `old_string`,
 * `new_string`, `content` tels quels — et le masquage se fait à la porte du
 * chargeur, pas ici, pour qu'aucun lecteur ne puisse l'oublier.
 */
export type AuditRowForChanges = {
  toolName: string;
  toolInput: unknown;
  toolOutput: string | null;
  presented: unknown;
  /**
   * Les chemins de la carte AVANT masquage, dans l'ordre exact de
   * `presented.files` — l'IDENTITÉ des fichiers, jamais leur affichage (#161).
   */
  rawFilePaths?: readonly string[];
};

/**
 * CE QU'UN TRAVAIL A ÉCRIT, tel que l'encart de livraison le montre.
 *
 * LA LISTE VIENT DES CARTES, LES FRAGMENTS VIENNENT DES ENTRÉES. Deux sources,
 * et c'est voulu : la carte `files` dit ce qu'un outil a présenté comme écrit —
 * y compris un outil dont ce module ne sait pas lire l'entrée, un classeur par
 * exemple — tandis que l'avant/après d'un fragment n'existe que dans l'entrée
 * de l'appel. Un fichier nommé par une carte dont aucune entrée ne se lit garde
 * donc sa ligne, avec zéro ligne et aucune édition : la plaque dit alors « no
 * text recorded », ce qui est vrai, au lieu de disparaître de l'écran.
 *
 * L'identité est le chemin BRUT, l'affichage le chemin MASQUÉ (#161) : deux
 * fichiers dont les chemins ne diffèrent que par une chaîne de forme credential
 * masquent vers le même chemin et ne compteraient plus qu'un. Rien de brut ne
 * sort d'ici ; seul le chemin masqué est rendu.
 *
 * Les fichiers seulement LUS (`listed`) ne comptent pas : « 12 fichiers » sous
 * un récapitulatif de livraison veut dire douze fichiers livrés, pas douze
 * fichiers regardés. Un appel qui n'a pas eu lieu (erreur, blocage, attente
 * d'approbation) ne compte pas non plus, et un appel REFUSÉ par le harnais n'a
 * écrit aucun fragment (`isRefusedToolCall`).
 */
/** Ce que la carte a dit d'un fichier livré, avec le chemin brut qui l'identifie. */
type DisplayedFile = { path: string; changeKind: FileChangeGesture; rawPath: string };

/**
 * LA LISTE DES FICHIERS LIVRÉS, telle que les cartes la disent : clé canonique
 * brute → ce que la carte a dit, dans l'ordre d'écriture. Un seul parcours pour
 * l'encart (`fileChangesOfAuditRows`) et pour la route qui sert un média
 * (`deliveredFileSources`, #490) : les deux listes sont la même, dans le même
 * ordre, et le rang d'un fichier désigne le même des deux côtés.
 */
function displayedFiles(
  rows: readonly AuditRowForChanges[],
  workspaceRoots: readonly string[],
): Map<string, DisplayedFile> {
  const display = new Map<string, DisplayedFile>();
  for (const row of rows) {
    if (!callHappened(outcomeOfToolOutput(row.toolOutput))) continue;
    const p = parsePresented(row.presented);
    if (p === null || p.card !== 'files') continue;
    p.files.forEach((f, i) => {
      if (f.action === 'listed') return;
      const rawPath = row.rawFilePaths?.[i] ?? f.path;
      const key = canonicalChangePath(rawPath, workspaceRoots);
      // Le geste vient de la CARTE, pas des fragments (#369) : la plaque est
      // repliée d'abord, ses fragments n'arrivent qu'au clic, et un mot déduit
      // d'eux aurait dit « modified » sur un fichier créé jusqu'au dépli.
      // C'est le PREMIER appel qui nomme le fichier qui décide — un fichier
      // écrit puis retouché a bien été créé.
      if (!display.has(key)) {
        display.set(key, {
          path: canonicalChangePath(f.path, workspaceRoots),
          changeKind: f.action === 'created' ? 'added' : f.action,
          rawPath,
        });
      }
    });
  }
  return display;
}

/**
 * LES FICHIERS LIVRÉS AVEC LEUR CHEMIN BRUT, pour la seule route qui sert un
 * média (#490). Même liste, même ordre que `fileChangesOfAuditRows`. Le
 * chemin brut est celui que l'outil a présenté (absolu pour `file_write` et
 * `generate_speech`, relatif pour `file_edit`) : il ne sort JAMAIS du serveur,
 * il sert à retrouver le fichier sur le disque.
 */
export function deliveredFileSources(
  rows: readonly AuditRowForChanges[],
  workspaceRoots: readonly string[],
): { filePath: string; rawPath: string }[] {
  return [...displayedFiles(rows, workspaceRoots).values()].map((d) => ({
    filePath: d.path,
    rawPath: d.rawPath,
  }));
}

export function fileChangesOfAuditRows(
  rows: readonly AuditRowForChanges[],
  workspaceRoots: readonly string[],
): FileChangeGroup[] {
  const display = displayedFiles(rows, workspaceRoots);
  const calls: FileChangeCall[] = [];
  for (const row of rows) {
    if (!callHappened(outcomeOfToolOutput(row.toolOutput))) continue;
    if (isRefusedToolCall(row.toolOutput)) continue;
    const change = extractChange(row.toolName, row.toolInput);
    if (change !== null) calls.push({ change });
  }
  const byPath = new Map(groupFileChanges(calls, workspaceRoots).map((g) => [g.filePath, g]));
  return [...display.entries()].map(([key, dit]) => {
    const group = byPath.get(key);
    return {
      filePath: dit.path,
      changeKind: dit.changeKind,
      addedLines: group?.addedLines ?? 0,
      removedLines: group?.removedLines ?? 0,
      // Les fragments portent le chemin MASQUÉ eux aussi : ils voyagent jusqu'à
      // l'écran, et l'identité brute ne sort jamais de cette fonction.
      edits: (group?.edits ?? []).map((e) => ({ ...e, filePath: dit.path })),
    };
  });
}
