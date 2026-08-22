// tools.ts — quels outils ce serveur expose, et pour QUI.
//
// Rien n'est inventé ici. La liste vient des mêmes générateurs que la boucle
// Nodal utilise (`generateAssignTools`, `generateTaskTools`), tous deux calculés
// depuis la base pour UN agent donné. C'est ce qui satisfait l'invariant #9 par
// construction plutôt que par vigilance : un serveur qui composerait sa propre
// liste dériverait le jour où un droit change, et exposerait à un client ce que
// l'agent n'a pas le droit de faire.
//
// Étape C1 : délégation seulement (`create_task`, `list_tasks`, `assign_*`).
// `assign_*` a besoin d'attendre son résultat, ce que le transport stdio ne sait
// pas faire dans un seul tour — voir la note sur l'étape C2 dans le plan.

import { generateAssignTools } from '@nodal-agents/orchestration';
import { generateTaskTools } from '@nodal-agents/orchestration';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';

/** Un outil exposable : le contrat minimal dont le serveur a besoin. */
export type ExposableTool = ToolDefinition<z.ZodTypeAny, unknown>;

/**
 * Les outils qu'un agent donné peut réellement appeler.
 *
 * `assign_*` n'est PAS inclus en C1, et c'est délibéré : cet outil rend la main
 * à l'orchestrateur après que l'enfant a fini, ce qui suppose un tour qui se
 * met en pause puis reprend. Un appel MCP est synchrone — le tenir ouvert
 * pendant qu'un job entier tourne mettrait le client en attente sans limite.
 * L'étape C2 le traitera par la reprise de session, pas par une attente.
 */
export async function listExposableTools(
  agentId: string,
  db: AnyDrizzleDb,
): Promise<ExposableTool[]> {
  const [createTask, listTasks] = generateTaskTools(agentId as never, db);
  const tools: ExposableTool[] = [
    createTask as unknown as ExposableTool,
    listTasks as unknown as ExposableTool,
  ];

  // Un agent sans sous-agent n'a AUCUN outil de délégation — et le serveur doit
  // alors n'en exposer aucun, pas une liste vide d'un outil générique. C'est la
  // différence entre « tu n'as personne à qui déléguer » et « délègue à qui tu
  // veux ».
  const assign = await generateAssignTools(agentId as never, db);
  if (assign.length > 0) {
    // Présent pour que la liste reflète la base ; l'exécution reste refusée en
    // C1 (voir le serveur), plutôt que d'être silencieusement absente.
    tools.push(...(assign as unknown as ExposableTool[]));
  }

  return tools;
}

/** Les outils dont l'EXÉCUTION est refusée en C1, tout en restant listés. */
export function isDeferredToC2(toolName: string): boolean {
  return toolName.startsWith('assign_');
}
