// verification/tool-call-reads.ts — ce qu'un appel a LU (le pendant de tool-call-writes.ts).
//
// Chaque endroit où un outil du produit lit le contenu d'un fichier rapporte,
// quand la lecture réussit, le chemin résolu qu'il a ouvert et l'empreinte des
// OCTETS qu'il a lus (`ctx.reportReadContent`) : le lecteur de `file_read`,
// `readWorkspaceBinary` (tous les outils Office), `file_edit`, `file_search`,
// `skill_file_read` et les envois de fichier local (`send_file`, `send_image`,
// `send_video`/`send_audio`/`send_voice`). Ce module les RANGE, appel par
// appel, dans `tool_call_reads` : chemin réel (`cheminConstate`, la même forme
// que `tool_call_writes`), empreinte, liés à la ligne `tool_calls` de l'appel.
//
// La règle est la même pour tout outil, qu'il ne fasse que lire, qu'il lise
// avant d'écrire (`file_edit`, `xlsx_set_range`…) ou qu'il intègre une image
// (`docx_create`). Aucun outil n'est traité à part (règle #11). Un outil qui ne
// lit rien, ou une lecture qui échoue, ne rapporte rien et ne laisse aucune
// ligne. Ce qu'une commande, un harnais de code ou un outil MCP lit n'est pas
// ici : la plateforme n'ouvre pas ces fichiers elle-même.
//
// Ce n'est PAS une garde : une insertion qui échoue ne bloque jamais l'outil.
// Elle est journalisée par un code (`TOOL_CALL_READS_UNRECORDED`), et l'absence
// de ligne se lit « non enregistré », jamais comme la preuve que rien n'a été
// lu (invariant #4).

import type { AnyDrizzleDb } from '@nodal-agents/db';
import { toolCallReads } from '@nodal-agents/db';
import { cheminConstate } from './record-constat';

/**
 * Range, pour l'appel `toolCallId`, une ligne par fichier que l'outil a lu
 * (`read` : chemin résolu → empreinte des octets lus). Rend le nombre de
 * lignes rangées. Ne lève jamais : un échec est journalisé et rend 0.
 *
 * Sans ligne d'appel (l'insertion d'audit a échoué) ni job (un appel hors
 * job), il n'y a rien à quoi rattacher la ligne : rien n'est rangé, et ce
 * n'est pas anormal.
 */
export async function recordToolCallReads(input: {
  readonly db: AnyDrizzleDb;
  readonly toolCallId: string | null | undefined;
  readonly jobId: string | null | undefined;
  readonly toolName: string;
  readonly read: ReadonlyMap<string, string>;
}): Promise<number> {
  const { db, toolCallId, jobId } = input;
  if (!toolCallId || !jobId || input.read.size === 0) return 0;
  try {
    // Deux orthographes du même fichier (un lien et sa cible) sont un seul
    // fichier lu : le chemin RÉEL les rejoint, la dernière lecture l'emporte.
    const byPath = new Map<string, string>();
    for (const [chemin, sha256] of input.read) byPath.set(await cheminConstate(chemin), sha256);
    const values = [...byPath].map(([path, sha256]) => ({ toolCallId, jobId, path, sha256 }));
    await db.insert(toolCallReads).values(values);
    return values.length;
  } catch (err) {
    console.warn(
      `[verification] TOOL_CALL_READS_UNRECORDED tool=${input.toolName} job=${jobId} call=${toolCallId}`,
      err,
    );
    return 0;
  }
}
