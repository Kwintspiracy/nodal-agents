// printer/declaration.ts — comment le banc déclare son imprimante à une équipe (#794).
//
// UNE fonction, pour l'instance jetable du banc : elle rend la déclaration du
// serveur MCP (commande, arguments, environnement) pour un dossier
// d'enregistrements. L'instance l'écrit dans `mcp_servers` et l'attribue à
// l'agent qui imprime ; rien d'autre n'est à brancher. Le juge relit le même
// dossier dans cette même déclaration (`benchPrinterState`, identity.ts).

import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { BENCH_DIR } from '../workflows/paths';
import {
  BENCH_PRINTER_RECORDS_ENV,
  BENCH_PRINTER_SLUG,
  type BenchPrinterServerDeclaration,
} from './identity';

export type { BenchPrinterServerDeclaration };

/**
 * Où vit, SUR LE DISQUE, le dossier de l'imprimante. Les chemins de la
 * déclaration partent du paquet du banc (`BENCH_DIR`, workflows/paths.ts), et
 * non d'une résolution par le module lui-même :
 * `createRequire(import.meta.url).resolve('tsx/cli')` et
 * `new URL('./main.ts', import.meta.url)` sont des motifs qu'un bundler SUIT.
 * Le serveur de Bench Studio (Turbopack) compile ce module, parce que ses
 * besoins lisent l'imprimante (`readBenchPrinter`) : il tentait d'embarquer
 * tsx, esbuild et son binaire natif, et la page répondait 500 (23/10).
 *
 * L'ancre est UNE, celle de tout ce que le banc lit et écrit sur le disque
 * (`REPO`, d'où viennent aussi les résultats et le catalogue que le Studio
 * affiche) : ce module n'en a plus de propre. Le CLI qui écrit la déclaration
 * et le Studio qui la relit la calculent donc du même point ;
 * identity.test.ts vérifie qu'elle est, champ pour champ, ce que l'entrée du
 * CLI résout, quel que soit le dossier où le processus démarre.
 */
const PRINTER_DIR = join(BENCH_DIR, 'src', 'printer');

/**
 * La déclaration du serveur d'impression du banc, qui enregistre dans
 * `recordsDir` (un chemin ABSOLU : le runner le lance depuis un dossier qui
 * n'est pas celui du banc). Il tourne avec le Node du banc et son `tsx`, sans
 * passer par `pnpm` ni par un dossier de travail.
 */
export function benchPrinterServer(recordsDir: string): BenchPrinterServerDeclaration {
  if (!isAbsolute(recordsDir))
    throw new Error(`bench_printer_records_dir_not_absolute: "${recordsDir}"`);
  const tsxCli = createRequire(join(BENCH_DIR, 'package.json')).resolve('tsx/cli');
  return {
    name: 'Bench printer',
    slug: BENCH_PRINTER_SLUG,
    transport: 'stdio',
    command: process.execPath,
    args: [tsxCli, join(PRINTER_DIR, 'main.ts')],
    envVars: { [BENCH_PRINTER_RECORDS_ENV]: recordsDir },
  };
}
