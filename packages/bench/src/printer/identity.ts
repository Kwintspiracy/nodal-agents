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

import { resolve } from 'node:path';
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
/** Une ligne de `mcp_servers` : de quoi lancer le serveur en stdio. */
export interface BenchPrinterServerDeclaration {
  readonly name: string;
  readonly slug: string;
  readonly transport: 'stdio';
  readonly command: string;
  readonly args: string[];
  readonly envVars: Record<string, string>;
}

/** Une ligne de `mcp_servers` attribuée à un agent actif de l'espace, telle que la base la rend. */
export interface AttachedMcpServer {
  readonly slug: string;
  readonly transport: string;
  readonly command: string | null;
  readonly args: readonly string[] | null;
  readonly envVars: unknown;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** En quoi une ligne de la base diffère de la déclaration du banc ; vide : elle est identique. */
function differences(row: AttachedMcpServer, d: BenchPrinterServerDeclaration): string[] {
  const out: string[] = [];
  if (row.slug !== d.slug) out.push(`slug ${row.slug}`);
  if (row.transport !== d.transport) out.push(`transport ${row.transport}`);
  if (row.command !== d.command) out.push('command');
  if (row.args === null || !sameList(row.args, d.args)) out.push('args');
  const env = row.envVars;
  const keys =
    env !== null && typeof env === 'object' && !Array.isArray(env)
      ? Object.keys(env as Record<string, unknown>)
      : null;
  const same =
    keys !== null &&
    sameList(keys.sort(), Object.keys(d.envVars).sort()) &&
    Object.entries(d.envVars).every(([k, v]) => (env as Record<string, unknown>)[k] === v);
  if (!same) out.push('environment');
  return out;
}

/**
 * L'état de l'imprimante du banc d'après les serveurs attribués à l'équipe.
 * Pur : la lecture de la base est ailleurs (`readBenchPrinter`, stack.ts).
 *
 * L'identité est la DÉCLARATION entière. `declare` est la fabrique du banc
 * (`benchPrinterServer`) : une ligne qui n'est pas, champ pour champ, ce qu'elle
 * rend pour son dossier est `broken`, avec ce qui diffère. Sont examinées toutes
 * les lignes dont le PRÉFIXE d'outil est celui du banc (`bench-printer`,
 * `bench_printer`, `Bench.Printer` : le runner nomme leurs outils pareil), et pas
 * seulement celles qui ont exactement son slug : un connecteur réel déclaré sous
 * un slug voisin ne doit pas hériter de l'exemption.
 *
 * `expectedDir` : le dossier que le BANC a donné à l'instance, quand il le sait.
 * La déclaration doit le porter ; sinon la variable d'environnement d'une ligne
 * choisirait seule le dossier que le juge lit.
 */
export function benchPrinterState(
  servers: readonly AttachedMcpServer[],
  declare: (recordsDir: string) => BenchPrinterServerDeclaration,
  expectedDir: string | null = null,
): BenchPrinterState {
  const prefix = mcpToolPrefix(BENCH_PRINTER_SLUG);
  const mine = servers.filter((s) => mcpToolPrefix(s.slug) === prefix);
  if (mine.length === 0) return { kind: 'absent' };
  const broken = (reason: string): BenchPrinterState => ({ kind: 'broken', reason });
  const dirs = new Set<string>();
  for (const s of mine) {
    const env = s.envVars;
    const dir =
      env !== null && typeof env === 'object'
        ? (env as Record<string, unknown>)[BENCH_PRINTER_RECORDS_ENV]
        : undefined;
    if (typeof dir !== 'string' || dir.trim() === '')
      return broken(
        `the "${s.slug}" server declares no ${BENCH_PRINTER_RECORDS_ENV}: the judge cannot know where it records`,
      );
    let expected: BenchPrinterServerDeclaration;
    try {
      expected = declare(dir);
    } catch (e) {
      return broken(
        `the "${s.slug}" server cannot be the bench printer: ${String(e instanceof Error ? e.message : e)}`,
      );
    }
    const diff = differences(s, expected);
    if (diff.length > 0)
      return broken(
        `the "${s.slug}" server is not declared as benchPrinterServer() declares the bench printer (differs in: ${diff.join(', ')}): it is not the bench printer`,
      );
    dirs.add(dir);
  }
  if (dirs.size > 1)
    return broken(
      `the "${BENCH_PRINTER_SLUG}" server is declared with ${dirs.size} different record folders: the judge cannot know which one to read`,
    );
  const dir = [...dirs][0]!;
  if (expectedDir !== null && resolve(dir) !== resolve(expectedDir))
    return broken(
      `the "${BENCH_PRINTER_SLUG}" server records in ${dir}, not in ${expectedDir}, the folder the bench gave: the judge reads only the folder the bench gave`,
    );
  return { kind: 'attached', recordsDir: dir };
}
