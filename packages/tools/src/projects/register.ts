// projects/register.ts — DÉCLARER un projet au registre (P5b), en une
// instruction par racine.
//
// LA DÉCISION (Quentin, 06/09) : un dossier où une production de code a
// atterri et qui porte un manifeste EST un projet, déclaré par la conversation
// qui y a produit. Le registre (`code_projects.registered_at`, P5) se remplit
// donc tout seul ; le bouton « New project » reste pour déclarer d'avance, et
// la question « où écrire ? » (P10) ne sert que pour les dossiers SANS
// manifeste, où rien ne permet de deviner.
//
// DEUX APPELANTS, une règle : le rattachement d'une production
// (projects/attach.ts, au fil de l'eau) et le backfill au démarrage du runner
// (apps/runner/src/bootstrap/backfill-registered-projects.ts, pour l'activité
// d'avant P5b). Ils passent par la même instruction pour qu'une ligne déclarée
// par l'un soit exactement celle que l'autre aurait déclarée.
//
// UNE instruction : `INSERT … ON CONFLICT (entity_id, project_key) DO UPDATE …
// WHERE registered_at IS NULL`. Trois cas, sans lecture préalable :
//   - la ligne n'existe pas → insérée, déclarée ;
//   - elle existe en COMPTABILITÉ (renommage, masquage, ligne posée par
//     l'intention de mutation) → déclarée, ses autres colonnes intactes ;
//   - elle est DÉJÀ déclarée → le WHERE est faux, rien ne bouge, et
//     `RETURNING` ne la rend pas : l'appelant sait qu'il n'a rien déclaré.
// Deux appels concurrents du même tour ne peuvent pas se départager autrement
// sans course.
//
// CE QUI N'EST PAS TOUCHÉ, et c'est voulu : `display_name` (NULL = nom du
// dossier ; un nom choisi reste choisi) et `hidden` (un projet rangé par le
// propriétaire reste rangé — il est au registre, la liste le montre avec son
// étiquette). Un `agent_id` absent ne remplace pas un `agent_id` présent.
//
// INVARIANT #2 : ce module journalise des CODES et des données, jamais une
// phrase.

import { codeProjects, isNull } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';

export interface RegisterCodeProjectsInput {
  readonly entityId: string;
  /** L'agent qui a produit — son terrain contient la racine par construction. `null` : inconnu. */
  readonly agentId: string | null;
  /** Le job qui déclare, ou `null` (tour de chat, backfill). */
  readonly registeredJobId: string | null;
  /** L'instant de la déclaration — `now()` au fil de l'eau, la dernière activité au backfill. */
  readonly registeredAt: Date;
  /**
   * CE QUE le projet produit — du code, ou des documents (P10b).
   *
   * OBLIGATOIRE, jamais par défaut : les deux appelants historiques déclarent
   * une racine à MANIFESTE, donc `'code'`, et le troisième
   * (`register_project`, la réponse à « où écrire ? ») déclare un dossier de
   * DOCUMENTS. Un défaut aurait rangé le prochain appelant au hasard.
   */
  readonly kind: 'code' | 'documents';
  /**
   * Le nom choisi, posé à l'INSERT SEULEMENT.
   *
   * Sur une ligne qui existe déjà, `display_name` reste ce que le PROPRIÉTAIRE
   * a écrit : il l'a saisi dans Spaces, et un agent qui redéclare le même
   * dossier sous un autre nom le renommerait dans le dos de celui qui l'a
   * nommé. C'est la même règle que `hidden` (voir l'en-tête). `null`/absent =
   * nom du dossier.
   */
  readonly displayName?: string | null;
  /** Les racines à déclarer, telles que `resolveProjectRoots` les rend (clé + chemin affiché). */
  readonly roots: ReadonlyArray<{ readonly key: string; readonly path: string }>;
}

/** Une ligne que CET appel a déclarée. */
export interface RegisteredCodeProject {
  readonly id: string;
  readonly key: string;
  readonly path: string;
}

/**
 * Déclare chaque racine au registre, et rend celles que cet appel a
 * effectivement déclarées — les racines déjà au registre n'y figurent pas.
 *
 * Lève sur une panne de base : c'est à l'appelant de décider si elle est
 * fatale (le backfill la journalise et continue ; le rattachement la range
 * dans son issue `failed`).
 */
export async function registerCodeProjects(
  db: AnyDrizzleDb,
  input: RegisterCodeProjectsInput,
): Promise<RegisteredCodeProject[]> {
  const out: RegisteredCodeProject[] = [];
  for (const root of input.roots) {
    const rows = await db
      .insert(codeProjects)
      .values({
        entityId: input.entityId,
        projectPath: root.path,
        projectKey: root.key,
        kind: input.kind,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        agentId: input.agentId,
        registeredAt: input.registeredAt,
        registeredFrom: 'conversation',
        registeredJobId: input.registeredJobId,
      })
      .onConflictDoUpdate({
        target: [codeProjects.entityId, codeProjects.projectKey],
        set: {
          // `display_name` n'est PAS dans le `set` : voir `displayName` plus
          // haut — un nom déjà écrit par le propriétaire ne se réécrit pas.
          kind: input.kind,
          // Un agent connu remplace l'absence ; une absence ne remplace rien.
          ...(input.agentId ? { agentId: input.agentId } : {}),
          registeredAt: input.registeredAt,
          registeredFrom: 'conversation',
          registeredJobId: input.registeredJobId,
          updatedAt: new Date(),
        },
        setWhere: isNull(codeProjects.registeredAt),
      })
      .returning({ id: codeProjects.id });
    const row = rows[0];
    if (!row) continue;
    out.push({ id: row.id, key: root.key, path: root.path });
    console.warn(
      `[projects] PROJECT_REGISTERED id=${row.id} key=${root.key} ` +
        `job=${input.registeredJobId ?? '-'} agent=${input.agentId ?? '-'}`,
    );
  }
  return out;
}
