// printer/declaration.ts — comment le banc déclare son imprimante à une équipe (#794).
//
// UNE fonction, pour l'instance jetable du banc : elle rend la déclaration du
// serveur MCP (commande, arguments, environnement) pour un dossier
// d'enregistrements. L'instance l'écrit dans `mcp_servers` et l'attribue à
// l'agent qui imprime ; rien d'autre n'est à brancher. Le juge relit le même
// dossier dans cette même déclaration (`benchPrinterState`, identity.ts).

import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BENCH_PRINTER_RECORDS_ENV,
  BENCH_PRINTER_SLUG,
  type BenchPrinterServerDeclaration,
} from './identity';

export type { BenchPrinterServerDeclaration };

/**
 * La déclaration du serveur d'impression du banc, qui enregistre dans
 * `recordsDir` (un chemin ABSOLU : le runner le lance depuis un dossier qui
 * n'est pas celui du banc). Il tourne avec le Node du banc et son `tsx`, sans
 * passer par `pnpm` ni par un dossier de travail.
 */
export function benchPrinterServer(recordsDir: string): BenchPrinterServerDeclaration {
  if (!isAbsolute(recordsDir))
    throw new Error(`bench_printer_records_dir_not_absolute: "${recordsDir}"`);
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  return {
    name: 'Bench printer',
    slug: BENCH_PRINTER_SLUG,
    transport: 'stdio',
    command: process.execPath,
    args: [tsxCli, fileURLToPath(new URL('./main.ts', import.meta.url))],
    envVars: { [BENCH_PRINTER_RECORDS_ENV]: recordsDir },
  };
}
