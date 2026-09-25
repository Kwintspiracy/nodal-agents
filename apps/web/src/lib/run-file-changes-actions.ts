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
import { requireAuth } from '@nodal-agents/auth';
import { headers } from 'next/headers';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';
import { entityWorkspaceRoots } from './workspace-roots.ts';
import { loadRunAuditRows } from './run-audit-rows.ts';
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
    // ne dit rien de l'appartenance de CE travail (`loadRunAuditRows`).
    const db = getDb();
    const audit = await loadRunAuditRows(db, session.entityId, parsed.data.jobId);
    if (audit === null) return fail('not_found', 'Job not found');
    const workspaceRoots = await entityWorkspaceRoots(db, session.entityId);
    return ok(fileChangesOfAuditRows(audit, workspaceRoots));
  } catch (err) {
    console.error('[getRunFileChangesAction]', err);
    return fail('db_error', 'Failed to read the file changes');
  }
}
