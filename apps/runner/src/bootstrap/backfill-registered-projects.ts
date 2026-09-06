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
// (`scanProjects`, job/code-projects.ts) — jamais par une seconde règle.
//
// IDEMPOTENT : une ligne déjà déclarée n'est pas retouchée
// (`registerCodeProjects` ne met à jour que `registered_at IS NULL`), une
// seconde passe déclare zéro ligne. Tourne à chaque boot, en tâche de fond
// jamais attendue (même contrat que le backfill des embeddings, M-17) : un
// disque lent ne retarde pas /api/health.
//
// CE QUI EST SAUTÉ, et dit par les compteurs : un dossier de projet disparu,
// un dossier sans manifeste (il attend la question « où écrire ? », P10), un
// projet sous un dossier attaché que le propriétaire a MASQUÉ
// (`hidden_from_code` — même règle de sous-arbre que le contexte des agents),
// et un projet déjà déclaré. Une ligne `code_projects.hidden = true`, elle,
// se déclare en restant masquée : ranger un projet n'est pas le désinscrire.
//
// Le cache 60 s de `scanProjects` est partagé avec le contexte des agents,
// sans conséquence : le scan ne dépend pas de l'état du registre (il lit
// `tool_calls` et le disque), donc ce que ce backfill déclare ne change pas
// ce qu'un scan mémoïsé aurait rendu, et inversement.
//
// INVARIANT #2 : ce module journalise un CODE et des compteurs, jamais une
// phrase.

import { existsSync } from 'node:fs';
import { entities } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { isWithinRoot, projectKey } from '@nodal-agents/shared';
import { registerCodeProjects } from '@nodal-agents/tools';
import { hasMarker, listHiddenWorkspaceRoots, scanProjects } from '../job/code-projects.ts';

export interface RegistryBackfillReport {
  /** Lignes déclarées par CETTE passe. */
  registered: number;
  /** Projets dérivés examinés et non déclarés (disparu, sans manifeste, masqué, ou déjà déclaré). */
  skipped: number;
}

export async function backfillRegisteredProjects(
  db: AnyDrizzleDb,
): Promise<RegistryBackfillReport> {
  const report: RegistryBackfillReport = { registered: 0, skipped: 0 };
  const entityRows = await db.select({ id: entities.id }).from(entities);

  for (const { id: entityId } of entityRows) {
    const raw = await scanProjects(db, entityId);
    if (raw.length === 0) continue;
    const hiddenRoots = await listHiddenWorkspaceRoots(db, entityId);

    for (const project of raw) {
      const masque = hiddenRoots.some((r) => isWithinRoot(project.path, r));
      if (masque || !existsSync(project.path) || !hasMarker(project.path)) {
        report.skipped += 1;
        continue;
      }
      const declared = await registerCodeProjects(db, {
        entityId,
        agentId: project.ownerIds[0] ?? null,
        registeredJobId: null,
        // La dernière activité connue, pas l'instant du boot : le registre dit
        // quand le projet a vécu, et Spaces trie sur cette date.
        registeredAt: project.lastActivityAt ? new Date(project.lastActivityAt) : new Date(),
        roots: [{ key: projectKey(project.path), path: project.path }],
      });
      if (declared.length > 0) report.registered += declared.length;
      else report.skipped += 1;
    }
  }

  console.warn(
    `[projects] REGISTRY_BACKFILL registered=${report.registered} skipped=${report.skipped}`,
  );
  return report;
}
