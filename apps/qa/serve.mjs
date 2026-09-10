#!/usr/bin/env node
// apps/qa/serve.mjs — sert le portail en local, sans dépendance.
//
// `file://` suffirait pour lire, mais pas pour ce qui vient : les données
// vivantes (résultats d'exécution, chantiers) se chargeront par requête, et le
// protocole fichier les bloque. Un port dès maintenant évite de refaire.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
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
  // Un DOSSIER passe le test d'existence et fait lever `EISDIR` à la lecture.
  // L'erreur n'était pas rattrapée : une simple requête sur `/data/` éteignait
  // le serveur entier (revue Codex, PR #51). Un portail qu'une URL suffit à
  // tuer n'est pas un portail.
  let contenu;
  try {
    if (!cible.startsWith(ICI) || !existsSync(cible) || !statSync(cible).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('introuvable');
      return;
    }
    contenu = readFileSync(cible);
  } catch (err) {
    // Fichier effacé entre le test et la lecture, permission refusée, disque
    // qui tousse : on répond 500 et on CONTINUE de servir.
    console.error(`[qa] lecture impossible de ${url} :`, err);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('lecture impossible');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(cible)] ?? 'application/octet-stream' });
  res.end(contenu);
}).listen(PORT, () => {
  console.log(`Portail qualité → http://localhost:${PORT}`);
});
