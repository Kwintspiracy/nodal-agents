// verification/intent.ts — l'INTENTION de mutation, écrite AVANT que quoi que
// ce soit change sur le disque (plan « Vérifier & Corriger », § « L'intention
// de mutation — AVANT d'écrire »).
//
// LE CONTRAT. Un projet est déclaré sale au moment où un outil s'apprête à
// l'écrire, pas au moment où il a fini. Un CLI qui écrit puis sort non-zéro,
// une sortie illisible, un runner qui tombe : le projet est déjà sale, et la
// finalisation le saura. Une tentative qui n'écrit finalement rien reste
// conservativement sale — c'est le sens voulu, jamais un bug à « optimiser ».
//
// POURQUOI ICI ET PAS DANS LE RUNNER. Les quatre outils qui écrivent vivent
// dans ce paquet et ne peuvent pas importer `apps/runner` ; le runner, lui,
// importe déjà `@nodal-agents/tools` (workspace-locks). Ce paquet a déjà
// `@nodal-agents/db` en dépendance et écrit déjà en base (execute.ts).
//
// PAS DE MÉMO PAR TOUR. Le checkpoint en a un (`checkpointedTurns`) parce
// qu'un instantané git coûte cher et qu'un tour est une unité de travail. Une
// intention est un UPDATE, et le plan exige le contraire : deux écritures dans
// le même tour font deux générations sales, sinon la seconde passerait pour
// prouvée par la preuve de la première.
//
// INVARIANT #2. Tout ce que ce module journalise est un CODE et des données —
// jamais une phrase. `scanForUserFacingStrings` tourne sur ce paquet.

import { readdir } from 'node:fs/promises';
import {
  agentJobs,
  codeProjects,
  jobDeliverableVerificationState,
  getVerificationSurfaces,
  and,
  eq,
  sql,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  isTerminalJobStatus,
  normalizePath,
  projectKey,
  resolveProjectRoots,
  type DeliverableType,
  type MutationTarget,
  type VerificationSurfaceKey,
} from '@nodal-agents/shared';
import type { ToolContext } from '../types';
// Les deux gestes de disque de la règle d'appartenance vivent dans UN module
// (projects/markers.ts) depuis P5b : le registre des projets en a besoin
// autant que l'intention, et deux copies auraient fini par voir deux projets
// différents pour la même écriture.
import { hasMarker, rebaseOntoLexicalRoots } from '../projects/markers';
// La clé d'un document se calcule dans UN module, partagé avec la carte de
// l'outil qui l'écrit (P12) : voir office-file-key.ts pour ce qui divergeait.
import { officeFileDeliverables } from './office-file-key';

/**
 * Le type de livrable que PR① sait canonicaliser. Les autres valeurs de
 * `DELIVERABLE_TYPES` sont réservées sans canonicaliseur : un type sans
 * canonicaliseur est refusé, jamais accepté avec une clé inventée.
 */
const DELIVERABLE_TYPE_CODE_PROJECT = 'code_project';

/**
 * Les types de livrable dont l'état de configuration vit dans `code_projects`,
 * donc ceux qui prennent un verrou sur cette table.
 *
 * Déclaré séparément du type lui-même : l'ordre de verrouillage se raisonne
 * sur la TABLE verrouillée, pas sur le nom du type. Un type ajouté ici entre
 * dans la même passe de verrous, triée par clé — il ne crée pas un second
 * ordre concurrent (revue Codex PR #46, passe 5).
 */
const TYPES_LOCKING_CODE_PROJECTS: ReadonlySet<DeliverableType> = new Set([
  DELIVERABLE_TYPE_CODE_PROJECT,
]);

/** L'état lisible que pose une intention. */
const DECISION_STATUS_DIRTY = 'dirty';

/**
 * Plafond de projets tirés d'un dossier attaché sans manifeste — même valeur
 * que le bloc `## Runtime` du runner (MAX_PROJECTS). Un dossier attaché n'est
 * pas un annuaire : au-delà, on dit qu'on a coupé plutôt que de faire tourner
 * une preuve sur quarante dossiers.
 */
