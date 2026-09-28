// verification/declared-deliverables.ts — les fichiers que l'AGENT déclare
// livrer, dans `return_result.deliverables` (issue #509).
//
// LE DÉFAUT QUE CECI CORRIGE. La preuve ne connaissait que les fichiers écrits
// par un outil de fichiers : l'intention de mutation (`intent.ts`) pose une
// ligne d'état pour chaque cible qu'un `file_write` NOMME, et `run_command` ne
// nomme que des dossiers. Un fichier qu'une commande devait produire — un
// rendu, un build, un export — n'était vérifié par rien : le 25/09, Montage a
// rendu succès sur « Film livré, rendu terminé », la preuve était verte sur
// les cinq sources du projet Remotion, et la vidéo n'existait pas.
//
// LE MÉCANISME, ET POURQUOI C'EST LE MÊME. L'agent nomme ce qu'il livre ;
// chaque chemin devient une ligne de `job_deliverable_verification_state`,
// posée par le MÊME geste que l'intention (`markStateDirty`), et prouvée à la
// finalisation par la MÊME preuve que tout livrable. La seule différence est
// le drapeau `declared` : c'est lui qui fait d'une preuve rouge, survivante au
// tour de réparation, un échec du run plutôt qu'une observation.
//
// UN LIVRABLE DÉCLARÉ EST UN FICHIER, typé `document` quel que soit le
// dossier où il tombe. Le classement des fichiers ÉCRITS (`written-file-
// type.ts`) range un fichier sous un projet de code dans la ligne DU PROJET,
// dont la preuve lance ses commandes — ou rend « non configuré » — sans
// jamais ouvrir le fichier. Un `out/film.mp4` rendu DANS un projet Remotion
// (sa sortie par défaut) aurait alors laissé le trou de #509 ouvert un dossier
// plus bas. La question qu'un livrable déclaré pose est « ce fichier est-il
// là, et est-il ce qu'il prétend être ? » : c'est la preuve d'un document, et
// elle ne dépend pas de l'endroit. Le projet, lui, garde sa propre ligne et sa
// propre preuve, posées par les écritures — rien n'y change.
//
// PAS DE SURFACE (D8). Les cases de vérification de l'espace disent quels
// ÉCRIVAINS sont observés (outils de fichiers, shell, harnais, runtime CLI).
// Une déclaration n'écrit rien : c'est ce que le run PROMET de rendre, et une
// promesse n'appartient à aucune de ces surfaces.
//
// INVARIANT #2. Rien ici ne parle à personne : des codes et des données. Les
// raisons d'un chemin irrésolu sont celles du résolveur des outils de
// fichiers, que l'agent lit déjà quand un `file_write` le refuse.

import { agentJobs, and, eq, jobDeliverableVerificationState, notInArray } from '@nodal-agents/db';
import { isTerminalJobStatus, type MutationTarget } from '@nodal-agents/shared';
import type { ToolContext } from '../types';
import { WorkspaceError, resolveAndCheckPath } from '../builtin/file-ops/workspace';
import { markStateDirty } from './intent';
import { officeFileDeliverables } from './office-file-key';
import { descendantFilesUnreadableMessage, fileProducedByDescendant } from '../descendant-files';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

/** Le type sous lequel un livrable déclaré est rangé — voir l'en-tête. */
const DECLARED_DELIVERABLE_TYPE = 'document' as const;

/** Un chemin que l'agent a nommé et que le résolveur des outils de fichiers refuse. */
export interface UnresolvedDeclaration {
  /** Le chemin tel que l'agent l'a écrit. */
  readonly requested: string;
  /** Le code du refus (`WorkspaceError.code`), pour une ligne de plateforme. */
  readonly code: string;
  /** Ce que le résolveur a répondu — la même phrase qu'un `file_write` refusé, pour l'agent. */
  readonly reason: string;
}

