// constated-writes.ts — COMMENT les écritures d'un run ont été constatées, et
// sous quel genre chaque fichier y figure.
//
// Trois surfaces lisent ces mots : `packages/tools` les écrit (le seam, après
// l'outil), `packages/db` les range (table `constated_writes`), `apps/web` les
// rend (le bloc Files). Le type vit donc ici, en un seul exemplaire — deux
// copies divergeraient au premier genre ajouté, et le bloc Files afficherait un
// mot que la base ne connaît pas.

/**
 * D'où vient la liste des fichiers d'un run.
 *
 * `git` — le dossier du projet est un dépôt : `git status --porcelain` a été
 *   lu avant et après le run, et le DELTA est le constat. C'est le seul mode
 *   qui voit ce qu'un shell écrit sans le nommer.
 * `disk` — le dossier n'est pas un dépôt (ou git n'a pas répondu) : la règle
 *   de #196 s'applique, les fichiers NOMMÉS par les outils et par le harnais
 *   sont relus sur le disque, et ce qu'un shell écrit sans le nommer n'est pas
 *   constaté. L'absence est dite, jamais comblée (invariant #4).
 */
export type ConstatedBy = 'git' | 'disk';

/** Le genre d'une écriture constatée — ce que git voit du fichier. */
export type ConstatedChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export const CONSTATED_BY: readonly ConstatedBy[] = ['git', 'disk'];
export const CONSTATED_CHANGE_KINDS: readonly ConstatedChangeKind[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
];

export function isConstatedBy(value: unknown): value is ConstatedBy {
  return value === 'git' || value === 'disk';
}

export function isConstatedChangeKind(value: unknown): value is ConstatedChangeKind {
  return value === 'added' || value === 'modified' || value === 'deleted' || value === 'renamed';
}

/** Une ligne du constat : un fichier, son genre, et d'où le constat vient. */
export interface ConstatedWrite {
  /** Chemin ABSOLU slash-normalisé. */
  readonly path: string;
  readonly kind: ConstatedChangeKind;
  /** Le nom d'avant, pour un renommage seulement. */
  readonly renamedFrom?: string | null;
}
