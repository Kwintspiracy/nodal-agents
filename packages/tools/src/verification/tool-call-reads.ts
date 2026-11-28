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
// L'insertion n'est PAS une garde : une insertion qui échoue ne bloque jamais l'outil.
// Elle est journalisée par un code (`TOOL_CALL_READS_UNRECORDED`), et l'absence
// de ligne se lit « non enregistré », jamais comme la preuve que rien n'a été
// lu (invariant #4).
//
// Ces lignes, avec celles de `tool_call_writes`, sont la MÉMOIRE de ce que le
// job a vu : `lastContentSeenByJob` les relit pour la garde du contenu vu des
// outils qui remplacent un fichier (`file-ops/text-file.ts`).

import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  and,
  desc,
  eq,
  isNotNull,
  or,
  toolCallReads,
  toolCallWrites,
  toolCalls,
} from '@nodal-agents/db';
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

/**
 * Le contenu de `absPath` tel que CE JOB l'a vu en dernier : l'empreinte que
 * porte le dernier appel du job qui l'a lu ou écrit, dans l'ordre d'écriture
 * des appels (`tool_calls.seq`). `null` : le job ne l'a jamais vu.
 *
 * Ce qu'un appel « a vu » se lit sur ses lignes, sans liste d'outils :
 *  - un appel qui a ÉCRIT ce fichier (une ligne `tool_call_writes`) l'a laissé
 *    dans l'état de ses octets écrits (`after_source = 'written'`) ; quand il
 *    n'a rien écrit (refusé, échoué) ou que son état d'après est une relecture
 *    du disque, il n'en a rien montré au modèle et ne compte pas — sa propre
 *    lecture interne non plus, ce qui empêche un appel refusé de « rafraîchir »
 *    la vue qu'il vient de déclarer périmée ;
 *  - un appel qui n'a fait que le LIRE (une ligne `tool_call_reads` seule) l'a
 *    vu tel que ses octets lus.
 *
 * C'est la mémoire qui garde un remplacement de ne s'appliquer qu'au contenu
 * que ce job a vu (`text-file.ts`, `assertSeenByJob`). Une ligne qui n'a pas
 * pu être rangée (`TOOL_CALL_READS_UNRECORDED`, journalisée) se lit comme un
 * fichier jamais vu : la règle d'écrasement d'avant s'applique, rien de plus.
 */
export async function lastContentSeenByJob(
  db: AnyDrizzleDb,
  jobId: string,
  absPath: string,
): Promise<string | null> {
  return (await lastViewByJob(db, jobId, absPath))?.sha256 ?? null;
}

/**
 * The last view this job had of `absPath` (see `lastContentSeenByJob`), and
 * whether the job read the file with a result the boundary masked
 * (`tool_calls.result_masked`, 0175) since its last successful write of it:
 * the model then saw the file with values hidden from it, and a later read of
 * another part of it does not show them either. A successful write sets the
 * view to what it wrote, and starts the count again. Read from the rows, so
 * it is the same after a suspension.
 */
export async function lastViewByJob(
  db: AnyDrizzleDb,
  jobId: string,
  absPath: string,
): Promise<{ sha256: string; masked: boolean } | null> {
  const path = await cheminConstate(absPath);
  const rows = await db
    .select({
      readSha: toolCallReads.sha256,
      resultMasked: toolCalls.resultMasked,
      writeId: toolCallWrites.id,
      writeSha: toolCallWrites.afterSha256,
      writeSource: toolCallWrites.afterSource,
    })
    .from(toolCalls)
    .leftJoin(
      toolCallReads,
      and(eq(toolCallReads.toolCallId, toolCalls.id), eq(toolCallReads.path, path)),
    )
    .leftJoin(
      toolCallWrites,
      and(eq(toolCallWrites.toolCallId, toolCalls.id), eq(toolCallWrites.path, path)),
    )
    .where(
      and(
        eq(toolCalls.jobId, jobId),
        or(isNotNull(toolCallReads.id), isNotNull(toolCallWrites.id)),
      ),
    )
    .orderBy(desc(toolCalls.seq));
  let last: string | null = null;
  let masked = false;
  for (const r of rows) {
    if (r.writeId !== null) {
      if (r.writeSource === 'written' && r.writeSha !== null) {
        return { sha256: last ?? r.writeSha, masked };
      }
      continue;
    }
    if (r.readSha !== null) {
      last ??= r.readSha;
      masked ||= r.resultMasked;
    }
  }
  return last === null ? null : { sha256: last, masked };
}
