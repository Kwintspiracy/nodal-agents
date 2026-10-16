// scripts/lib/bench-studio.mjs — le serveur de Bench Studio, sans la stack.
//
// Bench Studio est l'outil LOCAL du propriétaire pour le banc d'essai
// (`pnpm bench:studio`), jamais livré. Il lance ses essais : son point d'entrée
// de lancement ne doit être joignable QUE depuis cette machine, même quand la
// stack de dev tourne en mode LAN (BIND=0.0.0.0), et seulement par ses propres
// pages, jamais par une autre page ouverte dans le même navigateur. Trois
// verrous, tous ici :
//
//   1. le serveur n'écoute que sur 127.0.0.1 : depuis le réseau, rien ne
//      répond (pas même un refus HTTP) ;
//   2. chaque requête est filtrée AVANT Next (`studioRequestRefusal`) :
//      - une adresse distante qui n'est pas la boucle locale, ou un Host qui
//        n'est pas un nom de cette machine (rebinding DNS) : 403 ;
//      - un chemin qui n'est pas Bench Studio : 404. Ce port ne sert jamais les
//        routes ordinaires du dashboard ;
//      - une requête qu'une AUTRE page du navigateur envoie (Origin qui n'est
//        pas celle du studio, Sec-Fetch-Site ni `same-origin` ni `none`) : 403 ;
//      - toute requête qui change quelque chose (autre que GET/HEAD) sans le
//        jeton anti-CSRF dans `x-bench-studio-csrf` : 403. Ce jeton, la PAGE le
//        reçoit du studio (rendu serveur) et le renvoie ; le filtre ne le pose
//        JAMAIS. Un en-tête personnalisé force un pré-vol CORS, que le studio
//        n'accorde jamais : un `fetch` en `no-cors` depuis un site tiers ne
//        peut pas le porter.
//      Une requête admise porte en plus un jeton tiré au démarrage
//      (`x-bench-studio-gate`, posé ICI et jamais pris au client) : les routes
//      du studio refusent toute requête qui ne l'a pas, donc tout serveur Next
//      lancé autrement que par ce filtre ;
//   3. il ne touche jamais la stack qui tourne : son propre port (jamais celui
//      du web ni du runner de ~/.nodalai/config.json), son propre dossier de
//      build (`.next-studio`, jamais `.next`).
//
// Les fonctions sont pures ou prennent leurs dépendances en paramètre, pour
// que les tests (scripts/tests/bench-studio.test.mjs) les prouvent sans Next.

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

export const STUDIO_ENV = 'NODAL_BENCH_STUDIO';
export const STUDIO_HOST = '127.0.0.1';
export const STUDIO_PORT = 4320;
export const STUDIO_DIST_DIR = '.next-studio';
/** Le jeton du filtre : dans l'environnement du processus, et sur chaque requête admise. */
export const STUDIO_GATE_ENV = 'NODAL_BENCH_STUDIO_GATE';
export const STUDIO_GATE_HEADER = 'x-bench-studio-gate';
/** Le jeton anti-CSRF : la page le reçoit et le renvoie ; jamais posé par le filtre. */
export const STUDIO_CSRF_ENV = 'NODAL_BENCH_STUDIO_CSRF';
export const STUDIO_CSRF_HEADER = 'x-bench-studio-csrf';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const OWN_FETCH_SITES = new Set(['same-origin', 'none']);

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
 * Ce que ce port sert : Bench Studio, les fichiers de Next qui le font tourner,
 * et le logo qu'il affiche. Rien d'autre : ni le dashboard, ni ses routes.
 */
export function isStudioPath(url) {
  const path = String(url ?? '').split('?')[0];
  return (
    path === '/bench-studio' ||
    path.startsWith('/bench-studio/') ||
    path.startsWith('/_next/') ||
    path === '/logo-128.png'
  );
}

/**
 * Le filtre entier d'une requête, avant Next. Rend null quand elle est admise,
 * sinon `{ status, error }`. `req` porte ce que le serveur lit de la requête
 * (adresse, Host, chemin, méthode, Origin, Sec-Fetch-Site, en-tête anti-CSRF) ;
 * `studio` porte le port et le jeton anti-CSRF.
 */
export function studioRequestRefusal(req, { port, csrf }) {
  const where = studioRefusal(req, port);
  if (where) return { status: 403, error: where };
  if (!isStudioPath(req.url)) return { status: 404, error: 'studio_not_a_studio_route' };
  // L'origine du studio est celle du Host déjà admis : un nom de cette machine, ce port.
  if (req.origin !== undefined && req.origin !== `http://${String(req.host).toLowerCase()}`)
    return { status: 403, error: 'studio_foreign_origin' };
  if (req.secFetchSite !== undefined && !OWN_FETCH_SITES.has(req.secFetchSite))
    return { status: 403, error: 'studio_foreign_site' };
  if (!SAFE_METHODS.has(String(req.method ?? '').toUpperCase())) {
    const sent = Buffer.from(String(req.csrfHeader ?? ''));
    const want = Buffer.from(String(csrf ?? ''));
    if (want.length < 32 || sent.length !== want.length || !timingSafeEqual(sent, want))
      return { status: 403, error: 'studio_no_csrf_token' };
  }
  return null;
}

/** Ce que le filtre lit d'une requête Node. */
function seen(req) {
  const one = (h) => (Array.isArray(h) ? h[0] : h);
  return {
    remoteAddress: req.socket.remoteAddress,
    host: req.headers.host,
    url: req.url,
    method: req.method,
    origin: one(req.headers.origin),
    secFetchSite: one(req.headers['sec-fetch-site']),
    csrfHeader: one(req.headers[STUDIO_CSRF_HEADER]),
  };
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

/** L'environnement du processus Next du studio : le mode studio et ses deux jetons. */
export function studioEnv(base, port, gate, csrf) {
  return {
    ...base,
    [STUDIO_ENV]: '1',
    [STUDIO_GATE_ENV]: gate,
    [STUDIO_CSRF_ENV]: csrf,
    PORT: String(port),
    NODE_ENV: 'development',
  };
}

/**
 * Le serveur HTTP du studio. `handle` et `upgrade` sont ceux de Next ; toute
 * requête refusée par `studioRequestRefusal` s'arrête ici, avant eux, sans
 * aucun en-tête CORS : un pré-vol n'est jamais accordé.
 */
export function createStudioServer({ port, gate, csrf, handle, upgrade }) {
  const server = createServer((req, res) => {
    const why = studioRequestRefusal(seen(req), { port, csrf });
    if (why) {
      res.writeHead(why.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: why.error }));
      return;
    }
    // Le jeton vient d'ICI, jamais du client : celui qu'il enverrait est écrasé.
    req.headers[STUDIO_GATE_HEADER] = gate;
    handle(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    if (studioRequestRefusal(seen(req), { port, csrf })) {
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