/** Un livrable déclaré, posé sale. */
export interface DeclaredDeliverable {
  readonly requested: string;
  readonly key: string;
  readonly path: string;
  readonly dirtyGeneration: number;
}

/** Ce que la déclaration a fait. Type FERMÉ : l'appelant décide sur `kind`. */
export type DeclareDeliverablesOutcome =
  | { readonly kind: 'written'; readonly deliverables: readonly DeclaredDeliverable[] }
  /** Au moins un chemin ne se résout pas : RIEN n'est écrit, l'agent doit corriger. */
  | { readonly kind: 'unresolved'; readonly unresolved: readonly UnresolvedDeclaration[] }
  | { readonly kind: 'already_terminal' }
  /** La déclaration n'a pas pu être posée (base, job, espace). */
  | { readonly kind: 'failed'; readonly code: string };

export type DeclareDeliverablesContext = Pick<
  ToolContext,
  'db' | 'entityId' | 'workspaces' | 'jobId'
> &
  Partial<ToolContext>;

/**
 * Pose une ligne d'état SALE, `declared`, par fichier que l'agent déclare.
 *
 * TOUT OU RIEN. Un seul chemin irrésolu, et rien n'est écrit : la liste est
 * rendue à l'agent, qui la corrige. Écrire les autres laisserait un run dont la
 * moitié des promesses est vérifiée et l'autre ignorée.
 *
 * Ne LÈVE jamais : une panne devient `{ kind: 'failed' }`, que le runner
 * transforme en échec du run — une promesse qu'on n'a pas su enregistrer n'est
 * pas une promesse tenue (invariant #4).
 */
