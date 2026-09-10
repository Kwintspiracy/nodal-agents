#!/usr/bin/env node
// apps/qa/serve.mjs — sert le portail en local, sans dépendance.
//
// `file://` suffirait pour lire, mais pas pour ce qui vient : les données
// vivantes (résultats d'exécution, chantiers) se chargeront par requête, et le
// protocole fichier les bloque. Un port dès maintenant évite de refaire.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
const DIST = join(ICI, 'dist');
const PORT = Number(process.env['QA_PORT'] ?? 4310);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  // Les données sont servies telles quelles : le portail doit pouvoir montrer
  // sa propre source, sinon « généré mécaniquement » n'est pas vérifiable.
  const cible = url.startsWith('/data/')
    ? join(ICI, url)
    : join(DIST, url === '/' ? 'index.html' : url);
  if (!cible.startsWith(ICI) || !existsSync(cible)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('introuvable');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(cible)] ?? 'application/octet-stream' });
  res.end(readFileSync(cible));
}).listen(PORT, () => {
  console.log(`Portail qualité → http://localhost:${PORT}`);
});
