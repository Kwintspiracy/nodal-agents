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

// L'HISTORIQUE NE SUFFIT PAS (revue Codex, P1). `produced` dit qu'une
// écriture a eu lieu, pas que le fichier est encore là : une suppression
// ultérieure le laisse `true`, et une ligne seulement `declared` nomme un
// fichier que l'enfant n'a peut-être jamais écrit. Dire au parent « ce fichier
// existe, ne refais pas » sur cette seule foi le laissait croire à un livrable
// absent. Chaque ligne est donc relue SUR LE DISQUE au moment de la reprise :
// présent (avec sa taille) ou absent, et c'est ce fait-là que le parent reçoit.

import { stat } from 'node:fs/promises';
import { and, asc, eq, ne, or, jobDeliverableVerificationState } from '@nodal-agents/db';
import type { AnyDrizzleDb, JobId } from '../types';

/** Un fichier que l'enfant a écrit ou nommé comme livrable, tel que le parent le lit. */
export interface DelegatedFile {
  /** Le chemin tel que l'outil l'a résolu — celui que le parent peut relire. */
  path: string;
  /** Une écriture de l'enfant a-t-elle été CONSTATÉE (historique, pas l'état actuel) ? */
  written: boolean;
  /** L'enfant l'a-t-il NOMMÉ dans `return_result.deliverables` (#509) ? */
  declared: boolean;
  /** Le chemin existe-t-il sur le disque AU MOMENT de la reprise ? */
  on_disk: boolean;
  /** Sa taille en octets quand c'est un fichier présent, sinon `null`. */
  bytes: number | null;
  /** Où en est sa preuve (`dirty`, `green`, `red`, …) — le fait, pas un verdict. */
  proof: string;
}

/** L'état actuel d'un chemin : absent, dossier (sans taille) ou fichier (avec sa taille). */
async function surLeDisque(path: string): Promise<{ on_disk: boolean; bytes: number | null }> {
  try {
    const s = await stat(path);
    return { on_disk: true, bytes: s.isFile() ? s.size : null };
  } catch {
    return { on_disk: false, bytes: null };
  }
}

/**
 * Les fichiers que ce job a ÉCRITS (écriture constatée) ou DÉCLARÉS, par
 * chemin croissant, chacun avec son état actuel sur le disque. Une tentative
 * d'écriture qui n'a rien changé n'y est pas : la ligne reste `addressed` sans
 * être `produced`.
 */
export async function readFilesWrittenBy(db: AnyDrizzleDb, jobId: JobId): Promise<DelegatedFile[]> {
  const t = jobDeliverableVerificationState;
  const rows = await db
    .select({
      key: t.canonicalKey,
      path: t.displayPathSnapshot,
      written: t.produced,
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
  const files: DelegatedFile[] = [];
  for (const r of rows) {
    const path = r.path ?? r.key;
    const etat = await surLeDisque(path);
    files.push({
      path,
      written: r.written,
      declared: r.declared,
      on_disk: etat.on_disk,
      bytes: etat.bytes,
      proof: r.proof,
    });
  }
  return files;
}
