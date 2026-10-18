// proxy.ts — le proxy filtrant que Nodal tient CÔTÉ HÔTE, pour le régime
// réseau du bac à sable sous Windows (#628, D2).
//
// MXC n'accepte un proxy que sur la boucle locale (« networkProxy must use
// localhost, 127.0.0.1, or [::1] », mesuré). En régime proxy, le conteneur a
// `egress deny` : TOUT son trafic sortant passe par ce proxy. Le proxy laisse
// passer internet et les services locaux TIERS (ComfyUI, Ollama, un serveur
// de dev), et REFUSE les propres services de Nodal (runner, web, Postgres) —
// sinon une commande confinée pilaterait Nodal lui-même sur la boucle locale.
//
// Il écoute sur 127.0.0.1 seulement : jamais joignable depuis le réseau local.
// Le conteneur l'atteint par le canal `allowedProxyPeer` de MXC.
//
// Trois chemins HTTP à filtrer, chacun par (hôte, port) de destination :
//   - requête en forme absolue (`GET http://host:port/…`) ;
//   - `CONNECT host:port` (HTTPS, wss) ;
//   - `Upgrade` websocket en clair (`ws://host:port`).
// Un refus rend 403 (un port de Nodal) ou 502 codé (un nom introuvable), en
// requête comme en tunnel.

import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { connect as netConnect, isIP, type AddressInfo, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';

/** Une destination de Nodal à refuser : son port, sur les adresses locales. */
export interface DeniedEndpoint {
  readonly port: number;
}

/** Les adresses IP de CETTE machine (interfaces), zone retirée, en minuscules. */
export function localAddresses(): Set<string> {
  const out = new Set<string>(['127.0.0.1', '::1']);
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) out.add(normalizeIp(i.address));
  }
  return out;
}

/**
 * Retire la zone IPv6 (`fe80::1%eth0`), les crochets, et mappe une IPv4-en-IPv6
 * vers l'IPv4, que `URL` l'ait laissée en quad pointé (`::ffff:127.0.0.1`) ou
 * canonisée en hexa (`::ffff:7f00:1`).
 */
function normalizeIp(addr: string): string {
  const a =
    addr
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .split('%')[0] ?? '';
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return a;
}

/**
 * Une ADRESSE RÉSOLUE désigne-t-elle cette machine ? On décide sur l'adresse,
 * pas sur le nom (#628, P1-1) : tout 127.0.0.0/8, `::1`, l'adresse non
 * spécifiée, l'IPv4 mappée en IPv6, et chaque adresse d'interface locale
 * (IPv6 lien-local comprise). Un nom qui résout en local (`localtest.me`,
 * `127.0.0.1.nip.io`, un rebinding) tombe donc dessus par son adresse.
 */
function isLocalIp(addr: string, locals: Set<string>): boolean {
  const a = normalizeIp(addr);
  if (a === '::1' || a === '::' || a === '0.0.0.0') return true;
  if (/^127\./.test(a)) return true;
  return locals.has(a);
}

export interface NodalProxy {
  /** `http://127.0.0.1:<port>` à donner à MXC (`runtimeConfig.networkProxy`). */
  readonly url: string;
  /** Combien de connexions ont été refusées (pour les tests/journaux). */
  readonly refusedCount: () => number;
  close(): Promise<void>;
}

/** Ce que le proxy lit du système ; injectable pour les tests. */
export interface NodalProxyDeps {
  /** Les adresses de cette machine, relues À CHAQUE connexion. */
  readonly localAddresses?: () => Set<string>;
  /** Toutes les adresses d'un nom, dans l'ordre du résolveur. */
  readonly lookup?: (host: string) => Promise<string[]>;
}

const systemLookup = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((r) => r.address);

/** Le code du refus quand un nom ne se résout pas : le nom n'est jamais joint. */
export const PROXY_UNRESOLVED = 'SANDBOX_PROXY_UNRESOLVED';

/** Ce que le proxy décide pour une destination. */
type Decision =
  | { readonly kind: 'nodal' }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'forward'; readonly addrs: readonly string[] };

/**
 * Joint `port` sur la PREMIÈRE adresse qui répond, dans l'ordre du résolveur :
 * un hôte double pile dont l'AAAA est cassé passe par son A, le repli que Node
 * faisait quand on lui donnait le nom (#628, passe 4). Chaque adresse est déjà
 * classée non refusée ; aucune n'est re-résolue.
 */
function connectFirst(addrs: readonly string[], port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let i = 0;
    let last: unknown = new Error('no address to connect to');
    const next = (): void => {
      const addr = addrs[i++];
      if (addr === undefined) {
        reject(last);
        return;
      }
      const sock = netConnect(port, addr);
      const onError = (e: unknown): void => {
        last = e;
        sock.destroy();
        next();
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.off('error', onError);
        // Le socket est désormais au proxy, pas à l'appelant : un RST de
        // l'amont (service local qui plante, conteneur qui s'arrête) après la
        // réponse arrive quand l'écouteur du client HTTP est déjà retiré, et
        // sans écouteur Node lève ECONNRESET dans le processus hôte. L'erreur
        // n'est pas perdue : le socket se ferme, et chaque appelant traite la
        // fin de sa connexion (502, destruction du tunnel).
        sock.on('error', () => undefined);
        resolve(sock);
      });
    };
    next();
  });
}

