'use server';

// file-diff-actions.ts — ce qui a changé dans un fichier, pour le fil (P11,
// plan « De la maquette au produit »).
//
// Le calcul n'est PAS ici. Il sort d'un `git` lancé sur le magasin fantôme, sur
// la machine de l'hôte : c'est le travail du runner, pas du web. Ce module fait
// ce que `resolveApprovalAction` fait déjà — il authentifie, vérifie que le
// travail appartient bien à l'entité de l'appelant, puis relaie au runner avec
// `WORKER_SECRET`. Aucune dépendance nouvelle, aucun accès au magasin depuis le
// web.
//
// Le seul diff calculé côté web est celui d'un FRAGMENT (`file_edit`), et il
// l'est par un module PUR de `@nodal-agents/shared` : deux chaînes qui sont
// déjà sur la ligne d'audit n'ont besoin ni de git ni du disque.

import 'server-only';
import { z } from 'zod';
import { eq, and, agentJobs } from '@nodal-agents/db';
import { requireAuth } from '@nodal-agents/auth';
import { headers } from 'next/headers';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';
import { env } from './env.ts';

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

/**
 * Ce que le runner rend. Des CODES, jamais de prose : c'est l'écran qui écrit
 * la phrase que lit un humain (invariant #2).
 */
export type FileDiffView =
  | { kind: 'diff'; text: string; truncated: boolean; path: string; from: string; to: string }
  | { kind: 'fragment'; oldString: string; newString: string; path: string }
  | { kind: 'unchanged'; path: string }
  | { kind: 'binary'; path: string }
  | {
      kind: 'unavailable';
      reason: 'no_checkpoint' | 'path_unresolved' | 'workspace_unreachable' | 'not_in_snapshot';
    };

const InputSchema = z.object({
  jobId: z.string().guid(),
  toolCallId: z.string().min(1),
  /** Le fichier voulu quand la carte en liste plusieurs. Le runner le vérifie contre la carte. */
  path: z.string().min(1).optional(),
});

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

export async function getFileDiffAction(raw: unknown): Promise<ActionResult<FileDiffView>> {
  try {
    const session = await getSession();
    const parsed = InputSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    if (!session.entityId) return fail('no_entity', 'No active entity');

    // Garde IDOR, comme pour une approbation : `getSession` authentifie, il ne
    // dit rien sur l'appartenance de CE travail. Le cadrage se fait ici, et
    // « pas trouvé » couvre les deux cas — inexistant et appartenant à
    // quelqu'un d'autre — pour ne pas révéler l'existence d'un travail voisin.
    const db = getDb();
    const [job] = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(and(eq(agentJobs.id, parsed.data.jobId), eq(agentJobs.entityId, session.entityId)))
      .limit(1);
    if (!job) return fail('not_found', 'Job not found');

    if (!env.WORKER_SECRET) {
      console.error('[getFileDiffAction] WORKER_SECRET missing');
      return fail('config_error', 'WORKER_SECRET is not set');
    }

    const query = new URLSearchParams({ toolCallId: parsed.data.toolCallId });
    if (parsed.data.path !== undefined) query.set('path', parsed.data.path);
    const url = `${env.RUNNER_URL}/api/jobs/${parsed.data.jobId}/file-diff?${query.toString()}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${env.WORKER_SECRET}` },
      });
    } catch (err) {
      console.error('[getFileDiffAction] fetch failed', err);
      return fail('runner_unreachable', 'Runner did not respond');
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const code = body.error ?? `runner_${res.status}`;
      return fail(code, `Runner rejected: ${code}`);
    }

    return ok((await res.json()) as FileDiffView);
  } catch (err) {
    console.error('[getFileDiffAction]', err);
    return fail('db_error', 'Failed to read the diff');
  }
}
