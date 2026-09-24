/**
 * picked-folder-label.ts — le libellé sous lequel un dossier choisi par
 * Browse… est attaché (#461).
 *
 * Valider la fenêtre de Browse… attache le dossier aussitôt : il n'y a plus
 * d'écran intermédiaire où l'on voit le libellé avant qu'il parte en base.
 * Ce qui se voyait avant doit donc se DIRE quand ça ne va pas, jamais
 * s'abandonner en silence (invariant #4) :
 *
 *  - une racine (`/`) n'a pas de nom de dossier à prendre comme libellé ;
 *  - un libellé déjà porté par un autre dossier de l'agent serait refusé par
 *    la contrainte unique — on le dit avant l'aller-retour, avec le libellé
 *    en cause, que l'utilisateur n'a peut-être jamais tapé.
 */

export const MAX_FOLDER_LABEL = 80;

export type PickedFolderLabel =
  | { ok: true; label: string }
  | { ok: false; label: string; message: string };

/**
 * Le dernier segment d'un chemin POSIX, Windows ou UNC ; '' pour une racine,
 * y compris une racine de lecteur (`D:\` rendait « D: », revue finale).
 */
export function folderName(path: string): string {
  const last = path.split(/[/\\]/).filter(Boolean).pop() ?? '';
  return /^[A-Za-z]:$/.test(last) ? '' : last;
}

/**
 * Ce que le champ Libellé devient après un refus. Le libellé en cause n'y va
 * que quand c'est LUI le problème (conflit, ou refus avant le serveur) : après
 * une erreur de base, le dossier suivant partait sous le nom de l'ancien
 * (revue finale, Reviewer A, P2). Sinon, le champ garde ce qui y était tapé.
 */
export function labelAfterRefusal(code: string, derived: string, typed: string): string {
  return code === 'conflict' || code === 'refused_before_server' ? derived : typed;
}

export function pickedFolderLabel(
  typed: string,
  path: string,
  existingLabels: readonly string[],
): PickedFolderLabel {
  const label = (typed.trim() || folderName(path)).slice(0, MAX_FOLDER_LABEL);
  if (!label) {
    return {
      ok: false,
      label,
      message: 'This folder has no name to use as a label. Type a label, then Browse… again.',
    };
  }
  if (existingLabels.includes(label)) {
    return {
      ok: false,
      label,
      message: `This agent already has a folder labelled “${label}”. Change the label, then Browse… again.`,
    };
  }
  return { ok: true, label };
}

/**
 * Le résultat d'une action serveur, qu'elle réponde `{ ok: false }` ou qu'elle
 * REJETTE (serveur qui redémarre, réseau coupé). Après un ajout réussi, le
 * rechargement de la liste ne doit jamais lever : l'exception remontait
 * jusqu'à la fenêtre, qui disait « The folder was not added » alors que le
 * dossier était en base (revue de la PR #467, passe 3).
 */
export async function settled<T>(
  call: Promise<{ ok: true; data: T } | { ok: false; message: string }>,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    return await call;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
