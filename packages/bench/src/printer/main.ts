// printer/main.ts — le point d'entrée du serveur d'impression du banc (#794).
//
// Lancé par le runner comme tout serveur MCP stdio (`benchPrinterServer`,
// declaration.ts le déclare). Le dossier d'enregistrements vient de sa
// déclaration (`NODAL_BENCH_PRINTER_RECORDS_DIR`) : sans lui, le serveur refuse
// de démarrer, il n'en invente pas un (invariant #4).

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BENCH_PRINTER_RECORDS_ENV } from './identity';
import { createBenchPrinterServer } from './server';

const dir = process.env[BENCH_PRINTER_RECORDS_ENV];
if (dir === undefined || dir.trim() === '') {
  process.stderr.write(
    `bench_printer_records_dir_missing: ${BENCH_PRINTER_RECORDS_ENV} is not set; the bench printer has nowhere to record\n`,
  );
  process.exit(2);
}

await createBenchPrinterServer(dir).connect(new StdioServerTransport());