export const MAX_PROJECTS = 12;

/** Un livrable réellement sali par cet appel. */
export interface DirtiedDeliverable {
  /** Ce que l'outil a déclaré produire — ce qui choisira le vérificateur. */
  readonly deliverableType: DeliverableType;
  readonly key: string;
  readonly path: string;
  /** La génération sale posée par CET appel (1 au premier passage). */
  readonly dirtyGeneration: number;
  /**
   * L'epoch de configuration après incrément, ou `null` pour un type qui n'a
   * pas de configuration à faire vieillir (v7-A : seuls les projets de code
   * en ont une, dans `code_projects`).
   */
  readonly verificationEpoch: number | null;
}

/**
 * Ce que l'intention a fait. Type FERMÉ : le seam décide sur `kind`, jamais
 * sur un booléen qui confondrait « rien à salir » et « la base est tombée ».
 */
export type MutationIntentOutcome =
  | {
      readonly kind: 'written';
      readonly surface: VerificationSurfaceKey;
      readonly deliverables: readonly DirtiedDeliverable[];
    }
  /** Aucune cible ne retombe sur un projet — rien à salir, et ce n'est pas une panne. */
  | { readonly kind: 'no_targets'; readonly surface: VerificationSurfaceKey }
  /** L'owner a décoché cette surface (D8) — la trace est posée sur le job. */
  | {
      readonly kind: 'skipped';
      /** `surface_disabled` : D8 ; `no_job_context` : un tour de chat, sans job (T17). */
      readonly reason: 'surface_disabled' | 'no_job_context';
      readonly surface: VerificationSurfaceKey;
    }
  /** Le job est déjà terminal : plus rien ne doit être écrit sur sa décision. */
  | { readonly kind: 'already_terminal'; readonly surface: VerificationSurfaceKey }
  /** L'intention n'a PAS pu être posée. Le seam refuse l'écriture. */
  | { readonly kind: 'failed'; readonly code: string };

export interface WriteMutationIntentArgs {
  readonly surface: VerificationSurfaceKey;
  readonly targets: readonly MutationTarget[];
}

/**
 * Ce que le helper lit du contexte — un `ToolContext` convient tel quel. Le
 * runtime CLI (run-job.ts / run-chat.ts, T17) n'a pas de ToolContext et
 * construit cet objet lui-même ; un tour de CHAT n'a pas de jobId (la colonne
 * d'état est NOT NULL FK agent_jobs) : `''` ou `null` ⇒ `skipped`
 * (`no_job_context`), dit par un code, jamais un `return` muet.
 */
export type MutationIntentContext = Pick<ToolContext, 'db' | 'entityId' | 'workspaces'> & {
  readonly jobId: string | null;
};

/**
 * « Tout un workspace » — le périmètre conservatif des surfaces shell.
 *
 * Une cible qui EST un dossier attaché ne peut pas passer telle quelle au
 * résolveur : il rendrait la racine, alors que les projets de cette racine
 * sont ses enfants directs. On l'étend donc ici, côté `tools`, où `node:fs`
 * est disponible — le résolveur, lui, reste pur.
 *
 * L'alternative (poser l'intention sur la RACINE) éviterait ce readdir mais
 * créerait une clé que l'onglet Code ne montre jamais : deux vérités sur
 * l'identité d'un projet, exactement ce que `projectKey` existe pour empêcher.
 */