export async function declareDeliverables(
  ctx: DeclareDeliverablesContext,
  requested: readonly string[],
): Promise<DeclareDeliverablesOutcome> {
  const jobId = ctx.jobId;
  if (!ctx.entityId) {
    console.error(`[verification] DECLARED_DELIVERABLES_NO_ENTITY job=${jobId}`);
    return { kind: 'failed', code: 'declared_no_entity' };
  }
  if (!jobId) {
    console.error(`[verification] DECLARED_DELIVERABLES_NO_JOB`);
    return { kind: 'failed', code: 'declared_no_job' };
  }

  // Le résolveur des outils de fichiers, et aucun autre : un chemin se
  // déclare exactement comme il s'écrit — label de dossier, relatif au dossier
  // unique, ou absolu dans un dossier attaché. Deux résolveurs finiraient par
  // voir deux fichiers différents derrière le même chemin.
  const uniques = [...new Set(requested.map((p) => p.trim()).filter((p) => p !== ''))];
  const unresolved: UnresolvedDeclaration[] = [];
  const resolved: Array<{ requested: string; target: MutationTarget; root?: string }> = [];
  for (const path of uniques) {
    try {
      const abs = await resolveAndCheckPath(ctx as ToolContext, path);
      resolved.push({
        requested: path,
        target: { kind: 'file', path: abs, deliverableType: DECLARED_DELIVERABLE_TYPE },
      });
    } catch (err) {
      // Un fichier dont le contenu actuel est ce qu'un de MES délégués a produit
      // dans ce run est à moi de le déclarer (#588) : la racine livre l'image de ComfyArtist sans la
      // recopier. Par chemin absolu, et seulement celui-là : la même règle que
      // la garde d'envoi (descendant-files.ts), rien de plus large.
      const reel = isAbsolute(path) ? await realpath(path).catch(() => null) : null;
      const verdict = reel === null ? null : await fileProducedByDescendant(ctx, reel);
      if (verdict?.kind === 'unreadable') {
        // Dit comme tel, jamais comme « pas écrit par ton délégué » (revue de #589, P3).
        unresolved.push({
          requested: path,
          code: 'descendant_files_unreadable',
          reason: descendantFilesUnreadableMessage(verdict.error),
        });
        continue;
      }
      if (reel !== null && verdict?.kind === 'produced') {
        resolved.push({
          requested: path,
          target: { kind: 'file', path: reel, deliverableType: DECLARED_DELIVERABLE_TYPE },
          // Sa clé se calcule comme celle de tout document ; il n'est sous aucun
          // de MES dossiers, son propre dossier sert de racine.
          root: dirname(reel),
        });
        continue;
      }
      unresolved.push({
        requested: path,
        code: err instanceof WorkspaceError ? err.code : 'path_unresolvable',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // La clé d'un document, par la fonction que `file_write` emploie pour les
  // siens : un fichier écrit puis déclaré retombe sur LA MÊME ligne.
  const workspaceRoots = (ctx.workspaces ?? []).map((w) => w.path);
  const keyed: Array<{ requested: string; key: string; path: string }> = [];
  for (const r of resolved) {
    const [file] = officeFileDeliverables(
      [r.target],
      r.root === undefined ? workspaceRoots : [...workspaceRoots, r.root],
    );
    if (file === undefined) {
      // Résolu mais sous aucune racine : impossible après le résolveur, et dit
      // plutôt que rangé sous une clé inventée.
      unresolved.push({
        requested: r.requested,
        code: 'declared_outside_workspaces',
        reason: 'declared_outside_workspaces',
      });
      continue;
    }
    keyed.push({ requested: r.requested, key: file.key, path: file.path });
  }

  if (unresolved.length > 0) {
    console.warn(
      `[verification] DECLARED_DELIVERABLES_UNRESOLVED job=${jobId} ` +
        `paths=${unresolved.map((u) => u.requested).join(',')}`,
    );
    return { kind: 'unresolved', unresolved };
  }
  try {
    return await ctx.db.transaction(async (tx) => {
      // Le MÊME verrou que l'intention : un job terminal ne reçoit plus rien.
      const [job] = await tx
        .select({ status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, jobId))
        .for('update')
        .limit(1);
      if (!job) throw new Error('declared_job_not_found');
      if (job.status !== null && isTerminalJobStatus(job.status)) {
        return { kind: 'already_terminal' } as const;
      }
      // La liste REMPLACE la précédente (revue Codex de #509, passe 3) : un
      // agent qui déclare `draft.mp4`, le trouve invalide au tour de réparation
      // et rend `final.mp4` à la place ne livre plus le brouillon. Ce qui n'est
      // plus nommé cesse d'être DÉCLARÉ — sa ligne et sa preuve restent, et
      // retombent dans la règle commune des livrables non déclarés. Dans la
      // même transaction que les nouvelles déclarations : aucun état où la
      // liste serait à moitié remplacée.
      const gardees = keyed.map((k) => k.key);
      await tx
        .update(jobDeliverableVerificationState)
        .set({ declared: false })
        .where(
          and(
            eq(jobDeliverableVerificationState.jobId, jobId),
            eq(jobDeliverableVerificationState.deliverableType, DECLARED_DELIVERABLE_TYPE),
            eq(jobDeliverableVerificationState.declared, true),
            ...(gardees.length > 0
              ? [notInArray(jobDeliverableVerificationState.canonicalKey, gardees)]
              : []),
          ),
        );
      const deliverables: DeclaredDeliverable[] = [];
      for (const k of keyed) {
        const dirtyGeneration = await markStateDirty(tx, jobId, {
          deliverableType: DECLARED_DELIVERABLE_TYPE,
          key: k.key,
          path: k.path,
          // Nommé par l'agent : c'est un livrable que l'écran montre.
          addressed: true,
          declared: true,
        });
        deliverables.push({ requested: k.requested, key: k.key, path: k.path, dirtyGeneration });
      }
      return { kind: 'written', deliverables } as const;
    });
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err && typeof err.code === 'string'
        ? err.code
        : err instanceof Error && err.message.startsWith('declared_')
          ? err.message
          : 'declared_write_failed';
    console.error(
      `[verification] DECLARED_DELIVERABLES_FAILED job=${jobId} code=${code} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'failed', code };
  }
}
