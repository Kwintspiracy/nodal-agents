// scripts/lib/bench-studio.mjs — le serveur de Bench Studio, sans la stack.
//
// Bench Studio est l'outil LOCAL du propriétaire pour le banc d'essai
// (`pnpm bench:studio`), jamais livré. Il lance ses essais : son point d'entrée
// de lancement ne doit être joignable QUE depuis cette machine, même quand la
// stack de dev tourne en mode LAN (BIND=0.0.0.0). Trois verrous, tous ici :
//
//   1. le serveur n'écoute que sur 127.0.0.1 : depuis le réseau, rien ne
//      répond (pas même un refus HTTP) ;
//   2. chaque requête est filtrée AVANT Next : une adresse distante qui n'est
//      pas la boucle locale, ou un Host qui n'est pas un nom de cette machine
//      (rebinding DNS), reçoit un 403. Une requête admise porte un jeton tiré
//      au démarrage (`x-bench-studio-gate`, jamais pris au client) : les routes
//      du studio refusent toute requête qui ne l'a pas, donc tout serveur Next
//      lancé autrement que par ce filtre ;
//   3. il ne touche jamais la stack qui tourne : son propre port (jamais celui
//      du web ni du runner de ~/.nodalai/config.json), son propre dossier de
//      build (`.next-studio`, jamais `.next`).
//
// Les fonctions sont pures ou prennent leurs dépendances en paramètre, pour
// que les tests (scripts/tests/bench-studio.test.mjs) les prouvent sans Next.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

export const STUDIO_ENV = 'NODAL_BENCH_STUDIO';
export const STUDIO_HOST = '127.0.0.1';
export const STUDIO_PORT = 4320;
export const STUDIO_DIST_DIR = '.next-studio';
/** Le jeton du filtre : dans l'environnement du processus, et sur chaque requête admise. */
export const STUDIO_GATE_ENV = 'NODAL_BENCH_STUDIO_GATE';
export const STUDIO_GATE_HEADER = 'x-bench-studio-gate';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * La requête vient-elle de cette machine, pour ce serveur ?
 * Rend null quand elle est admise, sinon le code du refus.
 */
export function studioRefusal({ remoteAddress, host }, port) {
  if (!LOOPBACK_ADDRESSES.has(remoteAddress ?? '')) return 'studio_not_loopback';
  const h = String(host ?? '').toLowerCase();
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(h);
  if (!m || !LOOPBACK_NAMES.has(m[1]) || (m[2] !== undefined && Number(m[2]) !== port))
    return 'studio_host_not_allowed';
  return null;
}

/**
 * Le port du studio, refusé s'il est celui de la stack (web, runner) : le
 * studio ne s'installe jamais à la place de ce qui tourne.
 */
export function assertStudioPort(port, stackPorts) {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536)
    throw new Error(`bench_studio_bad_port: ${JSON.stringify(port)} is not a port`);
  if (stackPorts.includes(port))
    throw new Error(
      `bench_studio_port_taken_by_stack: :${port} is a port of the stack (${stackPorts.map((p) => `:${p}`).join(', ')} in ~/.nodalai/config.json); pick another with --port`,
    );
  return port;
}

/** L'environnement du processus Next du studio : le mode studio, rien d'autre de changé. */
export function studioEnv(base, port, gate) {
  return {
    ...base,
    [STUDIO_ENV]: '1',
    [STUDIO_GATE_ENV]: gate,
    PORT: String(port),
    NODE_ENV: 'development',
  };
}

/**
 * Le serveur HTTP du studio. `handle` et `upgrade` sont ceux de Next ; toute
 * requête refusée par `studioRefusal` s'arrête ici, avant eux.
 */
export function createStudioServer({ port, gate, handle, upgrade }) {
  const server = createServer((req, res) => {
    const why = studioRefusal(
      { remoteAddress: req.socket.remoteAddress, host: req.headers.host },
      port,
    );
    if (why) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: why }));
      return;
    }
    // Le jeton vient d'ICI, jamais du client : celui qu'il enverrait est écrasé.
    req.headers[STUDIO_GATE_HEADER] = gate;
    handle(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    if (studioRefusal({ remoteAddress: req.socket.remoteAddress, host: req.headers.host }, port)) {
      socket.destroy();
      return;
    }
    req.headers[STUDIO_GATE_HEADER] = gate;
    upgrade(req, socket, head);
  });
  return server;
}

/** Écoute sur la boucle locale, et seulement là ; un port occupé échoue, sans repli. */
export function listenLoopback(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', (e) =>
      reject(
        e.code === 'EADDRINUSE'
          ? new Error(
              `bench_studio_port_busy: ${STUDIO_HOST}:${port} is already in use; pick another with --port`,
            )
          : e,
      ),
    );
    server.listen(port, STUDIO_HOST, () => resolve(server.address()));
  });
}

/**
 * Next réécrit `next-env.d.ts` (suivi par git) pour pointer sur le dossier de
 * build qu'il sert : le studio le remet tel qu'il était, pour que la stack et
 * l'arbre de travail ne voient rien. Rend la fonction qui le restaure.
 */
export function keepFile(path) {
  const before = readFileSync(path);
  return () => {
    const now = readFileSync(path);
    if (!now.equals(before)) writeFileSync(path, before);
    return !now.equals(before);
  };
}
