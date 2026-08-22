// @nodal-agents/mcp-server — Nodal vu de l'extérieur.
//
// Deux usages, un seul mécanisme :
//   - un agent en runtime CLI qui peut enfin confier du travail à son équipe ;
//   - un terminal qui pilote Nodal, par exemple pour lancer trois reviews en
//     parallèle sans quitter la ligne de commande.
//
// Le contrat est celui de la surface chat : UN outil, `run_task`, qui crée un
// vrai job — et c'est le job qui exécute, avec ses gardes. Ce paquet n'expose
// JAMAIS les outils internes d'un job à une surface qui n'en est pas un ;
// tools.ts porte l'autopsie de la version qui le faisait.

export { buildNodalMcpServer, startNodalMcpServer, type McpServerOptions } from './server';
export { runTaskInputSchema, RUN_TASK_DESCRIPTION, type RunTaskInput } from './tools';
