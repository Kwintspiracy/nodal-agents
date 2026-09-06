// bootstrap/backfill-registered-projects.ts — le registre des projets se
// remplit tout seul, y compris pour l'activité d'AVANT (P5b, plan « De la
// maquette au produit »).
//
// LA DÉCISION (Quentin, 06/09) : un dossier où une production de code a
// atterri et qui porte un manifeste EST un projet. Au fil de l'eau, c'est le
// rattachement (packages/tools/src/projects/attach.ts) qui le déclare ; mais
// les projets de l'onglet Code existaient avant lui, dérivés de l'activité
// passée, et ils ont leur place dans Spaces sans un clic. Ce backfill les
// déclare une fois, au démarrage du runner, par LA règle de l'onglet Code
// (`scanProjects`, job/code-projects.ts) — jamais par une seconde règle — et
// RATTACHE les jobs qui y ont écrit (`agent_jobs.project_id`, « le premier
// gagne », comme au fil de l'eau) : sans ça, la page d'un projet déclaré ici
// n'aurait aucune conversation à montrer alors que l'activité existe.
//
// IDEMPOTENT : une ligne déjà déclarée n'est pas retouchée
// (`registerCodeProjects` ne met à jour que `registered_at IS NULL`), un job
// déjà rattaché non plus, une seconde passe déclare zéro ligne. Tourne à
// chaque boot, en tâche de fond jamais attendue (même contrat que le backfill
// des embeddings, M-17) : un disque lent ne retarde pas /api/health.
//
// CE QUI EST SAUTÉ, et dit par les compteurs : un dossier de projet disparu
// (`missing`), un dossier sans manifeste (`noMarker` — il attend la question
// « où écrire ? », P10), un projet sous un dossier attaché que le propriétaire
// a MASQUÉ (`hidden`, `hidden_from_code` — même règle de sous-arbre que le
// contexte des agents), et un projet déjà déclaré (`alreadyRegistered`). Une
// ligne `code_projects.hidden = true`, elle, se déclare en restant masquée :
// ranger un projet n'est pas le désinscrire.
//
// `registered_at` = l'instant de CETTE déclaration, pas la dernière activité
// (revue Codex, passe 32) : Spaces l'affiche comme la date d'ajout, et un
// projet déclaré au boot a été ajouté au boot. L'activité, elle, vit sur les
// jobs rattachés. `agent_id` = le détenteur quand il n'y en a qu'un ; à
// plusieurs, NULL — l'ordre des lignes `agent_workspaces` n'en désigne aucun.
//
// Le cache 60 s de `scanProjects` est partagé avec le contexte des agents,
// sans conséquence : le scan ne dépend pas de l'état du registre (il lit
// `tool_calls` et le disque), donc ce que ce backfill déclare ne change pas
// ce qu'un scan mémoïsé aurait rendu, et inversement.
//
// INVARIANT #2 : ce module journalise un CODE et des compteurs, jamais une
// phrase.

import { existsSync } from 'node:fs';
import { agentJobs, entities, and, eq, inArray, isNull } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { isWithinRoot, projectKey } from '@nodal-agents/shared';
import { registerCodeProjects } from '@nodal-agents/tools';
import { hasMarker, listHiddenWorkspaceRoots, scanProjects } from '../job/code-projects.ts';

export interface RegistryBackfillReport {
  /** Lignes déclarées par CETTE passe. */
  registered: number;
  /** Jobs rattachés par cette passe (`project_id` posé là où il était NULL). */
  jobsAttached: number;
  /** Projets dérivés examinés et non déclarés, par raison. */
  skipped: {
    missing: number;
    noMarker: number;
    hidden: number;
    alreadyRegistered: number;
  };
}

export async function backfillRegisteredProjects(
  db: AnyDrizzleDb,
): Promise<RegistryBackfillReport> {
  const report: RegistryBackfillReport = {
    registered: 0,
    jobsAttached: 0,
    skipped: { missing: 0, noMarker: 0, hidden: 0, alreadyRegistered: 0 },
  };
  const entityRows = await db.select({ id: entities.id }).from(entities);

  for (const { id: entityId } of entityRows) {
    const raw = await scanProjects(db, entityId);
    if (raw.length === 0) continue;
    const hiddenRoots = await listHiddenWorkspaceRoots(db, entityId);

    for (const project of raw) {
      if (hiddenRoots.some((r) => isWithinRoot(project.path, r))) {
        report.skipped.hidden += 1;
        continue;
      }
      if (!existsSync(project.path)) {
        report.skipped.missing += 1;
        continue;
      }
      if (!hasMarker(project.path)) {
        report.skipped.noMarker += 1;
        continue;
      }
      const declared = await registerCodeProjects(db, {
        entityId,
        agentId: project.ownerIds.length === 1 ? (project.ownerIds[0] ?? null) : null,
        registeredJobId: null,
        registeredAt: new Date(),
        roots: [{ key: projectKey(project.path), path: project.path }],
      });
      const row = declared[0];
      if (!row) {
        report.skipped.alreadyRegistered += 1;
        continue;
      }
      report.registered += 1;

      // L'historique : les jobs qui ont écrit dans ce projet et n'en portent
      // encore aucun. `project_id IS NULL` dans le WHERE = « le premier
      // gagne », la règle du fil de l'eau ; un job qui a écrit dans deux projets
      // garde celui que le scan a rendu en premier (le plus actif).
      if (project.jobIds.length > 0) {
        const attached = await db
          .update(agentJobs)
          .set({ projectId: row.id })
          .where(
            and(
              inArray(agentJobs.id, project.jobIds),
              eq(agentJobs.entityId, entityId),
              isNull(agentJobs.projectId),
            ),
          )
          .returning({ id: agentJobs.id });
        report.jobsAttached += attached.length;
      }
    }
  }

  const s = report.skipped;
  console.warn(
    `[projects] REGISTRY_BACKFILL registered=${report.registered} jobs_attached=${report.jobsAttached} ` +
      `skipped_missing=${s.missing} skipped_no_marker=${s.noMarker} skipped_hidden=${s.hidden} ` +
      `skipped_already_registered=${s.alreadyRegistered}`,
  );
  return report;
}