/**
 * Démarre le proxy. `denied` = les ports de Nodal ; une destination locale sur
 * l'un d'eux est refusée, tout le reste passe.
 */
export async function startNodalProxy(
  denied: readonly DeniedEndpoint[],
  deps: NodalProxyDeps = {},
): Promise<NodalProxy> {
  const readLocals = deps.localAddresses ?? localAddresses;
  const resolveAll = deps.lookup ?? systemLookup;
  const deniedPorts = new Set(denied.map((d) => d.port));
  let refused = 0;

  /**
   * Résout l'hôte UNE fois et décide sur ses adresses. Les adresses locales
   * sont relues ICI, à chaque connexion (#628, passe 4) : une interface apparue
   * après le démarrage du proxy (Docker, WSL, un VPN) est locale dès qu'elle
   * existe. Un nom qui ne se résout pas est REFUSÉ, jamais joint par son nom :
   * Node le résoudrait lui-même, peut-être vers 127.0.0.1.
   */
  const classify = async (host: string, port: number): Promise<Decision> => {
    const bare = host.replace(/^\[|\]$/g, '');
    let addrs: string[];
    if (isIP(bare)) {
      addrs = [bare];
    } else {
      try {
        addrs = await resolveAll(bare);
      } catch {
        addrs = [];
      }
    }
    if (addrs.length === 0) return { kind: 'unresolved' };
    if (deniedPorts.has(port)) {
      const locals = readLocals();
      if (addrs.some((a) => isLocalIp(a, locals))) return { kind: 'nodal' };
    }
    return { kind: 'forward', addrs };
  };

  /** Le refus d'un tunnel (CONNECT, upgrade), en clair sur la socket. */
  const tunnelRefusal = (d: Exclude<Decision, { kind: 'forward' }>, host: string): string => {
    if (d.kind === 'nodal') {
      refused++;
      return 'HTTP/1.1 403 Forbidden\r\n\r\n';
    }
    return `HTTP/1.1 502 Bad Gateway\r\n\r\n${PROXY_UNRESOLVED}: ${host}`;
  };

  const server: Server = createHttpServer((req, res) => {
    void (async () => {
      // Requête en forme absolue : `req.url` est l'URL complète.
      let target: URL;
      try {
        target = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end('bad request');
        return;
      }
      const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
      const d = await classify(target.hostname, port);
      if (d.kind === 'nodal') {
        refused++;
        res.writeHead(403).end('nodal endpoint refused by the sandbox');
        return;
      }
      if (d.kind === 'unresolved') {
        res.writeHead(502).end(`${PROXY_UNRESOLVED}: ${target.hostname}`);
        return;
      }
      let sock: Socket;
      try {
        sock = await connectFirst(d.addrs, port);
      } catch {
        res.writeHead(502).end();
        return;
      }
      const up = httpRequest(
        {
          host: target.hostname,
          port,
          method: req.method,
          path: target.pathname + target.search,
          headers: req.headers, // garde l'en-tête Host d'origine
          // La connexion déjà ouverte vers l'adresse classée : aucune résolution.
          createConnection: () => sock,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(up);
    })();
  });

  // CONNECT (HTTPS, wss) : tunnel brut.
  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    clientSocket.on('error', () => undefined);
    void (async () => {
      const url = req.url ?? '';
      const i = url.lastIndexOf(':');
      const host = url.slice(0, i);
      const port = Number(url.slice(i + 1)) || 443;
      const d: Decision = host ? await classify(host, port) : { kind: 'unresolved' };
      if (d.kind !== 'forward') {
        clientSocket.end(tunnelRefusal(d, host));
        return;
      }
      let up: Socket;
      try {
        up = await connectFirst(d.addrs, port);
      } catch {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      up.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => up.destroy());
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    })();
  });

  // Upgrade websocket en clair (`ws://host:port`).
  server.on('upgrade', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    clientSocket.on('error', () => undefined);
    void (async () => {
      let target: URL;
      try {
        target = new URL(req.url ?? '');
      } catch {
        clientSocket.destroy();
        return;
      }
      const port = Number(target.port) || 80;
      const d = await classify(target.hostname, port);
      if (d.kind !== 'forward') {
        clientSocket.end(tunnelRefusal(d, target.hostname));
        return;
      }
      let up: Socket;
      try {
        up = await connectFirst(d.addrs, port);
      } catch {
        clientSocket.destroy();
        return;
      }
      up.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => up.destroy());
      const headerLines = [
        `${req.method} ${target.pathname + target.search} HTTP/1.1`,
        ...Object.entries(req.headers).map(
          ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`,
        ),
        '',
        '',
      ].join('\r\n');
      up.write(headerLines);
      if (head.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    refusedCount: () => refused,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