async function expandWorkspaceRoots(
  targets: readonly MutationTarget[],
  workspaceRoots: readonly string[],
): Promise<readonly MutationTarget[]> {
  const rootKeys = new Set(workspaceRoots.map((r) => projectKey(normalizePath(r))));
  const out: MutationTarget[] = [];

  for (const target of targets) {
    const path = normalizePath(target.path);
    if (target.kind !== 'dir' || !rootKeys.has(projectKey(path))) {
      out.push(target);
      continue;
    }
    // Racine qui porte un manifeste : c'est ELLE le projet, pas ses enfants.
    if (hasMarker(path)) {
      out.push({ kind: 'dir', path, deliverableType: target.deliverableType });
      continue;
    }
    let children: string[];
    try {
      const entries = await readdir(path, { withFileTypes: true });
      children = entries
        .filter((e) => e.isDirectory())
        // Les dossiers cachés (`.git`, `.next`, `.venv`) ne sont jamais des
        // projets, et les laisser prendre des places sous le plafond ferait
        // TOMBER de vrais projets hors de la liste — un silence, pas une
        // approximation.
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    } catch {
      // Dossier injoignable : il n'y a rien à salir dedans, et une écriture y
      // échouerait de toute façon. Dit, jamais deviné.
      console.warn(`[verification] VERIFICATION_INTENT_ROOT_UNREADABLE root=${path}`);
      continue;
    }
    if (children.length > MAX_PROJECTS) {
      console.warn(
        `[verification] VERIFICATION_INTENT_PROJECT_CAP root=${path} ` +
          `found=${children.length} cap=${MAX_PROJECTS}`,
      );
    }
    for (const child of children.slice(0, MAX_PROJECTS)) {
      out.push({ kind: 'dir', path: `${path}/${child}`, deliverableType: target.deliverableType });
    }
  }
  return out;
}

/**
 * UN livrable résolu : ce qu'il est, sa clé d'identité, le chemin à afficher.
 */
interface ResolvedDeliverable {
  readonly deliverableType: DeliverableType;
  readonly key: string;
  readonly path: string;
}

/**
 * Range chaque cible dans SON type de livrable, et applique à chacun sa règle
 * de canonicalisation (v7-A).
 *
 * LE DÉFAUT QUE CECI CORRIGE. Le type était écrit en dur — tout ce qu'un agent
 * touchait devenait un `code_project`. Écrire un tableau de bord `.xlsx` dans
 * un dépôt marquait le DÉPÔT modifié : la finalisation relançait `pnpm test`
 * pour prouver un classeur, et le classeur lui-même n'était vérifié par rien.
 * Le type vient maintenant de l'outil, qui sait ce qu'il produit.
 *
 * Deux règles, une par type branché :
 *   - `code_project` : le PROJET qui contient la cible (`resolveProjectRoots`),
 *     après expansion des dossiers attachés sans manifeste ;
 *   - `office_file` : le FICHIER lui-même (`resolveFileDeliverables`). Aucune
 *     remontée au projet : un document a sa propre identité, ses propres
 *     vérifications, et ne salit pas le code qui l'héberge.
 *
 * Le `switch` est EXHAUSTIF sur `DeliverableType` : ajouter un type à la liste
 * partagée sans lui donner de règle ici est une erreur du compilateur, pas un
 * livrable rangé au hasard. Un type déclaré mais non branché est REFUSÉ —
 * l'intention échoue, l'écriture est refusée, et personne ne croit vérifié ce
 * que rien ne sait canonicaliser (invariant #4).
 */
