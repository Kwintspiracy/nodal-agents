// tools.ts — ce que ce serveur expose : UN outil, `run_task`.
//
// La première version exposait directement `create_task` / `list_tasks` /
// `assign_*`, et la review l'a démontée en six constats avec une seule racine :
// ces outils tirent leur autorité du JOB qui les appelle. Les servir hors d'un
// job supprimait tout — la cohérence agent/entité, la hiérarchie, les
// approbations, l'audit, l'ancrage des tâches, les compteurs anti-boucle.
//
// Nodal avait déjà résolu exactement ce problème : la surface CHAT. Un tour de
// chat n'est pas un job, donc il n'a qu'un outil, `run_task`, qui crée un VRAI
// job — et c'est ce job qui exécute, avec sa boucle, ses gardes et son audit.
// Ce serveur applique le même contrat : un client MCP est une surface sans job,
// il reçoit la même porte d'entrée que le chat, pas les outils internes.

import { z } from 'zod';

export const runTaskInputSchema = z.object({
  agent: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'agent must be a slug (lowercase letters, digits, hyphens)')
    .optional()
    .describe(
      'Optional TARGET agent, by slug, resolved INSIDE this workspace only. ' +
        'Omit to address the workspace root agent. Choosing a target is the ' +
        'same power as choosing which chat to type in — the job runs under ' +
        "THAT agent's tools, approval rules and budgets, and MCP jobs never " +
        'get the configuration tools regardless of target.',
    ),
  caller: z
    .string()
    .min(1)
    .max(120)
    // Une etiquette est un IDENTIFIANT, pas du texte libre. Sans cette regex,
    // le champ acceptait retours a la ligne et Markdown, et il est interpole
    // dans le bloc Runtime — donc dans le MESSAGE SYSTEME du job. Un client
    // pouvait y ecrire une fausse section « instructions operateur » qui
    // obtenait la priorite d un message systeme (constat passe 5). Refuser a
    // l entree vaut mieux qu assainir au rendu : l erreur est nette, et aucun
    // rendu futur ne peut reintroduire le trou en oubliant l assainissement.
    .regex(/^[\w .:@/-]+$/, 'caller must be a plain label (letters, digits, spaces, .:@/-_ only)')
    .optional()
    .describe(
      'Optional label naming WHO is asking (e.g. "agent-dev-a", "quentin-terminal"). ' +
        'Purely declarative — recorded as provenance on the job, shown on the Runs ' +
        'page, and NEVER used for authorization: the job runs under the rules of the ' +
        'agent this server was launched for, whatever this says.',
    ),
  instruction: z
    .string()
    .min(1)
    .max(16_000)
    .describe(
      "La demande, en clair et auto-suffisante : l'agent qui l'exécute ne voit " +
        'RIEN de cette session MCP. Il travaille avec ses propres outils, ' +
        'skills et sous-agents, sous ses propres règles d approbation.',
    ),
});

export type RunTaskInput = z.infer<typeof runTaskInputSchema>;

/**
 * Description montrée au client MCP. Réutilise le vocabulaire de la surface
 * chat : ce que l'appel fait vraiment — créer un job traçable — plutôt qu'une
 * promesse d'exécution immédiate.
 */
export const RUN_TASK_DESCRIPTION =
  'Hand a request to this Nodal agent. Creates a TRACKED JOB the agent runs ' +
  'with its full toolset — connectors, skills, delegation to its team — under ' +
  'its own approval rules and budgets. Returns the job id immediately; the ' +
  'work itself runs asynchronously and lands on the Runs page. State the ' +
  'request faithfully and self-contained: the agent sees nothing of this ' +
  'MCP session.';
