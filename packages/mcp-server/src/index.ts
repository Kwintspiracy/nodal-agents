// @nodal-agents/mcp-server — Nodal vu de l'extérieur.
//
// Deux usages, un seul mécanisme :
//   - un agent en runtime CLI qui peut enfin confier du travail à son équipe ;
//   - un terminal qui pilote Nodal, par exemple pour lancer trois reviews en
//     parallèle sans quitter la ligne de commande.
//
// Ce que le paquet n'est PAS : un catalogue global. Les outils exposés sont
// ceux d'UN agent, calculés depuis la base par les mêmes générateurs que la
// boucle Nodal — voir tools.ts.

export { buildNodalMcpServer, startNodalMcpServer, type McpServerOptions } from './server';
export { listExposableTools, isDeferredToC2, type ExposableTool } from './tools';
