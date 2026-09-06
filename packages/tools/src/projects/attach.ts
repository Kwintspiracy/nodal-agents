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
import {
  isWithinRoot,
  normalizePath,
  resolveProjectRoots,
  type MutationTarget,
} from '@nodal-agents/shared';
import { hasMarker, realPathOf, rebaseOntoLexicalRoots } from './markers';
import { registerCodeProjects } from './register';

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
      /**
       * Le projet que le job PORTE après cet appel — le trouvé pour `attached`
       * et `already_attached`, celui qu'il GARDAIT pour `kept_existing`, `null`
       * pour `no_job`.
       *
       * Il existe parce que `projectId` seul était piégeux (revue Codex, passe
       * 28) : sur `kept_existing` il désigne le projet IGNORÉ, et un appelant
       * qui le lit comme « le rattachement effectif » obtient une information
       * fausse. Les deux identités sont donc exposées, jamais déduites.
       */
      readonly jobProjectId: string | null;
      /**
       * `set` : la conversation pointe désormais ce projet. `no_conversation` :
       * il n'y en avait pas. `not_found` : l'id ne désigne aucune ligne de cette
       * entité — un uuid orphelin d'avant P6, ou un id d'ailleurs. Distingué de
       * `set` parce que l'UPDATE ne touchait alors AUCUNE ligne tout en
       * annonçant le contraire.
       */
      readonly conversation: 'set' | 'no_conversation' | 'not_found';
      /**
       * Les projets que CET appel a DÉCLARÉS au registre (P5b) — les ids des
       * racines à manifeste où une cible de code vient d'atterrir et qui
       * n'étaient pas encore déclarées. Vide quand tout était déjà au registre,
       * ou que rien ne portait de manifeste.
       */
      readonly registered: readonly string[];
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
  /**
   * L'agent qui produit (P5b) — celui que le registre nomme responsable d'un
   * projet qu'il déclare : son terrain contient la cible par construction.
   * `null` quand l'appelant ne le connaît pas ; un projet déclaré sans agent
   * reste déclaré.
   */
  readonly agentId: string | null;
  /**
   * Les dossiers attachés à l'agent (P5b) — les racines sous lesquelles une
   * cible de code désigne un projet, par la MÊME règle que l'intention de
   * mutation (`resolveProjectRoots`). Vide ⇒ rien ne peut être déclaré, et
   * le rattachement ne cherche que parmi les projets déjà au registre.
   */
  readonly workspaces: ReadonlyArray<{ readonly path: string }>;
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
 * Le signal interne qui ANNULE la transaction du rattachement en portant son
 * code : levé à l'intérieur de `db.transaction`, rattrapé par le `catch` de
 * `attachProductionToProject`, jamais propagé à l'appelant.
 */
