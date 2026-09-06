// fragment-diff.ts — le diff d'un FRAGMENT, ligne par ligne (P11, plan « De la
// maquette au produit »).
//
// POURQUOI CE MODULE EXISTE À PART DU DIFF GIT. Un `file_edit` porte déjà les
// deux versions du fragment sur sa ligne d'audit : `old_string` et
// `new_string`. Aucun instantané, aucun dépôt, aucun processus `git` n'est
// nécessaire pour montrer ce qui a changé — le comparer se fait sur place, avec
// deux chaînes. Passer par le magasin fantôme pour ça reviendrait à demander à
// git de recalculer une différence qu'on tient déjà, et à faire dépendre
// l'affichage d'un fichier qui a pu changer dix fois depuis.
//
// POURQUOI DANS `shared` ET PAS DANS LE WEB. C'est une fonction pure sur deux
// chaînes : elle se teste sans navigateur, et le seul autre diff de lignes du
// dépôt (l'aperçu d'une mise à jour de skill, apps/web/src/lib/line-diff.ts) en
// dérive désormais au lieu d'en tenir une seconde copie. Deux LCS écrits à la
// main auraient divergé au premier ajustement, et « deux textes présentés comme
// identiques » est précisément le bug qu'un diff ne doit jamais avoir.

/** Une ligne du script de différences : ajoutée, retirée, ou de contexte. */
export interface FragmentDiffLine {
  kind: '+' | '-' | ' ';
  text: string;
}

/**
 * Au-delà, le diff ligne à ligne n'est plus calculé. LCS est en O(n×m) : deux
 * textes de 5 000 lignes, c'est 25 millions de cases pour dessiner un mur que
 * personne ne lit. Passé la borne, le lecteur reçoit un remplacement en bloc —
 * grossier, mais honnête, et annoncé par `truncated`.
 */
export const FRAGMENT_DIFF_MAX_LINES = 2000;

/**
 * Ce qui distingue `oldText` de `newText`, en lignes, dans l'ordre.
 *
 * Les lignes de contexte (`' '`) sont RENDUES, pas éliminées : c'est
 * l'affichage qui décide de les replier. Un diff qui ne montrerait que les
 * lignes changées obligerait l'écran à deviner où elles se trouvent.
 *
 * `truncated` = la borne est tombée et le résultat est un remplacement en bloc.
 */
export function fragmentDiff(
  oldText: string,
  newText: string,
): { lines: FragmentDiffLine[]; truncated: boolean } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');

  if (a.length > FRAGMENT_DIFF_MAX_LINES || b.length > FRAGMENT_DIFF_MAX_LINES) {
    return {
      lines: [
        ...a.map((text): FragmentDiffLine => ({ kind: '-', text })),
        ...b.map((text): FragmentDiffLine => ({ kind: '+', text })),
      ],
      truncated: true,
    };
  }

  // lcs[i][j] = longueur de la plus longue sous-suite commune de a[i:] et b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: FragmentDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: ' ', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ kind: '-', text: a[i]! });
      i++;
    } else {
      lines.push({ kind: '+', text: b[j]! });
      j++;
    }
  }
  while (i < a.length) {
    lines.push({ kind: '-', text: a[i]! });
    i++;
  }
  while (j < b.length) {
    lines.push({ kind: '+', text: b[j]! });
    j++;
  }

  return { lines, truncated: false };
}
