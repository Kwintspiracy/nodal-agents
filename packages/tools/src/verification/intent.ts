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

import { existsSync, realpathSync } from 'node:fs';
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
import {
  PROJECT_MARKERS,
  isTerminalJobStatus,
  normalizePath,
  projectKey,
  resolveProjectRoots,
  type MutationTarget,
  type ProjectRoot,
  type VerificationSurfaceKey,
} from '@nodal-agents/shared';
import type { ToolContext } from '../types';

/**
 * Le type de livrable que PR① sait canonicaliser. Les autres valeurs de
 * `DELIVERABLE_TYPES` sont réservées sans canonicaliseur : un type sans
 * canonicaliseur est refusé, jamais accepté avec une clé inventée.
 */
const DELIVERABLE_TYPE_CODE_PROJECT = 'code_project';

/** L'état lisible que pose une intention. */
const DECISION_STATUS_DIRTY = 'dirty';

/**
 * Plafond de projets tirés d'un dossier attaché sans manifeste — même valeur
 * que le bloc `## Runtime` du runner (MAX_PROJECTS). Un dossier attaché n'est
 * pas un annuaire : au-delà, on dit qu'on a coupé plutôt que de faire tourner
 * une preuve sur quarante dossiers.
 */
export const MAX_PROJECTS = 12;

/** Un projet réellement sali par cet appel. */
export interface DirtiedProject {
  readonly key: string;
  readonly path: string;
  /** La génération sale posée par CET appel (1 au premier passage). */
  readonly dirtyGeneration: number;
  /** L'epoch de configuration après incrément. */
  readonly verificationEpoch: number;
}

/**
 * Ce que l'intention a fait. Type FERMÉ : le seam décide sur `kind`, jamais
 * sur un booléen qui confondrait « rien à salir » et « la base est tombée ».
 */
export type MutationIntentOutcome =
  | {
      readonly kind: 'written';
      readonly surface: VerificationSurfaceKey;
      readonly projects: readonly DirtiedProject[];
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
 * Le chemin RÉEL d'un dossier ou d'un fichier, normalisé — pour COMPARER,
 * jamais pour nommer (voir `rebaseOntoLexicalRoots`).
 */
function realPathOf(p: string): string {
  try {
    return normalizePath(realpathSync.native(p));
  } catch {
    return normalizePath(p);
  }
}

/**
 * Ramène chaque cible sous la racine attachée TELLE QUE L'OWNER L'A ÉCRITE.
 *
 * Les cibles arrivent des outils par `resolveAndCheckPath`, qui passe par
 * `realpath` ; les racines attachées arrivent lexicales. Sur un runner GitHub
 * Windows, `os.tmpdir()` rend la forme courte 8.3 (`C:\Users\RUNNER~1\…`)
 * alors que `realpath` rend la longue — une jonction ou un lien symbolique
 * font pareil partout. Comparées telles quelles, la cible n'était « dans »
 * aucune racine : aucun projet, aucune intention, et l'écriture partait sans
 * être vue (CI rouge de la PR #46, verte en local).
 *
 * La comparaison se fait donc sur les chemins RÉELS, mais l'identité rendue
 * est la LEXICALE : l'onglet Code dérive ses projets des racines telles
 * qu'elles sont enregistrées (apps/web/src/lib/code-projects.ts) et ne résout
 * ni lien ni jonction. Nommer le projet par sa forme réelle créerait deux
 * lignes `code_projects` pour un même dossier — l'état sale d'un côté, les
 * commandes approuvées de l'autre (revue Codex PR #46, passe 2). Une cible
 * hors de toute racine reste telle quelle : le résolveur la rejettera.
 */
function rebaseOntoLexicalRoots(
  targets: readonly MutationTarget[],
  lexicalRoots: readonly string[],
): readonly MutationTarget[] {
  const roots = lexicalRoots.map((lexical) => ({ lexical, real: realPathOf(lexical) }));
  return targets.map((t) => {
    const lexical = normalizePath(t.path);
    const real = realPathOf(t.path);
    for (const root of roots) {
      // Déjà sous la racine lexicale : rien à faire.
      if (lexical === root.lexical || lexical.startsWith(`${root.lexical}/`)) return t;
      if (real === root.real) return { kind: t.kind, path: root.lexical };
      if (real.startsWith(`${root.real}/`)) {
        return { kind: t.kind, path: `${root.lexical}${real.slice(root.real.length)}` };
      }
    }
    return t;
  });
}

/** Le manifeste d'un dossier, lu sur le disque (injecté dans le résolveur pur). */
function hasMarker(dir: string): boolean {
  try {
    return PROJECT_MARKERS.some((m) => existsSync(`${dir}/${m}`));
  } catch {
    return false;
  }
}

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
      out.push({ kind: 'dir', path });
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
      out.push({ kind: 'dir', path: `${path}/${child}` });
    }
  }
  return out;
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
  let projects: readonly ProjectRoot[];
  try {
    const rebased = rebaseOntoLexicalRoots(targets, workspaceRoots);
    const expanded = await expandWorkspaceRoots(rebased, workspaceRoots);
    projects = resolveProjectRoots({ targets: expanded, workspaceRoots, hasMarker });
  } catch (err) {
    console.error(
      `[verification] VERIFICATION_INTENT_RESOLVE_FAILED surface=${surface} job=${jobId} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'failed', code: 'intent_resolve_failed' };
  }

  if (projects.length === 0) return { kind: 'no_targets', surface };

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

      const dirtied: DirtiedProject[] = [];
      // `projects` sort déjà trié par clé croissante : c'est L'ORDRE DE
      // VERROUILLAGE, pas une commodité d'affichage.
      for (const project of projects) {
        await tx
          .insert(codeProjects)
          .values({
            entityId: ctx.entityId,
            projectPath: project.path,
            projectKey: project.key,
            verificationEpoch: 0,
          })
          .onConflictDoNothing({ target: [codeProjects.entityId, codeProjects.projectKey] });

        const [locked] = await tx
          .select({ id: codeProjects.id })
          .from(codeProjects)
          .where(
            and(eq(codeProjects.entityId, ctx.entityId), eq(codeProjects.projectKey, project.key)),
          )
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

        const [state] = await tx
          .insert(jobDeliverableVerificationState)
          .values({
            jobId,
            deliverableType: DELIVERABLE_TYPE_CODE_PROJECT,
            canonicalKey: project.key,
            displayPathSnapshot: project.path,
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
              displayPathSnapshot: project.path,
              updatedAt: new Date(),
            },
          })
          .returning({ dirtyGeneration: jobDeliverableVerificationState.dirtyGeneration });
        if (!state?.dirtyGeneration) throw new IntentFailure('intent_state_write_failed');

        dirtied.push({
          key: project.key,
          path: project.path,
          dirtyGeneration: state.dirtyGeneration,
          verificationEpoch: bumped.verificationEpoch,
        });
      }

      return { kind: 'written', surface, projects: dirtied } as const;
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
