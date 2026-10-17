// verification/tool-call-writes.ts — ce qu'un appel a fait à chaque fichier qu'il visait (#779).
//
// Le seam d'exécution prend déjà l'empreinte de chaque cible FICHIER avant
// l'outil (`snapshotFileTargets`, issue #60) et la reprend après pour décider
// ce qui a changé. Elle mourait avec l'appel. Ce module la RANGE, appel par
// appel, dans `tool_call_writes` : chemin réel, état et empreinte avant, état
// et empreinte après, liés à la ligne `tool_calls` de l'appel.
//
// La règle est la même pour tout outil qui déclare une cible fichier
// (`resolveMutationTargets`) : `file_write`, `file_edit`, les outils Office qui
// écrivent, la voix générée… Aucun outil n'est traité à part (règle #11). Une
// cible DOSSIER (un shell, un harnais de code) ne laisse aucune ligne : rien
// n'y est lu fichier par fichier (voir `observed.ts`).
//
// La ligne s'écrit pour tout appel qui a TOURNÉ, quelle que soit son issue :
// un appel raté qui a laissé le fichier à moitié écrit, ou intact, le dit par
// ses deux empreintes. Un appel qui n'a pas tourné (refusé à la porte, en
// attente d'approbation) n'a rien fait à aucun fichier, et n'a pas de ligne.
//
// Ce n'est PAS une garde : une insertion qui échoue ne bloque jamais l'outil,
// dont l'effet a déjà eu lieu. Elle est journalisée par un code
// (`TOOL_CALL_WRITES_UNRECORDED`), et l'absence de ligne se lit « non
// enregistré », jamais comme la preuve que rien n'a été écrit (invariant #4).

import type { AnyDrizzleDb } from '@nodal-agents/db';
import { toolCallWrites } from '@nodal-agents/db';
import type { MutationTarget } from '../types';
import { fingerprint, type FileFingerprint, type FileSnapshot } from './observed';
import { cheminConstate } from './record-constat';

const ABSENT: FileFingerprint = { kind: 'absent' };

const sha = (f: FileFingerprint): string | null => (f.kind === 'file' ? f.sha256 : null);

/**
 * Range, pour l'appel `toolCallId`, une ligne par cible FICHIER : l'état pris
 * avant l'outil (`before`) et celui relu maintenant. Rend le nombre de lignes
 * rangées. Ne lève jamais : un échec est journalisé et rend 0.
 *
 * Sans ligne d'appel (`toolCallId` absent : un appel hors job, dont la
 * plateforme ne pose pas de marque) ni job, il n'y a rien à quoi rattacher
 * la ligne : rien n'est rangé, et ce n'est pas anormal.
 */
export async function recordToolCallWrites(input: {
  readonly db: AnyDrizzleDb;
  readonly toolCallId: string | null | undefined;
  readonly jobId: string | null | undefined;
  readonly toolName: string;
  readonly targets: readonly MutationTarget[];
  readonly before: FileSnapshot;
}): Promise<number> {
  const { db, toolCallId, jobId } = input;
  if (!toolCallId || !jobId) return 0;
  try {
    const vus = new Set<string>();
    const values = [];
    for (const t of input.targets) {
      if (t.kind !== 'file') continue;
      // Deux cibles qui se résolvent au même chemin réel (un lien symbolique
      // et sa cible) sont un seul fichier : la première gagne.
      const path = await cheminConstate(t.path);
      if (vus.has(path)) continue;
      vus.add(path);
      const was = input.before.get(t.path) ?? ABSENT;
      const now = await fingerprint(t.path);
      values.push({
        toolCallId,
        jobId,
        path,
        beforeKind: was.kind,
        beforeSha256: sha(was),
        afterKind: now.kind,
        afterSha256: sha(now),
      });
    }
    if (values.length === 0) return 0;
    await db.insert(toolCallWrites).values(values);
    return values.length;
  } catch (err) {
    console.warn(
      `[verification] TOOL_CALL_WRITES_UNRECORDED tool=${input.toolName} job=${jobId} call=${toolCallId}`,
      err,
    );
    return 0;
  }
}
