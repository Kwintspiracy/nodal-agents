// run-audit-rows.ts — LES LIGNES D'AUDIT D'UN TRAVAIL ET DE SA DESCENDANCE.
//
// Sorti de `run-file-changes-actions.ts` (#490) : le dépli des plaques (#369)
// et la route qui sert un média livré lisent les MÊMES lignes, masquées de la
// même façon, pour que le rang d'un fichier y désigne le même fichier. Ce
// fichier n'est pas `'use server'` : un module d'actions ne peut exporter que
// des actions, et celui-ci sert aussi une route.

import 'server-only';
import { eq, and, inArray, agentJobs, toolCalls } from '@nodal-agents/db';
import type { getDb } from './server.ts';
import { collectDescendants } from './job-feed.ts';
import { redactAuditRow } from './redact-presented.ts';
import { parsePresented } from './tool-card-payload.ts';
import type { AuditRowForChanges } from './file-change-groups.ts';

/**
 * Les lignes d'audit du travail `jobId` et de TOUTE sa descendance, dans
 * l'ordre où les appels ont eu lieu — ou null si ce travail n'appartient pas à
 * l'entité. « Pas trouvé » couvre les deux cas (inexistant, ou appartenant à
 * quelqu'un d'autre) pour ne pas révéler l'existence d'un travail voisin.
 *
 * MASQUÉES À LA PORTE, comme le chargeur du fil (#150, Reviewer C du 18/09) :
 * les fragments sont DESSINÉS tels quels, et une clé écrite dans un fichier se
 * lirait en clair sur la plaque. Les chemins bruts partent à côté, pour la
 * seule identité des fichiers (#161).
 */
export async function loadRunAuditRows(
  db: ReturnType<typeof getDb>,
  entityId: string,
  jobId: string,
): Promise<AuditRowForChanges[] | null> {
  const [job] = await db
    .select({ id: agentJobs.id })
    .from(agentJobs)
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.entityId, entityId)))
    .limit(1);
  if (!job) return null;

  // La descendance ENTIÈRE, comme le fil : un petit-enfant qui écrit compte
  // dans l'encart de son tour, et sa plaque doit s'ouvrir comme les autres.
  const descendants = await collectDescendants(db, entityId, [jobId]);
  const jobIds = [jobId, ...descendants.map((d) => d.id)];

  const rows = await db
    .select({
      toolName: toolCalls.toolName,
      toolInput: toolCalls.toolInput,
      toolOutput: toolCalls.toolOutput,
      presented: toolCalls.presented,
    })
    .from(toolCalls)
    .where(and(eq(toolCalls.entityId, entityId), inArray(toolCalls.jobId, jobIds)))
    .orderBy(toolCalls.createdAt);

  return rows.map((row) => {
    const dite =
      row.presented !== null &&
      typeof row.presented === 'object' &&
      (row.presented as { card?: unknown }).card === 'files';
    const brut = dite ? parsePresented(row.presented) : null;
    return {
      ...redactAuditRow(row),
      rawFilePaths:
        brut !== null && brut.card === 'files' ? brut.files.map((f) => f.path) : undefined,
    };
  });
}
