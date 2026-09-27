// router/delegated-files.ts — les fichiers qu'un enfant de délégation a écrits
// (issue #491).
//
// CE QUI S'EST PASSÉ (run e2e794db, 25/09/2026). Un spécialiste a écrit
// `voiceover-agentic-harness.wav` (`generate_speech` ok, 979 244 octets), puis
// le runner a redémarré pendant qu'il rédigeait sa réponse. Son parent n'a reçu
// que `[stopped: runner restarted …]` : rien ne lui disait que le fichier
// existait. Il a redélégué le même travail, et le propriétaire a reçu une
// demande d'approbation pour écraser un fichier déjà fait.
//
// LA SOURCE, ET POURQUOI ELLE-LÀ. Chaque outil qui écrit un fichier passe par
// le seam d'exécution (`packages/tools/src/execute.ts`), qui pose une ligne
// d'état de vérification AVANT l'écriture et la marque `produced` quand
// l'écriture est CONSTATÉE sur le disque ; `return_result.deliverables` pose
// `declared` sur la même ligne (#509). C'est la seule comptabilité des
// écritures d'un run qui ne dépende d'aucun outil : la relire ici donne au
// parent la même réponse quel que soit l'outil (fichier, bureautique, voix,
// shell), le runtime ou la façon dont l'enfant s'est arrêté.
//
// CE QU'ELLE NE VOIT PAS, et c'est dit : une surface que le propriétaire a
// sortie de la vérification (Réglages → vérification) ne pose aucune ligne, et
// un envoi (`outbound_action`) n'est pas un fichier. Dans ces cas la liste est
// vide et le parent retombe sur le texte de l'enfant, comme avant.

import { and, asc, eq, ne, or, jobDeliverableVerificationState } from '@nodal-agents/db';
import type { AnyDrizzleDb, JobId } from '../types';

/** Un fichier que l'enfant a écrit ou nommé comme livrable, tel que le parent le lit. */
export interface DelegatedFile {
  /** Le chemin tel que l'outil l'a résolu — celui que le parent peut relire. */
  path: string;
  /** L'enfant l'a-t-il NOMMÉ dans `return_result.deliverables` (#509) ? */
  declared: boolean;
  /** Où en est sa preuve (`dirty`, `green`, `red`, …) — le fait, pas un verdict. */
  proof: string;
}

/**
 * Les fichiers que ce job a ÉCRITS (écriture constatée) ou DÉCLARÉS, par
 * chemin croissant. Une tentative d'écriture qui n'a rien changé sur le
 * disque n'y est pas : la ligne reste `addressed` sans être `produced`.
 */
export async function readFilesWrittenBy(db: AnyDrizzleDb, jobId: JobId): Promise<DelegatedFile[]> {
  const t = jobDeliverableVerificationState;
  const rows = await db
    .select({
      key: t.canonicalKey,
      path: t.displayPathSnapshot,
      declared: t.declared,
      proof: t.decisionStatus,
    })
    .from(t)
    .where(
      and(
        eq(t.jobId, jobId as string),
        ne(t.deliverableType, 'outbound_action'),
        or(eq(t.produced, true), eq(t.declared, true)),
      ),
    )
    .orderBy(asc(t.canonicalKey));
  return rows.map((r) => ({ path: r.path ?? r.key, declared: r.declared, proof: r.proof }));
}