async function resolveDeliverables(
  targets: readonly MutationTarget[],
  workspaceRoots: readonly string[],
): Promise<readonly ResolvedDeliverable[]> {
  const rebased = rebaseOntoLexicalRoots(targets, workspaceRoots);
  const byType = new Map<DeliverableType, MutationTarget[]>();
  for (const target of rebased) {
    const bucket = byType.get(target.deliverableType);
    if (bucket) bucket.push(target);
    else byType.set(target.deliverableType, [target]);
  }

  const out: ResolvedDeliverable[] = [];
  for (const [deliverableType, group] of byType) {
    switch (deliverableType) {
      case 'code_project': {
        const expanded = await expandWorkspaceRoots(group, workspaceRoots);
        for (const project of resolveProjectRoots({
          targets: expanded,
          workspaceRoots,
          hasMarker,
        })) {
          out.push({ deliverableType, key: project.key, path: project.path });
        }
        break;
      }
      case 'office_file': {
        // Un dossier n'est pas un document. Le cas n'existe pas aujourd'hui
        // (les outils Office ciblent tous un `path` de fichier) ; s'il
        // apparaissait, il serait DIT plutôt que rangé en silence.
        const dirs = group.filter((t) => t.kind !== 'file').length;
        if (dirs > 0) {
          console.warn(
            `[verification] VERIFICATION_INTENT_DIR_TARGET_IGNORED type=${deliverableType} count=${dirs}`,
          );
        }
        // `group` est déjà rebasé (ligne du haut) ; le rebasage est idempotent,
        // et passer par la fonction partagée garantit que la carte de l'outil
        // (P12) et cette ligne d'état portent LA MÊME clé.
        for (const file of officeFileDeliverables(group, workspaceRoots)) {
          out.push({ deliverableType, key: file.key, path: file.path });
        }
        break;
      }
      case 'document':
      case 'outbound_action':
      case 'other': {
        // Réservés par le plan, sans règle de canonicalisation branchée. Une
        // clé inventée ici donnerait un état de vérification qui ne désigne
        // rien — et un livrable qu'aucun écran ne retrouve.
        console.error(
          `[verification] VERIFICATION_INTENT_TYPE_UNSUPPORTED type=${deliverableType} ` +
            `count=${group.length}`,
        );
        throw new IntentFailure('intent_type_unsupported');
      }
      default: {
        // Exhaustivité prouvée par le compilateur : `never` ici casse le build
        // le jour où `DELIVERABLE_TYPES` gagne une valeur sans règle.
        const unreachable: never = deliverableType;
        throw new IntentFailure(`intent_type_unsupported:${String(unreachable)}`);
      }
    }
  }

  // Tri par (type, clé) croissants — un ordre STABLE, pour que deux appels
  // identiques rendent la même liste et que les tests portent sur un rang.
  //
  // Ce n'est PAS ce qui garantit l'ordre des verrous : celui-là est repris
  // par une passe dédiée dans la transaction, triée par clé sur les seuls
  // livrables qui verrouillent `code_projects`. Faire porter les deux rôles
  // à ce tri marchait par accident et cassait au premier type ajouté (revue
  // Codex PR #46, passe 5).
  return out.sort((a, b) =>
    a.deliverableType !== b.deliverableType
      ? a.deliverableType < b.deliverableType
        ? -1
        : 1
      : a.key < b.key
        ? -1
        : a.key > b.key
          ? 1
          : 0,
  );
}

/**
 * Append IDEMPOTENT de la surface décochée dans `agent_jobs.verification_skipped_surfaces`.
 *
 * Un seul UPDATE, jamais lire-puis-écrire : deux outils de la même surface
 * dans le même tour se marcheraient dessus et la trace perdrait une clé.
 */
async function traceSkippedSurface(
  db: MutationIntentContext['db'],
  jobId: string,
  surface: VerificationSurfaceKey,
): Promise<void> {
  const payload = JSON.stringify([surface]);
  await db
    .update(agentJobs)
    .set({
      verificationSkippedSurfaces: sql`CASE WHEN ${agentJobs.verificationSkippedSurfaces} @> ${payload}::jsonb
        THEN ${agentJobs.verificationSkippedSurfaces}
        ELSE ${agentJobs.verificationSkippedSurfaces} || ${payload}::jsonb END`,
    })
    .where(eq(agentJobs.id, jobId));
}

/**
 * Les livrables dont il faut verrouiller la ligne `code_projects`, DANS
 * L'ORDRE où les verrous doivent être pris : clé croissante, une seule fois
 * par clé.
 *
 * Fonction pure et exportée pour Être TESTABLE (revue Codex PR #46, passe 6 :
 * le test d'intégration restait vert sans la passe dédiée, faute d'un second
 * type verrouillant pour distinguer les deux ordres). Elle se teste ici avec
 * un ensemble de types arbitraire, ce que la base ne permet pas encore.
 *
 * La déduplication par clé n'est pas cosmétique : deux livrables de types
 * différents qui désigneraient la même ligne l'incrémenteraient DEUX FOIS,
 * donc feraient vieillir une configuration qui n'a changé qu'une fois.
 */
