// projects/attach.ts — « ce travail a produit quelque chose DANS ce projet »
// (plan « De la maquette au produit », P5).
//
// LE CONTRAT, et ce qu'il n'est PAS. C'est un REGISTRE, pas une garde. Il ne
// refuse jamais une écriture, il ne crée aucun projet, il ne déplace rien : il
// note, une fois, à quel projet enregistré un job s'est rattaché. L'intention
// de mutation (verification/intent.ts) est la garde ; elle tourne juste avant,
// sur les mêmes cibles, et elle a le droit de dire non. Confondre les deux
// ferait d'une ligne de comptabilité un droit d'écriture.
//
// POURQUOI IL NE LÈVE JAMAIS. Il est appelé depuis le seam d'exécution, hors
// du try/catch d'exécution : une exception ici tuerait la boucle du job pour
// une écriture qui, elle, a parfaitement le droit d'avoir lieu. Une panne
// devient donc `{ kind: 'failed' }` — mais elle est DITE, par un code, jamais
// avalée (invariant #4).
//
// LE PREMIER GAGNE. Un job qui touche deux projets enregistrés reste rattaché
// au premier : c'est l'`UPDATE … WHERE project_id IS NULL` qui fait la règle,
// en une instruction, sans lecture préalable — deux appels concurrents du même
// tour ne peuvent pas se départager autrement sans course.
//
// INVARIANT #2 : tout ce que ce module journalise est un CODE et des données,
// jamais une phrase.

