// launch.ts — LE point d'entrée exécutable du serveur MCP.
//
// Constat de la passe 6 : le paquet exportait `startNodalMcpServer()` mais ne
// fournissait ni bin, ni script, ni programme construisant la connexion DB.
// La fonctionnalité annoncée — « Nodal exposé en serveur MCP » — n'était donc
// pas lançable depuis une config MCP sans écrire un intégrateur soi-même. Une
// bibliothèque sans lanceur n'est pas une fonctionnalité, c'est un composant.
//
// Usage (config MCP d'un client, ex. `claude mcp add`) :
//
//   command: pnpm
//   args:    --filter @nodal-agents/mcp-server serve
//   env:     DATABASE_URL=postgres://...   (obligatoire)
//            NODAL_MCP_AGENT_ID=<uuid>     (optionnel — défaut : l'agent
//                                           racine du workspace, lu en base)
//
// DATABASE_URL est EXIGÉE, jamais devinée : inventer une URL par défaut serait
// un réglage par machine codé en dur (invariant #6), et se tromper de base en
// silence est pire qu'échouer.

import { createClient } from '@nodal-agents/db';
import { startNodalMcpServer } from './server';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  // stderr, pas stdout : stdout EST le transport MCP — y écrire du texte
  // libre corromprait le flux JSON-RPC du client.
  console.error(
    'mcp_missing_database_url: set DATABASE_URL in the MCP server env ' +
      '(the same URL the Nodal runner uses).',
  );
  process.exit(1);
}

const { db, close } = createClient(databaseUrl);

// Un id explicite via l'env, sinon la résolution racine du serveur (voir
// resolveRootAgentId — échec fort si zéro ou plusieurs candidats).
const agentId = process.env['NODAL_MCP_AGENT_ID'];

try {
  await startNodalMcpServer({ db, ...(agentId ? { agentId } : {}) });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  await close().catch(() => {});
  process.exit(1);
}