export function codeProjectLockOrder<T extends { deliverableType: DeliverableType; key: string }>(
  deliverables: readonly T[],
  lockingTypes: ReadonlySet<DeliverableType> = TYPES_LOCKING_CODE_PROJECTS,
): readonly T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const d of deliverables) {
    if (!lockingTypes.has(d.deliverableType) || seen.has(d.key)) continue;
    seen.add(d.key);
    out.push(d);
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Verrouille la ligne `code_projects` du projet, crée-la si elle manque, et
 * incrémente son `verification_epoch`. Rendu : l'epoch APRÈS incrément.
 *
 * La ligne est CRÉÉE si absente : la table est vide par défaut (elle n'existe
 * que si le propriétaire a renommé, masqué ou configuré), et sans cette
 * création la finalisation verrouillerait puis lirait des lignes inexistantes.
 *
 * Appelé DANS la transaction de l'appelant, et pour les projets de code
 * SEULEMENT : c'est la table des projets de code. Y insérer un fichier
 * bureautique le ferait apparaître comme un projet dans l'onglet Code.
 */
async function bumpProjectEpoch(
  tx: AnyDrizzleDb,
  entityId: string,
  deliverable: ResolvedDeliverable,
): Promise<number> {
  await tx
    .insert(codeProjects)
    .values({
      entityId,
      projectPath: deliverable.path,
      projectKey: deliverable.key,
      verificationEpoch: 0,
    })
    .onConflictDoNothing({ target: [codeProjects.entityId, codeProjects.projectKey] });

  const [locked] = await tx
    .select({ id: codeProjects.id })
    .from(codeProjects)
    .where(and(eq(codeProjects.entityId, entityId), eq(codeProjects.projectKey, deliverable.key)))
    .for('update')
    .limit(1);
  if (!locked) throw new IntentFailure('intent_project_row_missing');

  const [bumped] = await tx
    .update(codeProjects)
    .set({
      verificationEpoch: sql`${codeProjects.verificationEpoch} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(codeProjects.id, locked.id))
    .returning({ verificationEpoch: codeProjects.verificationEpoch });
  if (!bumped) throw new IntentFailure('intent_epoch_bump_failed');
  return bumped.verificationEpoch;
}

/**
 * Pose l'intention de mutation, en UNE transaction courte.
 *
 * Séquence imposée par le plan (§ « Le protocole transactionnel ») :
 *   1. `FOR UPDATE` sur la ligne `agent_jobs` du job — non terminal, sinon on
 *      ne touche à rien ;
 *   2. les lignes `code_projects` concernées, verrouillées PAR CLÉ CROISSANTE
 *      (l'ordre que `resolveProjectRoots` garantit déjà) ;
 *   3. `verification_epoch + 1` sur chacune ;
 *   4. `dirty_generation + 1` et `decision_status='dirty'` sur la ligne d'état
 *      `(job, 'code_project', clé)`.
 *
 * La ligne `code_projects` est CRÉÉE si elle manque : la table est vide par
 * défaut (elle n'existe que si le propriétaire a renommé, masqué ou
 * configuré), et sans cette création la finalisation verrouillerait puis
 * lirait des lignes inexistantes.
 *
 * Ne LÈVE jamais. Une panne devient `{ kind: 'failed' }`, que le seam
 * transforme en refus d'écriture : une exception ici s'échapperait
 * d'`executeTool` (le seam est hors du try/catch d'exécution) et tuerait la
 * boucle du job — un échec pire, et moins lisible, que le refus typé.
 */
export async function writeMutationIntent(
  ctx: MutationIntentContext,
  args: WriteMutationIntentArgs,
): Promise<MutationIntentOutcome> {
  const { surface, targets } = args;
  const jobId = ctx.jobId;

  // L'entité d'abord : sans elle il n'y a ni réglage à lire ni `code_projects`
  // à écrire (`entity_id` est un uuid NOT NULL — un `''` lèverait au milieu de
  // la transaction). Le runner construit `entityId: job.entityId ?? ''` en
  // cinq points ; ce cas se refuse, il ne se contourne pas.
  if (!ctx.entityId) {
    console.error(`[verification] VERIFICATION_INTENT_NO_ENTITY surface=${surface} job=${jobId}`);
    return { kind: 'failed', code: 'intent_no_entity' };
  }

  // Un tour de chat n'a pas de job : la ligne d'état a une FK NOT NULL vers
  // agent_jobs, il n'y a donc rien à poser — et ce n'est pas une panne. Le
  // silence est NOMMÉ (inv. #4) ; l'écran le dit dans sa branche chat (T24).
  if (!jobId) {
    console.warn(`[verification] VERIFICATION_NO_JOB_CONTEXT surface=${surface}`);
    return { kind: 'skipped', reason: 'no_job_context', surface };
  }

  let surfacesEnabled: boolean;
  try {
    const surfaces = await getVerificationSurfaces(ctx.db, ctx.entityId);
    surfacesEnabled = surfaces[surface];
  } catch (err) {
    // Aucun repli sur « tout activé » ni sur « rien à faire » : on ne SAIT pas
    // ce que l'owner a réglé, donc on ne prétend pas vérifier.
    console.error(
      `[verification] VERIFICATION_INTENT_SURFACES_UNREADABLE surface=${surface} ` +
        `entity=${ctx.entityId} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'failed', code: 'intent_surfaces_unreadable' };
  }

  if (!surfacesEnabled) {
    // D8 : décochée ⇒ AUCUNE intention, et le run le dit. Jamais un `return`
    // muet — le détail de run lira cette trace figée, pas le réglage courant.
    try {
      await traceSkippedSurface(ctx.db, jobId, surface);
    } catch (err) {
      console.error(
        `[verification] VERIFICATION_SURFACE_SKIP_TRACE_FAILED surface=${surface} ` +
          `job=${jobId} error=${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: 'failed', code: 'intent_skip_trace_failed' };
    }
    console.warn(`[verification] VERIFICATION_SURFACE_DISABLED surface=${surface} job=${jobId}`);
    return { kind: 'skipped', reason: 'surface_disabled', surface };
  }

  const workspaceRoots = (ctx.workspaces ?? []).map((w) => normalizePath(w.path));
  let deliverables: readonly ResolvedDeliverable[];
  try {
    deliverables = await resolveDeliverables(targets, workspaceRoots);
  } catch (err) {
    const code = err instanceof IntentFailure ? err.code : 'intent_resolve_failed';
    console.error(
      `[verification] VERIFICATION_INTENT_RESOLVE_FAILED surface=${surface} job=${jobId} ` +
        `code=${code} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'failed', code };
  }

  if (deliverables.length === 0) return { kind: 'no_targets', surface };

  try {
    return await ctx.db.transaction(async (tx) => {
      const [job] = await tx
        .select({ status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, jobId))
        .for('update')
        .limit(1);

      if (!job) {
        // Pas de ligne à verrouiller : l'état de vérification a une FK NOT NULL
        // vers ce job, il n'y a rien à écrire et rien à supposer.
        console.error(
          `[verification] VERIFICATION_INTENT_JOB_NOT_FOUND surface=${surface} job=${jobId}`,
        );
        throw new IntentFailure('intent_job_not_found');
      }

      // `status` est nullable en base : une ligne sans statut n'est pas
      // terminale (elle n'est même pas partie), et on ne le devine pas.
      if (job.status !== null && isTerminalJobStatus(job.status)) {
        console.warn(
          `[verification] VERIFICATION_INTENT_ALREADY_TERMINAL surface=${surface} ` +
            `job=${jobId} status=${job.status}`,
        );
        return { kind: 'already_terminal', surface } as const;
      }

      // PASSE 1 — LES VERROUS, avant toute autre écriture.
      //
      // L'ordre de verrouillage se décide sur l'identité PHYSIQUE du verrou
      // (la table, la clé), jamais sur le type LOGIQUE du livrable. Trier les
      // livrables par (type, clé) et compter dessus marchait par accident :
      // `code_project` est seul à verrouiller `code_projects`, et il tombe
      // premier en ordre alphabétique. Le jour où un second type verrouille
      // la même table, deux jobs prendraient les mêmes lignes dans deux ordres
      // et s'interbloqueraient (revue Codex PR #46, passe 5).
      //
      // Cette passe retire la question : TOUS les verrous `code_projects`
      // sont pris ici, par clé croissante, quel que soit le type qui les
      // demande. Ajouter un type à `TYPES_LOCKING_CODE_PROJECTS` suffit.
      const epochs = new Map<string, number>();
      for (const deliverable of codeProjectLockOrder(deliverables)) {
        epochs.set(deliverable.key, await bumpProjectEpoch(tx, ctx.entityId, deliverable));
      }

      // PASSE 2 — les états. Aucun verrou n'est pris ici.
      const dirtied: DirtiedDeliverable[] = [];
      for (const deliverable of deliverables) {
        // L'epoch de configuration vit dans `code_projects` — la table des
        // projets de code, et d'eux seuls. Un fichier bureautique n'a pas de
        // ligne là-dedans : lui en créer une le ferait apparaître comme un
        // projet dans l'onglet Code (v7-A). Son epoch est donc `null`, et la
        // finalisation sait déjà lire un epoch absent (`not_configured`).
        const verificationEpoch = TYPES_LOCKING_CODE_PROJECTS.has(deliverable.deliverableType)
          ? (epochs.get(deliverable.key) ?? null)
          : null;
        if (
          TYPES_LOCKING_CODE_PROJECTS.has(deliverable.deliverableType) &&
          verificationEpoch === null
        )
          throw new IntentFailure('intent_epoch_missing');

        const [state] = await tx
          .insert(jobDeliverableVerificationState)
          .values({
            jobId,
            deliverableType: deliverable.deliverableType,
            canonicalKey: deliverable.key,
            displayPathSnapshot: deliverable.path,
            dirtyGeneration: 1,
            decisionStatus: DECISION_STATUS_DIRTY,
          })
          .onConflictDoUpdate({
            target: [
              jobDeliverableVerificationState.jobId,
              jobDeliverableVerificationState.deliverableType,
              jobDeliverableVerificationState.canonicalKey,
            ],
            set: {
              dirtyGeneration: sql`${jobDeliverableVerificationState.dirtyGeneration} + 1`,
              decisionStatus: DECISION_STATUS_DIRTY,
              displayPathSnapshot: deliverable.path,
              updatedAt: new Date(),
            },
          })
          .returning({ dirtyGeneration: jobDeliverableVerificationState.dirtyGeneration });
        if (!state?.dirtyGeneration) throw new IntentFailure('intent_state_write_failed');

        dirtied.push({
          deliverableType: deliverable.deliverableType,
          key: deliverable.key,
          path: deliverable.path,
          dirtyGeneration: state.dirtyGeneration,
          verificationEpoch,
        });
      }

      return { kind: 'written', surface, deliverables: dirtied } as const;
    });
  } catch (err) {
    const code = err instanceof IntentFailure ? err.code : 'intent_write_failed';
    console.error(
      `[verification] VERIFICATION_INTENT_FAILED surface=${surface} job=${jobId} ` +
        `code=${code} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'failed', code };
  }
}

/**
 * Panne typée LEVÉE à l'intérieur de la transaction — la seule façon de la
 * faire ROULER EN ARRIÈRE tout en gardant un code exploitable dehors. Un
 * `return` d'échec committerait les projets déjà salis de la même liste.
 */
class IntentFailure extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'IntentFailure';
  }
}
