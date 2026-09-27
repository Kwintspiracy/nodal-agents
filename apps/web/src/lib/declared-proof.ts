// declared-proof.ts — ce que les lignes de preuve CONCLUENT, une fois comptés
// les fichiers que le run a promis (issue #509).
//
// Trois écrans concluent « Proof passed » ou « Proof failed » (le fil d'une
// conversation, la page d'un run, le détail d'un process de code). Ils le
// faisaient sur les seules lignes de `verification_runs` : un fichier promis
// que rien n'a jamais constaté n'y laisse aucune ligne, et le récapitulatif
// disait « Verified » sur les sources d'un rendu dont la vidéo n'existait pas.
// La règle vit ICI, une fois, et les trois écrans l'appellent — une seconde
// copie divergerait au premier correctif.
//
// Module pur, sans `server-only` : le détail d'un process de code le rend côté
// client.

import { canonicalChangePath } from './coding-changes.ts';

/**
 * Un fichier que le run a PROMIS (`return_result.deliverables`) et dont
 * l'état n'est pas vert : son adresse, et l'état tel que la finalisation l'a
 * laissé (`red`, `dirty`, `infra_error`…).
 */
export type ThreadDeclaredDeliverable = { path: string; status: string };

/** Une ligne de la section « Proof » du récapitulatif. */
export type ProofCheck = { command: string; ok: boolean };

/**
 * Les contrôles à montrer et le verdict, depuis les lignes de preuve (déjà
 * réduites à la dernière séquence par livrable) et les fichiers promis non
 * verts.
 *
 *  - `null` sans aucune ligne de preuve : il n'y a rien à conclure ;
 *  - `red` dès qu'une ligne lâche ;
 *  - `green` seulement si tout est vert ET qu'aucun fichier promis n'est en
 *    suspens — sinon `null` : l'écran ne sait pas que c'est rouge, il sait que
 *    ce n'est pas vert, et il dit « Not verified ».
 *
 * Un fichier promis ROUGE a déjà sa ligne rouge (`exists`, `well-formed:…`) :
 * il n'est pas nommé deux fois. Les autres sont NOMMÉS, à côté de ce qui a été
 * vérifié — c'est ce que l'issue demande : dire ce qui a été contrôlé, et ce
 * qui ne l'a pas été.
 */
export function concludeProof(
  proof: readonly { command: string; verdict: string }[],
  declaredUnverified: readonly ThreadDeclaredDeliverable[],
  workspaceRoots: readonly string[],
): { checks: ProofCheck[]; verdict: 'green' | 'red' | null } {
  const passed = proof.filter((r) => r.verdict === 'green').length;
  const checks: ProofCheck[] = [
    ...proof.map((r) => ({ command: r.command, ok: r.verdict === 'green' })),
    ...declaredUnverified
      .filter((d) => d.status !== 'red')
      .map((d) => ({
        command: `${canonicalChangePath(d.path, workspaceRoots)}: not verified (${d.status})`,
        ok: false,
      })),
  ];
  const verdict =
    proof.length === 0
      ? null
      : passed < proof.length
        ? 'red'
        : declaredUnverified.length > 0
          ? null
          : 'green';
  return { checks, verdict };
}