class AttachRollback extends Error {
  constructor(readonly code: string) {
    super(code);
  }
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
    // UNE transaction pour la déclaration ET le rattachement (revue Codex,
    // passe 32) : déclarer un projet puis échouer à marquer le job — ou ne
    // trouver ni job ni conversation à marquer — laissait une ligne
    // `registered_from = 'conversation'` sans conversation qui ait produit
    // quoi que ce soit. Deux racines déclarées par un même appel tombent ou
    // restent ensemble, pour la même raison.
    return await db.transaction(async (tx) => {
      // ── P5b : le registre se remplit tout seul ────────────────────────────
      //
      // AVANT de chercher un projet déclaré qui contient une cible : une racine
      // de code (même règle que l'intention, `resolveProjectRoots`) qui porte
      // un MANIFESTE est un projet, et cet appel le déclare si personne ne l'a
      // encore fait. La recherche ci-dessous le trouve alors comme n'importe
      // quel autre — le job s'y rattache, la conversation aussi.
      //
      // Une racine dérivée SANS manifeste (l'enfant de premier niveau d'un
      // terrain, `terrain/vrac`) n'est pas un projet : elle attend la question
      // « où écrire ? » (P10). C'est la ligne qui sépare « rien ne se crée en
      // silence » (les dossiers de documents) d'un dépôt qui se reconnaît seul.
      const registered = await registerManifestProjects({ ...ctx, db: tx }, targets);

      const rows = await tx
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
      // Rien de déclaré et rien à rattacher : sortir sans rien avoir écrit.
      // (Une déclaration sans rattachement possible n'existe pas : la racine
      // déclarée contient la cible par construction.)
      if (projects.length === 0) return { kind: 'no_project' as const };

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
      if (!chosen) {
        // Une racine vient d'être déclarée mais ne contient aucune cible : une
        // incohérence entre `resolveProjectRoots` et `isWithinRoot`, pas un cas.
        // Dite, et annulée avec la transaction.
        if (registered.length > 0) throw new AttachRollback('attach_registered_not_matched');
        return { kind: 'no_project' as const };
      }

      const marked = jobId
        ? await markJob(tx, jobId, chosen.id)
        : ({ job: 'no_job', jobProjectId: null } as const);
      // Le job n'a pas pu être marqué : la déclaration de ce tour part avec
      // lui (rollback) — la panne est déjà journalisée par `markJob`.
      if ('kind' in marked) throw new AttachRollback(marked.code);

      // Le PROJET COURANT de la conversation (P6). TOUJOURS écrasé : la dernière
      // production décide. C'est l'inverse de la règle du job (« le premier
      // gagne »), et c'est voulu — un job est un travail, il a produit là où il a
      // produit ; une conversation dure, et son dossier est celui où l'on
      // travaille MAINTENANT. `entity_id` dans le WHERE : un id de conversation
      // qui arriverait d'ailleurs ne doit pas déplacer le projet d'une entité
      // voisine.
      let conversationOutcome: 'set' | 'no_conversation' | 'not_found' = 'no_conversation';
      if (conversationId) {
        // `.returning()` : sans lui, une conversation absente ou d'une autre
        // entité ne changeait rien ET s'annonçait `set` (revue Codex, passe 28).
        // Le cas est réel — les uuid orphelins d'avant P6 que l'absence de clé
        // étrangère conserve délibérément.
        const touched = await tx
          .update(conversations)
          .set({ currentProjectId: chosen.id, updatedAt: new Date() })
          .where(and(eq(conversations.id, conversationId), eq(conversations.entityId, entityId)))
          .returning({ id: conversations.id });
        if (touched.length > 0) {
          conversationOutcome = 'set';
        } else {
          conversationOutcome = 'not_found';
          console.error(
            `[projects] PROJECT_ATTACH_CONVERSATION_NOT_FOUND conversation=${conversationId} ` +
              `entity=${entityId} project=${chosen.id}`,
          );
        }
      }

      // Sans job, la conversation était la seule ancre ; si elle n'existe pas,
      // personne n'a « produit » dans le projet que ce tour vient de déclarer
      // (revue Codex, passe 32). La déclaration part avec la transaction ; le
      // rattachement, lui, n'avait de toute façon rien marqué.
      if (registered.length > 0 && marked.job === 'no_job' && conversationOutcome === 'not_found') {
        throw new AttachRollback('attach_registered_without_anchor');
      }

      return {
        kind: 'attached' as const,
        projectId: chosen.id,
        projectPath: chosen.path,
        job: marked.job,
        jobProjectId: marked.jobProjectId,
        conversation: conversationOutcome,
        registered,
      };
    });
  } catch (err) {
    if (err instanceof AttachRollback) {
      console.error(
        `[projects] PROJECT_ATTACH_FAILED code=${err.code} job=${jobId ?? '-'} ` +
          `conversation=${conversationId ?? '-'}`,
      );
      return { kind: 'failed', code: err.code };
    }
    console.error(
      `[projects] PROJECT_ATTACH_FAILED code=attach_write_failed job=${jobId ?? '-'} ` +
        `conversation=${conversationId ?? '-'} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'failed', code: 'attach_write_failed' };
  }
}

/**
 * Déclare au registre les racines de code À MANIFESTE où une cible atterrit,
 * et rend les ids déclarés par cet appel (vide si rien de neuf).
 *
 * Les cibles de code passent par `rebaseOntoLexicalRoots` puis
 * `resolveProjectRoots`, EXACTEMENT comme dans l'intention de mutation : la
 * clé obtenue doit être celle que l'intention vient de poser en comptabilité,
 * sinon le registre créerait une seconde ligne `code_projects` pour le même
 * dossier — l'état sale d'un côté, la déclaration de l'autre.
 *
 * `hasMarker` sur la racine DÉRIVÉE, pas sur le dossier de la cible : un
 * fichier dans `app/src/` appartient au projet `app`, et c'est `app` qui doit
 * porter le manifeste.
 *
 * Les cibles FICHIER seulement (revue Codex, passe 32). Une cible `dir` est un
 * PÉRIMÈTRE conservatif — le terrain entier d'une commande shell, ou d'un tour
 * de harnais dont l'audit ne connaît aucune écriture : elle dit où quelque
 * chose a PU se passer, pas qu'une production a atterri. Déclarer un projet
 * sur cette base, c'est déclarer un dépôt parce qu'un agent a répondu « je
 * vais d'abord analyser » en mode écriture. Le rattachement, lui, garde les
 * dossiers : rattacher à un projet DÉJÀ déclaré est réversible et bon marché ;
 * une déclaration ne l'est pas.
 */
async function registerManifestProjects(
  ctx: AttachContext,
  targets: readonly MutationTarget[],
): Promise<readonly string[]> {
  const codeTargets = targets.filter(
    (t) => t.deliverableType === 'code_project' && t.kind === 'file',
  );
  if (codeTargets.length === 0) return [];
  const workspaceRoots = ctx.workspaces.map((w) => normalizePath(w.path)).filter((p) => p !== '');
  if (workspaceRoots.length === 0) return [];

  const roots = resolveProjectRoots({
    targets: rebaseOntoLexicalRoots(codeTargets, workspaceRoots),
    workspaceRoots,
    hasMarker,
  }).filter((root) => hasMarker(root.path));
  if (roots.length === 0) return [];

  const rows = await registerCodeProjects(ctx.db, {
    entityId: ctx.entityId,
    // P5b : seules les racines à MANIFESTE arrivent ici — c'est du code.
    kind: 'code' as const,
    agentId: ctx.agentId,
    registeredJobId: ctx.jobId,
    registeredAt: new Date(),
    roots,
  });
  return rows.map((r) => r.id);
}

/** Ce que la ligne `agent_jobs` porte après le passage de `markJob`. */
interface JobMark {
  readonly job: 'attached' | 'already_attached' | 'kept_existing';
  /** Le projet RÉELLEMENT porté par le job — pas forcément celui qu'on a trouvé. */
  readonly jobProjectId: string;
}

/**
 * Marque le JOB, et dit ce qu'il en est advenu — ou rend l'issue d'échec, parce
 * qu'une panne sur cette ligne n'est pas rattrapable par la conversation.
 */
async function markJob(
  db: AnyDrizzleDb,
  jobId: string,
  projectId: string,
): Promise<JobMark | { kind: 'failed'; code: string }> {
  // UNE instruction pour la règle « le premier gagne » : le `WHERE
  // project_id IS NULL` échoue à s'appliquer si un autre appel a déjà
  // rattaché ce job, sans qu'aucune lecture n'ait eu à le constater.
  const applied = await db
    .update(agentJobs)
    .set({ projectId })
    .where(and(eq(agentJobs.id, jobId), isNull(agentJobs.projectId)))
    .returning({ projectId: agentJobs.projectId });
  if (applied.length > 0) return { job: 'attached', jobProjectId: projectId };

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
  if (job.projectId === projectId) return { job: 'already_attached', jobProjectId: projectId };
  // Les DEUX identités sont rendues : `jobProjectId` est celui que le job garde,
  // `projectId` de l'issue reste celui qu'on a trouvé. La trace dit les deux
  // aussi — l'ignoré est nommé, jamais oublié (invariant #4).
  console.error(
    `[projects] PROJECT_ATTACH_KEPT_EXISTING job=${jobId} kept=${job.projectId} ignored=${projectId}`,
  );
  return { job: 'kept_existing', jobProjectId: job.projectId };
}