import { realpathSync } from 'node:fs';
import {
  agentJobs,
  codeProjects,
  conversations,
  and,
  eq,
  isNull,
  isNotNull,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { isWithinRoot, normalizePath, type MutationTarget } from '@nodal-agents/shared';

/**
 * Ce que le rattachement a fait. Type FERMÉ, comme l'issue de l'intention :
 * l'appelant décide sur `kind`, jamais sur un booléen qui confondrait « rien à
 * rattacher » et « la base est tombée ».
 *
 * REFONDU par P6. Il y a désormais DEUX lignes à marquer — le job et la
 * conversation — et elles ne réussissent pas ensemble : un tour de chat CLI n'a
 * pas de job mais a une conversation, un cron a un job et pas de conversation.
 * Un `kind` par combinaison aurait fait six cas ; le kind dit ce qui a été
 * TROUVÉ (un projet, ou rien), et deux champs disent ce que chaque ligne en a
 * fait. `no_job` cesse donc d'être une issue : c'est l'un des états de `job`.
 */
export type AttachOutcome =
  /** Une cible tombe dans un projet enregistré — et voici ce que chaque ligne en a fait. */
  | {
      readonly kind: 'attached';
      readonly projectId: string;
      readonly projectPath: string;
      /**
       * `attached` : le job porte désormais ce projet. `already_attached` : il
       * portait déjà CELUI-CI. `kept_existing` : il en portait un AUTRE — le
       * premier gagne. `no_job` : il n'y avait pas de job (tour de chat).
       */
      readonly job: 'attached' | 'already_attached' | 'kept_existing' | 'no_job';
      /** `set` : la conversation pointe désormais ce projet. `no_conversation` : il n'y en avait pas. */
      readonly conversation: 'set' | 'no_conversation';
    }
  /** Aucune cible ne tombe dans un projet ENREGISTRÉ — et ce n'est pas une panne. */
  | { readonly kind: 'no_project' }
  /** Le rattachement n'a pas pu être noté. L'écriture, elle, continue. */
  | { readonly kind: 'failed'; readonly code: string };

export interface AttachContext {
  readonly db: AnyDrizzleDb;
  readonly entityId: string;
  /** `null` pour un tour de chat — il n'y a alors pas de ligne `agent_jobs` à marquer. */
  readonly jobId: string | null;
  /**
   * La conversation dont ce travail est un tour (P6). `null` hors conversation
   * (cron, webhook). Non nul ⇒ son `current_project_id` est posé sur le projet
   * trouvé, TOUJOURS écrasé : la dernière production décide.
   */
  readonly conversationId: string | null;
}

/** Un projet enregistré, réduit à ce que la règle d'appartenance demande. */
interface RegisteredProject {
  readonly id: string;
  /** Le chemin TEL QU'ENREGISTRÉ — celui qu'on rend, et que les écrans montrent. */
  readonly path: string;
  /** Le chemin sur lequel on COMPARE (lexical d'abord, réel en second passage). */
  readonly matchPath: string;
}

/**
 * Le chemin RÉEL d'un dossier, normalisé — pour COMPARER, jamais pour nommer.
 *
 * Même précaution que `rebaseOntoLexicalRoots` (verification/intent.ts), et
 * pour la même panne : les cibles arrivent des outils par `resolveAndCheckPath`,
 * qui passe par `realpath`, tandis qu'un projet est enregistré avec le chemin
 * que le propriétaire a écrit. Une jonction, un lien, ou le `C:\Users\RUNNER~1`
 * d'un runner Windows suffisent à ce que les deux ne se ressemblent plus — et
 * le travail ne se rattacherait à aucun projet, en silence.
 */
function realPathOf(p: string): string {
  try {
    return normalizePath(realpathSync.native(p));
  } catch {
    return normalizePath(p);
  }
}

/**
 * Le projet enregistré qui CONTIENT cette cible, ou `null`.
 *
 * La règle de frontière est celle de tout le dépôt (`isWithinRoot`,
 * @nodal-agents/shared) : racine égale ou frontière de segment, casse repliée
 * seulement sur un chemin Windows. Une cible FICHIER se compare telle quelle —
 * inutile de remonter au dossier, un fichier dans un projet est déjà dans ce
 * projet, et remonter ferait perdre le cas du fichier posé à la racine.
 *
 * Racines triées de la plus LONGUE à la plus courte : deux projets imbriqués
 * (`terrain/app` et `terrain/app/packages/ui`) sont l'un des cas normaux du
 * registre, et le travail appartient au plus niché.
 */
function projectContaining(
  target: MutationTarget,
  projects: readonly RegisteredProject[],
): RegisteredProject | null {
  const path = normalizePath(target.path);
  if (path === '') return null;
  return projects.find((p) => isWithinRoot(path, p.matchPath)) ?? null;
}

/** Les racines de la PLUS LONGUE à la plus courte — le plus niché gagne. */
function byDepth(projects: readonly RegisteredProject[]): RegisteredProject[] {
  return [...projects].sort((a, b) => b.matchPath.length - a.matchPath.length);
}

/** La première cible qui tombe dans un projet décide — l'ordre est celui de l'outil. */
function firstMatch(
  targets: readonly MutationTarget[],
  projects: readonly RegisteredProject[],
): RegisteredProject | null {
  for (const target of targets) {
    const found = projectContaining(target, projects);
    if (found) return found;
  }
  return null;
}

/**
 * Note à quel projet enregistré ce job s'est rattaché.
 *
 * Les projets MASQUÉS comptent : masquer est un choix d'affichage, pas une
 * désinscription — un projet qu'on ne veut plus voir dans une liste reste le
 * projet où le travail a eu lieu.
 */
export async function attachProductionToProject(
  ctx: AttachContext,
  targets: readonly MutationTarget[],
): Promise<AttachOutcome> {
  const { db, entityId, jobId, conversationId } = ctx;

  // Sans entité, il n'y a pas de projets à charger. Ce cas se refuse (le
  // runner construit `entityId: job.entityId ?? ''` en plusieurs points), il
  // ne se contourne pas par un scan de toute la table.
  if (!entityId) {
    console.error(`[projects] PROJECT_ATTACH_FAILED code=attach_no_entity job=${jobId ?? '-'}`);
    return { kind: 'failed', code: 'attach_no_entity' };
  }
  // Ni job ni conversation : il n'existe aucune ligne à marquer. P5 rendait
  // `no_job` ici ; depuis P6, l'absence de job n'est plus une issue à elle
  // seule — un tour de chat CLI n'a pas de job et pose quand même son projet.
  if (!jobId && !conversationId) return { kind: 'no_project' };
  if (targets.length === 0) return { kind: 'no_project' };

  try {
    const rows = await db
      .select({ id: codeProjects.id, path: codeProjects.projectPath })
      .from(codeProjects)
      .where(and(eq(codeProjects.entityId, entityId), isNotNull(codeProjects.registeredAt)));

    // `registered_at IS NULL` = comptabilité : une ligne née d'un renommage,
    // d'un masquage ou de l'intention de mutation n'est pas un projet, et un
    // travail ne se rattache pas à elle.
    const projects: RegisteredProject[] = rows
      .map((r) => {
        const path = normalizePath(r.path);
        return { id: r.id, path, matchPath: path };
      })
      .filter((p) => p.path !== '');
    if (projects.length === 0) return { kind: 'no_project' };

    let chosen = firstMatch(targets, byDepth(projects));
    // Aucun rattachement LEXICAL : on retente sur les chemins RÉELS avant de
    // conclure. Le disque n'est touché que dans ce second passage — sur une
    // machine sans lien ni jonction, il n'a jamais lieu.
    if (!chosen) {
      const reels = byDepth(
        projects.map((p) => ({ id: p.id, path: p.path, matchPath: realPathOf(p.path) })),
      );
      chosen = firstMatch(
        targets.map((t) => ({ ...t, path: realPathOf(t.path) })),
        reels,
      );
    }
    if (!chosen) return { kind: 'no_project' };

    const jobOutcome = jobId ? await markJob(db, jobId, chosen.id) : ('no_job' as const);
    if (typeof jobOutcome !== 'string') return jobOutcome;

    // Le PROJET COURANT de la conversation (P6). TOUJOURS écrasé : la dernière
    // production décide. C'est l'inverse de la règle du job (« le premier
    // gagne »), et c'est voulu — un job est un travail, il a produit là où il a
    // produit ; une conversation dure, et son dossier est celui où l'on
    // travaille MAINTENANT. `entity_id` dans le WHERE : un id de conversation
    // qui arriverait d'ailleurs ne doit pas déplacer le projet d'une entité
    // voisine.
    let conversationOutcome: 'set' | 'no_conversation' = 'no_conversation';
    if (conversationId) {
      await db
        .update(conversations)
        .set({ currentProjectId: chosen.id, updatedAt: new Date() })
        .where(and(eq(conversations.id, conversationId), eq(conversations.entityId, entityId)));
      conversationOutcome = 'set';
    }

    return {
      kind: 'attached',
      projectId: chosen.id,
      projectPath: chosen.path,
      job: jobOutcome,
      conversation: conversationOutcome,
    };
  } catch (err) {
    console.error(
      `[projects] PROJECT_ATTACH_FAILED code=attach_write_failed job=${jobId ?? '-'} ` +
        `conversation=${conversationId ?? '-'} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'failed', code: 'attach_write_failed' };
  }
}

/**
 * Marque le JOB, et dit ce qu'il en est advenu — ou rend l'issue d'échec, parce
 * qu'une panne sur cette ligne n'est pas rattrapable par la conversation.
 */
async function markJob(
  db: AnyDrizzleDb,
  jobId: string,
  projectId: string,
): Promise<'attached' | 'already_attached' | 'kept_existing' | { kind: 'failed'; code: string }> {
  // UNE instruction pour la règle « le premier gagne » : le `WHERE
  // project_id IS NULL` échoue à s'appliquer si un autre appel a déjà
  // rattaché ce job, sans qu'aucune lecture n'ait eu à le constater.
  const applied = await db
    .update(agentJobs)
    .set({ projectId })
    .where(and(eq(agentJobs.id, jobId), isNull(agentJobs.projectId)))
    .returning({ projectId: agentJobs.projectId });
  if (applied.length > 0) return 'attached';

  // Rien mis à jour : soit la ligne porte déjà un projet, soit elle n'existe
  // pas. Les deux se distinguent en la relisant, jamais en le supposant.
  const [job] = await db
    .select({ projectId: agentJobs.projectId })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId))
    .limit(1);
  if (!job) {
    console.error(`[projects] PROJECT_ATTACH_FAILED code=attach_job_not_found job=${jobId}`);
    return { kind: 'failed', code: 'attach_job_not_found' };
  }
  if (job.projectId === null) {
    // La ligne existe, elle est libre, et l'UPDATE n'a rien fait : le seul
    // scénario restant est une panne de cohérence qu'on ne masque pas.
    console.error(`[projects] PROJECT_ATTACH_FAILED code=attach_not_applied job=${jobId}`);
    return { kind: 'failed', code: 'attach_not_applied' };
  }
  if (job.projectId === projectId) return 'already_attached';
  // L'ignoré est NOMMÉ (invariant #4) : le type fermé porte le projet trouvé,
  // pas celui que le job garde — la trace, elle, dit les deux.
  console.error(
    `[projects] PROJECT_ATTACH_KEPT_EXISTING job=${jobId} kept=${job.projectId} ignored=${projectId}`,
  );
  return 'kept_existing';
}
