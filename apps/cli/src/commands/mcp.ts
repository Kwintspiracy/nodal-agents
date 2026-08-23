// mcp.ts — `nodal-agents mcp serve` : le lanceur MCP que l'utilisateur peut taper.
//
// Avant cette commande, connecter un client MCP demandait :
//   claude mcp add nodal -e DATABASE_URL=… -- pnpm --filter @nodal-agents/mcp-server --silent serve
// Trois défauts rédhibitoires (constat Quentin, 23/08) : `pnpm --filter` n'existe
// que dans le monorepo de dev — la commande documentée ne marchait sur AUCUNE
// install npm ; l'utilisateur ne connaît pas DATABASE_URL et ne doit pas la
// connaître ; l'URL contient le mot de passe Postgres, qui finissait en clair
// dans la config MCP du client.
//
// Nodal sait déjà tout cela : le CLI résout cette URL depuis ~/.nodalai/config.json
// à chaque `up`. Cette commande fait la même résolution, puis démarre le serveur
// stdio. La commande utilisateur devient :
//   claude mcp add nodal -- nodal-agents mcp serve
// Une ligne, zéro secret, zéro connaissance requise.
//
// STDOUT EST LE TRANSPORT MCP : rien ne doit s'y écrire — pas de bannière, pas
// de chalk, pas de spinner. Toute erreur part sur stderr (voir launch.ts, constat
// passe 7 : une bannière pnpm sur stdout suffisait à invalider le serveur).

import { readConfig, type Config } from '../lib/config.ts';
import { buildDatabaseUrl } from '../lib/env.ts';

export interface McpServeOptions {
  databaseUrl: string;
  notifyRunner: { url: string; workerSecret: string };
  agentId?: string;
}

/**
 * Résolution pure, testable sans processus : config → options du serveur.
 * Échec FORT si le config manque — inventer une URL par défaut serait un
 * réglage par machine codé en dur (invariant #6), et se tromper de base en
 * silence est pire qu'échouer (même contrat que launch.ts).
 */
export function resolveMcpServeOptions(
  config: Config | null,
  env: NodeJS.ProcessEnv = process.env,
): McpServeOptions {
  if (!config) {
    throw new Error(
      'mcp_config_missing: ~/.nodalai/config.json not found or unreadable. ' +
        'Run `nodal-agents init` (or `nodal-agents up` once) before connecting MCP clients.',
    );
  }
  const agentId = env['NODAL_MCP_AGENT_ID'];
  return {
    // Même résolution que `up` : le mot de passe du config, ou le legacy pour
    // les clusters d'avant SECRET-003 (buildDatabaseUrl porte ce défaut).
    databaseUrl: buildDatabaseUrl(config.ports.postgres, config.postgresPassword),
    // 127.0.0.1, jamais `localhost` : sur Windows, localhost préfère l'IPv6
    // ::1 où le runner n'écoute pas (bind 127.0.0.1) — la notification
    // échouerait en silence, et un squatteur de [::1]:port recevrait le
    // workerSecret. C'est le piège que env.ts documente déjà (RUNNER_URL).
    // Le secret n'est pas optionnel : la route /api/worker exige le Bearer,
    // une notification sans secret est un 403 permanent déguisé en succès.
    notifyRunner: {
      url: `http://127.0.0.1:${config.ports.runner}`,
      workerSecret: config.workerSecret,
    },
    ...(agentId ? { agentId } : {}),
  };
}

/**
 * Démarre le serveur MCP stdio avec la config de l'install, sert jusqu'à la
 * déconnexion du client, puis ferme le pool et sort. Sans cette sortie, le
 * client MCP qui fait l'arrêt standard (fermer stdin, attendre l'exit)
 * laissait un orphelin tenant des connexions Postgres (constat review 23/08).
 */
export async function runMcpServe(): Promise<void> {
  const opts = resolveMcpServeOptions(readConfig());

  // Imports différés (le reste du CLI n'a pas à parser ces graphes de
  // modules), en parallèle : ils sont indépendants. Note : createClient
  // n'ouvre le pool qu'à l'APPEL, pas à l'import — le différé n'économise
  // que le coût de parsing.
  const [{ createClient }, { startNodalMcpServer }] = await Promise.all([
    import('@nodal-agents/db'),
    import('@nodal-agents/mcp-server'),
  ]);

  const { db, close } = createClient(opts.databaseUrl);
  try {
    // Se résout à la DÉCONNEXION du client (stdin fermé), pas au démarrage.
    await startNodalMcpServer({
      db,
      notifyRunner: opts.notifyRunner,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    });
  } catch (err) {
    // stderr uniquement — stdout est le transport JSON-RPC.
    console.error(err instanceof Error ? err.message : String(err));
    await close().catch(() => {});
    process.exit(1);
  }
  await close().catch(() => {});
  process.exit(0);
}
