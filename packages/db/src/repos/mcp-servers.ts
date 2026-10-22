// repos/mcp-servers.ts — un serveur MCP local (stdio) déclaré dans un espace, et son environnement.
//
// Les valeurs d'environnement d'un serveur stdio portent souvent un secret
// (GITHUB_TOKEN…) : elles sont CHIFFRÉES une à une à l'écriture, et le runner
// les déchiffre au lancement du job. Trois chemins écrivaient la ligne chacun
// pour soi : l'écran des connecteurs (`createMcpServerFromCatalogAction`), le
// méta-outil `create_mcp`, et l'imprimante du banc (#794) qui ne la chiffrait
// pas, si bien que le runner l'aurait écartée. Ils passent maintenant par ICI.
// Le déchiffrement aussi : le runner (execute.ts) et le lecteur du banc lisent
// l'environnement par la même fonction.
//
// Se connecter au serveur pour lister ses outils reste chez l'appelant : ce
// paquet n'importe pas le client MCP.

import { decrypt, encrypt } from '@nodal-agents/secrets';
import type { AnyDrizzleDb } from '../client.ts';
import { mcpServers } from '../schema/mcp.ts';

export interface StdioMcpServerInput {
  readonly name: string;
  readonly slug: string;
  readonly command: string;
  readonly args: readonly string[];
  /** En clair : chaque valeur est chiffrée ici. */
  readonly env: Readonly<Record<string, string>>;
  /** Les outils que le serveur a listés à sa connexion (descripteurs complets). */
  readonly availableTools: unknown;
  /** Les `instructions` qu'il a publiées à cette connexion, ou null. */
  readonly instructions: string | null;
}

/**
 * Déclare un serveur stdio actif dans l'espace, son environnement chiffré
 * valeur par valeur. `encryptValue` : le chiffrement de l'appelant quand il lui
 * est fourni (le runner le prête au méta-outil), sinon celui de la clé
 * maîtresse de ce processus.
 */
export async function createStdioMcpServerRepo(
  db: AnyDrizzleDb,
  entityId: string,
  input: StdioMcpServerInput,
  encryptValue: (plaintext: string) => string = (v) => encrypt(v),
): Promise<{ id: string }> {
  const envVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env)) envVars[k] = encryptValue(v);
  const [row] = await db
    .insert(mcpServers)
    .values({
      entityId,
      name: input.name,
      slug: input.slug,
      transport: 'stdio',
      // Un serveur stdio ne porte rien du transport http : le runner branche
      // sur `transport`, et ces champs ne sont jamais lus sur ce chemin.
      url: null,
      apiKey: null,
      apiKeyLast4: null,
      authScheme: null,
      authParamName: null,
      command: input.command,
      args: [...input.args],
      envVars,
      availableTools: input.availableTools,
      instructions: input.instructions,
      active: true,
    })
    .returning({ id: mcpServers.id });
  if (!row) throw new Error('mcp_server_insert_failed: the insert returned no row');
  return { id: row.id };
}

/**
 * L'environnement en clair d'un serveur stdio, tel que la base le garde
 * (`mcp_servers.env_vars`, chaque valeur chiffrée). Lève quand une valeur ne
 * se déchiffre pas (ligne altérée, clé maîtresse changée) ou n'est pas une
 * chaîne : jamais une variable perdue en silence.
 */
export function decryptMcpServerEnv(
  envVars: unknown,
  decryptValue: (blob: string) => string = (v) => decrypt(v),
): Record<string, string> {
  if (envVars === null || envVars === undefined) return {};
  if (typeof envVars !== 'object' || Array.isArray(envVars))
    throw new Error('mcp_server_env_invalid: env_vars is not an object');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(envVars as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`mcp_server_env_invalid: ${k} is not a string`);
    out[k] = decryptValue(v);
  }
  return out;
}
