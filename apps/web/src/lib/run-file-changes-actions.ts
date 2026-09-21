'use server';

// run-file-changes-actions.ts — LES FRAGMENTS D'UN TRAVAIL, AU DÉPLI (#369).
//
// POURQUOI PARESSEUX. L'encart de livraison montre désormais, sous « Files »,
// une plaque de diff par fichier. Les fragments qui la peignent sont l'avant et
// l'après de CHAQUE écriture — `old_string`, `new_string`, `content` — et un
// run qui écrit cent fichiers en porte autant de fois le texte entier. Les
// embarquer dans le modèle du fil (`DeliverySummary`) aurait fait voyager tout
// ce texte jusqu'au navigateur à chaque rendu du fil, pour des plaques que
// personne n'ouvre : le fil porte donc les EN-TÊTES (le chemin, « +N −M »), et
// le premier dépli demande les fragments ici.
//
// C'est exactement ce que `spaces/FileDiff.tsx` fait déjà avec le runner depuis
// P11, à une différence près : là-bas le diff est calculé par un `git` sur le
// magasin fantôme, ici il n'y a rien à calculer — les fragments SONT sur les
// lignes d'audit. Aucun accès disque, aucune inférence de la « vraie » version
// du fichier : ce module relit les mêmes lignes que le fil, et rien d'autre.
//
// UN APPEL PAR TRAVAIL, pas un par fichier : les fragments de tous les fichiers
// d'un run arrivent ensemble, et ouvrir le deuxième fichier ne redemande rien.

import 'server-only';
import { z } from 'zod';
import { eq, and, inArray, agentJobs, toolCalls } from '@nodal-agents/db';
import { requireAuth } from '@nodal-agents/auth';
import { headers } from 'next/headers';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';
import { collectDescendants } from './job-feed.ts';
import { entityWorkspaceRoots } from './workspace-roots.ts';
import { redactAuditRow } from './redact-presented.ts';
import { parsePresented } from './tool-card-payload.ts';
import { fileChangesOfAuditRows, type FileChangeGroup } from './file-change-groups.ts';

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

const InputSchema = z.object({ jobId: z.string().guid() });

async function getSession() {
  const provider = getAuthProvider();
  let req: Request;
  try {
    const h = await headers();
    req = new Request('http://localhost/', { headers: h });
  } catch {
    req = new Request('http://localhost/');
  }
  const session = await requireAuth(req, provider);
  return applyActiveEntity(session, req);
}

/**
 * Les fichiers de ce travail et de TOUTE sa descendance, avec leurs fragments.
 *
 * La liste et les compteurs sont ceux de l'encart (`fileChangesOfAuditRows`,
 * le moteur que le fil appelle déjà pour ses en-têtes) : un fichier arrive donc
 * sous le MÊME chemin des deux côtés, et la plaque se pose sur la bonne ligne.
 */
export async function getRunFileChangesAction(
  raw: unknown,
): Promise<ActionResult<FileChangeGroup[]>> {
  try {
    const session = await getSession();
    const parsed = InputSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    if (!session.entityId) return fail('no_entity', 'No active entity');

    // Garde IDOR, la même que `getFileDiffAction` : la session authentifie, elle
    // ne dit rien de l'appartenance de CE travail. « Pas trouvé » couvre les
    // deux cas — inexistant, ou appartenant à quelqu'un d'autre — pour ne pas
    // révéler l'existence d'un travail voisin.
    const db = getDb();
    const [job] = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(and(eq(agentJobs.id, parsed.data.jobId), eq(agentJobs.entityId, session.entityId)))
      .limit(1);
    if (!job) return fail('not_found', 'Job not found');

    // La descendance ENTIÈRE, comme le fil : un petit-enfant qui écrit compte
    // dans l'encart de son tour, et sa plaque doit s'ouvrir comme les autres.
    const descendants = await collectDescendants(db, session.entityId, [parsed.data.jobId]);
    const jobIds = [parsed.data.jobId, ...descendants.map((d) => d.id)];

    const rows = await db
      .select({
        toolName: toolCalls.toolName,
        toolInput: toolCalls.toolInput,
        toolOutput: toolCalls.toolOutput,
        presented: toolCalls.presented,
      })
      .from(toolCalls)
      .where(and(eq(toolCalls.entityId, session.entityId), inArray(toolCalls.jobId, jobIds)))
      .orderBy(toolCalls.createdAt);

    const workspaceRoots = await entityWorkspaceRoots(db, session.entityId);
    // MASQUÉ À LA PORTE, comme le chargeur du fil (#150, Reviewer C du 18/09) :
    // ces fragments sont DESSINÉS tels quels, et une clé écrite dans un fichier
    // se lirait en clair sur la plaque. Les chemins bruts partent à côté, pour
    // la seule identité des fichiers (#161) — ils ne sortent pas d'ici.
    const audit = rows.map((row) => {
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

    return ok(fileChangesOfAuditRows(audit, workspaceRoots));
  } catch (err) {
    console.error('[getRunFileChangesAction]', err);
    return fail('db_error', 'Failed to read the file changes');
  }
}
