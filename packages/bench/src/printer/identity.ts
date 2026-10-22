// printer/identity.ts — qui est l'imprimante du banc (#794), et ce que l'espace en dit.
//
// Le serveur d'impression du banc est un serveur MCP comme un autre pour le
// runner : il est déclaré dans `mcp_servers`, attribué à un agent, et ses
// outils arrivent sous `<préfixe du slug>__<outil>`. Son IDENTITÉ est ce slug
// ET le dossier d'enregistrements que sa déclaration porte : jamais le nom d'un
// outil. Un connecteur qui expose lui aussi `request_print` n'est pas lui, et
// reste un outil sortant (`isOutboundTool`).
//
// Ce fichier ne dépend de rien d'autre que du préfixe d'outil MCP du produit :
// needs.ts, trial.ts et la lecture de la base l'importent sans tirer le serveur.

import { mcpToolPrefix } from '@nodal-agents/shared';

/** Le slug sous lequel la déclaration du banc range le serveur. */
export const BENCH_PRINTER_SLUG = 'bench-printer';

/**
 * La variable d'environnement par laquelle la déclaration donne au serveur le
 * dossier où il écrit un enregistrement par demande. C'est aussi là que le juge
 * le relit : une seule source, la déclaration que le runner lance.
 */
export const BENCH_PRINTER_RECORDS_ENV = 'NODAL_BENCH_PRINTER_RECORDS_DIR';

/** Les outils du serveur. Aucun ne confirme : il n'y a pas d'imprimante derrière. */
export const BENCH_PRINTER_TOOLS = ['request_print', 'get_print_request'] as const;
export type BenchPrinterTool = (typeof BENCH_PRINTER_TOOLS)[number];

/**
 * Un appel d'outil du serveur du banc : le nom que le runner lui donne
 * (`<préfixe>__<outil>`) pour un de SES outils. Décidé sur le serveur, pas sur
 * le mot « print » : `office_printer__request_print` n'en est pas un.
 */
export function isBenchPrinterTool(toolName: string): boolean {
  const prefix = `${mcpToolPrefix(BENCH_PRINTER_SLUG)}__`;
  if (!toolName.startsWith(prefix)) return false;
  return (BENCH_PRINTER_TOOLS as readonly string[]).includes(toolName.slice(prefix.length));
}

/**
 * Ce que l'espace de l'essai dit de l'imprimante du banc :
 *   - `absent` : aucun serveur de ce slug n'est attribué à un agent actif ;
 *   - `attached` : un serveur actif, déclaré comme le banc le déclare, et le
 *     dossier où il enregistre ;
 *   - `broken` : un serveur de ce slug existe mais n'est pas déclaré comme le
 *     banc le déclare. Dit, jamais deviné.
 */
export type BenchPrinterState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'attached'; readonly recordsDir: string }
  | { readonly kind: 'broken'; readonly reason: string };

/** Une ligne de `mcp_servers` attribuée à un agent actif de l'espace, telle que la base la rend. */
export interface AttachedMcpServer {
  readonly slug: string;
  readonly transport: string;
  readonly envVars: unknown;
}

/**
 * L'état de l'imprimante du banc d'après les serveurs attribués à l'équipe.
 * Pur : la lecture de la base est ailleurs (`readBenchPrinter`, stack.ts).
 */
export function benchPrinterState(servers: readonly AttachedMcpServer[]): BenchPrinterState {
  const mine = servers.filter((s) => s.slug === BENCH_PRINTER_SLUG);
  if (mine.length === 0) return { kind: 'absent' };
  const dirs = new Set<string>();
  for (const s of mine) {
    if (s.transport !== 'stdio')
      return {
        kind: 'broken',
        reason: `the "${BENCH_PRINTER_SLUG}" server is declared with transport ${s.transport}, the bench declares it over stdio`,
      };
    const env = s.envVars;
    const dir =
      env !== null && typeof env === 'object'
        ? (env as Record<string, unknown>)[BENCH_PRINTER_RECORDS_ENV]
        : undefined;
    if (typeof dir !== 'string' || dir.trim() === '')
      return {
        kind: 'broken',
        reason: `the "${BENCH_PRINTER_SLUG}" server declares no ${BENCH_PRINTER_RECORDS_ENV}: the judge cannot know where it records`,
      };
    dirs.add(dir);
  }
  if (dirs.size > 1)
    return {
      kind: 'broken',
      reason: `the "${BENCH_PRINTER_SLUG}" server is declared with ${dirs.size} different record folders: the judge cannot know which one to read`,
    };
  return { kind: 'attached', recordsDir: [...dirs][0]! };
}
