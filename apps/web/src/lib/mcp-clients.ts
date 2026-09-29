// mcp-clients.ts — ce qu'il faut coller dans Claude Code ET dans Claude Desktop
// pour les brancher sur le serveur MCP de CETTE install (#485).
//
// Les deux clients peuvent être branchés en même temps : le serveur est en
// stdio, chaque client lance son propre processus contre la même base, et les
// travaux des deux arrivent sur la même page Runs.
//
// LA COMMANDE vient du CLI qui a démarré la stack (`NODAL_CLI_ARGV`,
// `apps/cli/src/lib/env.ts`) : le node qui l'exécute, ses options de
// chargement et son script. `nodal-agents mcp serve` écrit à la main ne marche
// ni sur un poste de dev (pas de CLI global) ni sur une install lancée par npx.
// Aucun secret n'y figure : `mcp serve` relit lui-même ~/.nodalai/config.json.
//
// Pur : aucun accès disque ici. L'écriture dans la config de Claude Desktop vit
// dans `claude-desktop-config.ts`.

/** Le nom sous lequel Nodal s'inscrit chez un client MCP. */
export const MCP_SERVER_NAME = 'nodal';

/**
 * La commande du CLI, lue dans l'environnement du web. `null` quand elle
 * manque ou ne se lit pas : le web n'a pas été démarré par `nodal-agents up`,
 * et l'écran le dit plutôt que d'inventer une commande (invariant #4).
 */
export function readCliArgv(raw: string | undefined): string[] | null {
  if (raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length < 2 ||
      !parsed.every((a): a is string => typeof a === 'string' && a !== '')
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** La ligne de commande qui lance le serveur MCP de cette install. */
export function mcpServeArgv(cliArgv: readonly string[]): string[] {
  return [...cliArgv, 'mcp', 'serve'];
}

/**
 * Un argument de shell, entre guillemets doubles dès qu'il sort des caractères
 * que cmd, PowerShell et bash lisent tous tels quels. L'antislash n'en fait PAS
 * partie : nu, bash (Git Bash) le prend pour un échappement, et
 * `D:\APPS\cli.js` y devient `D:APPScli.js`. Entre guillemets doubles, un
 * antislash suivi d'une lettre reste littéral dans les trois shells : la même
 * commande se colle partout. Un `"` dans l'argument (jamais dans un chemin
 * Windows) s'échappe en `\"`, que lisent bash et cmd, pas PowerShell.
 */
function shellArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/** La commande à taper pour Claude Code. */
export function claudeCodeCommand(cliArgv: readonly string[]): string {
  return `claude mcp add ${MCP_SERVER_NAME} -- ${mcpServeArgv(cliArgv).map(shellArg).join(' ')}`;
}

export type DesktopServerEntry = { command: string; args: string[] };

/** L'entrée `mcpServers.nodal` de Claude Desktop. */
export function claudeDesktopEntry(cliArgv: readonly string[]): DesktopServerEntry {
  const [command, ...args] = mcpServeArgv(cliArgv);
  return { command: command!, args };
}

/**
 * Où Claude Desktop range sa configuration, par système. Linux n'a pas de
 * Claude Desktop officiel : le chemin est celui des portages courants, et
 * l'écriture échoue en le disant si le dossier n'existe pas.
 */
export function claudeDesktopConfigPath(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  join: (...parts: string[]) => string,
): string {
  if (platform === 'win32') {
    const appData = env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return join(
    env['XDG_CONFIG_HOME'] ?? join(home, '.config'),
    'Claude',
    'claude_desktop_config.json',
  );
}

export class DesktopConfigError extends Error {
  constructor(
    readonly code: 'invalid_json' | 'invalid_shape',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Le fichier de Claude Desktop, avec l'entrée de Nodal posée. Les AUTRES
 * serveurs et les autres clés sont gardés tels quels ; une entrée `nodal`
 * existante est remplacée, et `replaced` le dit. Un fichier illisible n'est
 * jamais écrasé : l'erreur remonte.
 */
export function withNodalEntry(
  existing: string | null,
  entry: DesktopServerEntry,
): { text: string; replaced: boolean } {
  let config: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new DesktopConfigError(
        'invalid_json',
        'Claude Desktop’s config file is not valid JSON',
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DesktopConfigError(
        'invalid_shape',
        'Claude Desktop’s config file is not an object',
      );
    }
    config = parsed as Record<string, unknown>;
  }
  const servers = config['mcpServers'] ?? {};
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new DesktopConfigError(
      'invalid_shape',
      '`mcpServers` in Claude Desktop’s config is not an object',
    );
  }
  const replaced = Object.prototype.hasOwnProperty.call(servers, MCP_SERVER_NAME);
  const next = { ...config, mcpServers: { ...servers, [MCP_SERVER_NAME]: entry } };
  return { text: `${JSON.stringify(next, null, 2)}\n`, replaced };
}
