// routes/file-diff.ts — GET /api/jobs/:jobId/file-diff?toolCallId=<id>[&path=<p>]
//
// P11, plan « De la maquette au produit » : la carte « 12 fichiers » du fil
// devient cliquable, et chaque fichier déplie ce qui a changé.
//
// POURQUOI CETTE ROUTE EXISTE, plutôt qu'une lecture directe depuis le web. Le
// diff sort d'un `git` lancé sur le magasin fantôme (~/.nodalai/checkpoints) :
// c'est du `child_process` sur la machine de l'hôte, exactement ce que le
// runner fait et que le web ne fait jamais. Le web appelle donc le runner comme
// il appelle déjà `/api/approve`, avec le même secret et la même garde.
//
// CE QU'ELLE NE RÉPOND JAMAIS : de la prose. Chaque cas se dit par un CODE
// (`no_checkpoint`, `path_unresolved`, `workspace_unreachable`,
// `not_in_snapshot`) et c'est l'écran qui l'écrit en anglais — invariant #2, et
// la seule façon d'ajouter une langue sans rouvrir le runner.

import type { Context } from 'hono';
import { z } from 'zod';
import { existsSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { agentJobs, agentWorkspaces, jobCheckpoints, toolCalls, and, eq } from '@nodal-agents/db';
import { checkpointsRoot, diffFile } from '@nodal-agents/checkpoints';
import { normalizePath, isWindowsPath } from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import { resolveScannedPath, scannedEditPath } from '../job/code-projects.ts';

/** Les raisons pour lesquelles il n'y a rien à montrer. Des codes, pas des phrases. */
export type FileDiffUnavailable =
  | 'no_checkpoint'
  | 'path_unresolved'
  | 'workspace_unreachable'
  | 'not_in_snapshot';

const QuerySchema = z.object({
  toolCallId: z.string().min(1),
  /**
   * Le fichier VOULU, quand la carte en liste plusieurs. Facultatif : sans lui,
   * le chemin vient de la ligne d'audit elle-même. Toujours vérifié contre la
   * carte persistée de CETTE ligne avant d'être employé — un chemin arbitraire
   * venu de l'appelant ferait de cette route une lecture de disque libre.
   */
  path: z.string().min(1).optional(),
});

/** Le même dossier, à la graphie près (Windows ignore casse et séparateur). */
function samePath(a: string, b: string): boolean {
  // `isWindowsPath` attend la forme slash : normaliser AVANT de tester, sinon
  // `C:\Dev` n'est pas reconnu comme un chemin Windows et la comparaison
  // redevient sensible à la casse.
  const x = normalizePath(a);
  const y = normalizePath(b);
  const win = isWindowsPath(x) || isWindowsPath(y);
  return win ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** `file` est-il dans `root` (ou EST-il `root`) ? */
function within(file: string, root: string): boolean {
  let f = normalizePath(file);
  let r = normalizePath(root);
  if (isWindowsPath(f) || isWindowsPath(r)) {
    f = f.toLowerCase();
    r = r.toLowerCase();
  }
  return f === r || f.startsWith(r + '/');
}

/** Les chemins que la carte persistée de cette ligne déclare — la seule liste autorisée. */
function declaredPaths(presented: unknown): string[] {
  if (typeof presented !== 'object' || presented === null) return [];
  const p = presented as { card?: unknown; files?: unknown };
  if (p.card !== 'files' || !Array.isArray(p.files)) return [];
  return p.files
    .map((f) => (typeof f === 'object' && f !== null ? (f as { path?: unknown }).path : null))
    .filter((x): x is string => typeof x === 'string' && x !== '');
}

export async function fileDiffRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const jobId = c.req.param('jobId') ?? '';
  if (!z.string().guid().safeParse(jobId).success) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const parsed = QuerySchema.safeParse({
    toolCallId: c.req.query('toolCallId'),
    path: c.req.query('path'),
  });
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const { toolCallId } = parsed.data;

  const db = deps.db;

  // Le travail, et à QUI il appartient. Même règle que `/api/approve` : un
  // appelant de confiance (le web, qui a déjà cadré l'entité depuis la session
  // de l'utilisateur) passe ; un porteur de jeton de session ne voit que la
  // sienne, et un travail d'ailleurs est introuvable — jamais « interdit », qui
  // révélerait son existence.
  const callerEntityId = c.get('callerTrusted') ? undefined : c.get('callerEntityId');
  const [job] = await db
    .select({ entityId: agentJobs.entityId, agentId: agentJobs.agentId })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId))
    .limit(1);
  if (!job) return c.json({ error: 'job_not_found' }, 404);
  if (callerEntityId !== undefined && job.entityId !== callerEntityId) {
    return c.json({ error: 'job_not_found' }, 404);
  }

  const [row] = await db
    .select({
      toolName: toolCalls.toolName,
      toolInput: toolCalls.toolInput,
      toolOutput: toolCalls.toolOutput,
      presented: toolCalls.presented,
      turn: toolCalls.turn,
    })
    .from(toolCalls)
    .where(and(eq(toolCalls.jobId, jobId), eq(toolCalls.toolCallId, toolCallId)))
    .limit(1);
  if (!row) return c.json({ error: 'tool_call_not_found' }, 404);

  // ── Le fragment : aucun git, la ligne porte déjà les deux versions ─────────
  //
  // `file_edit` écrit `old_string` et `new_string` dans son entrée. Comparer
  // ces deux chaînes est exact, immédiat, et vrai même si le fichier a changé
  // dix fois depuis. Passer par le magasin fantôme pour ça reviendrait à
  // demander à git de recalculer une différence qu'on tient déjà.
  if (row.toolName === 'file_edit') {
    const input = (row.toolInput ?? {}) as Record<string, unknown>;
    const oldString = typeof input['old_string'] === 'string' ? input['old_string'] : null;
    const newString = typeof input['new_string'] === 'string' ? input['new_string'] : null;
    const path = typeof input['path'] === 'string' ? input['path'] : null;
    if (oldString !== null && newString !== null && path !== null) {
      return c.json({ kind: 'fragment', oldString, newString, path }, 200);
    }
    return c.json({ kind: 'unavailable', reason: 'path_unresolved' }, 200);
  }

  const unavailable = (reason: FileDiffUnavailable): Response =>
    c.json({ kind: 'unavailable', reason }, 200);

  // ── Le chemin ──────────────────────────────────────────────────────────────
  const wanted = parsed.data.path;
  const fromRowPath = scannedEditPath(row);
  let scanned: string | null;
  if (wanted !== undefined) {
    // Le chemin demandé DOIT figurer sur la carte que l'outil a déclarée : sans
    // cette vérification, n'importe quel chemin de la machine deviendrait
    // lisible par cette route.
    scanned = declaredPaths(row.presented).some((p) => samePath(p, wanted))
      ? normalizePath(wanted)
      : null;
  } else {
    scanned = fromRowPath;
  }
  if (!scanned) return unavailable('path_unresolved');

  // Les instantanés de ce travail — ce sont EUX qui disent quels dossiers le
  // seam connaissait, y compris le dossier partagé, qui n'a pas de ligne dans
  // `agent_workspaces` (il est créé et injecté à l'exécution).
  const checkpoints = await db
    .select({
      turn: jobCheckpoints.turn,
      workspace: jobCheckpoints.workspace,
      sha: jobCheckpoints.sha,
    })
    .from(jobCheckpoints)
    .where(eq(jobCheckpoints.jobId, jobId));
  if (checkpoints.length === 0) return unavailable('no_checkpoint');

  const attached = job.agentId
    ? await db
        .select({ label: agentWorkspaces.label, path: agentWorkspaces.path })
        .from(agentWorkspaces)
        .where(eq(agentWorkspaces.agentId, job.agentId))
    : [];
  const roots = [...new Set(checkpoints.map((r) => r.workspace))];
  // La MÊME résolution que l'onglet Code et le registre des projets : un chemin
  // relatif du harnais se lit par label, puis par existence chez l'auteur.
  const abs = resolveScannedPath(scanned, attached, roots, existsSync);
  if (!abs) return unavailable('path_unresolved');

  // Le dossier LE PLUS PROCHE qui contient le fichier — le plus long préfixe.
  // Deux dossiers attachés peuvent s'emboîter ; le père rendrait un chemin
  // relatif qui n'est pas celui sous lequel l'instantané a été pris.
  const workspace = roots.filter((r) => within(abs, r)).sort((a, b) => b.length - a.length)[0];
  if (workspace === undefined) return unavailable('path_unresolved');

  if (row.turn === null) return unavailable('no_checkpoint');
  const mine = checkpoints.filter((r) => samePath(r.workspace, workspace));
  const from = mine.find((r) => r.turn === row.turn);
  if (!from) return unavailable('no_checkpoint');

  // La borne haute : l'instantané du tour SUIVANT de ce dossier. S'il n'y en a
  // pas, le travail en est encore là — on compare à l'arbre de travail, et la
  // réponse le DIT (`to`), pour que l'écran ne fasse pas passer l'état
  // d'aujourd'hui pour l'état de ce tour-là.
  const next = mine.filter((r) => r.turn > row.turn!).sort((a, b) => a.turn - b.turn)[0];
  const toSha = next?.sha ?? null;

  try {
    const st = statSync(workspace);
    if (!st.isDirectory()) return unavailable('workspace_unreachable');
  } catch {
    return unavailable('workspace_unreachable');
  }

  const relPath = normalizePath(relative(workspace, abs));
  if (relPath === '' || relPath.startsWith('../')) return unavailable('path_unresolved');

  let diff: Awaited<ReturnType<typeof diffFile>>;
  try {
    diff = await diffFile(checkpointsRoot(), workspace, from.sha, toSha, relPath);
  } catch (err) {
    console.error(
      `[file-diff] FILE_DIFF_FAILED job=${jobId} tool_call=${toolCallId} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    return unavailable('workspace_unreachable');
  }

  if (diff.kind === 'not_in_snapshot') return unavailable('not_in_snapshot');

  const to = toSha === null ? 'working_tree' : 'next_turn';
  if (diff.kind === 'diff') {
    return c.json(
      {
        kind: 'diff',
        text: diff.text,
        truncated: diff.truncated,
        path: relPath,
        from: from.sha,
        to,
      },
      200,
    );
  }
  return c.json({ kind: diff.kind, path: relPath, from: from.sha, to }, 200);
}
