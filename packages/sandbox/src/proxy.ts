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
// Un refus rend 403 (requête) ou ferme le tunnel (CONNECT/upgrade).

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

/**
 * Démarre le proxy. `denied` = les ports de Nodal ; une destination locale sur
 * l'un d'eux est refusée, tout le reste passe.
 */
export async function startNodalProxy(denied: readonly DeniedEndpoint[]): Promise<NodalProxy> {
  const locals = localAddresses();
  const deniedPorts = new Set(denied.map((d) => d.port));
  let refused = 0;

  /**
   * Résout l'hôte UNE fois et décide sur l'adresse. Rend `{ refuse }` si un
   * port de Nodal est visé sur une adresse locale ; sinon `{ addr }`, l'IP
   * EXACTE à joindre — on ne re-résout pas (pas de fenêtre de rebinding).
   */
  const classify = async (
    host: string,
    port: number,
  ): Promise<{ refuse: true } | { refuse: false; addr: string }> => {
    const bare = host.replace(/^\[|\]$/g, '');
    let addrs: string[];
    if (isIP(bare)) {
      addrs = [bare];
    } else {
      try {
        addrs = (await lookup(bare, { all: true })).map((r) => r.address);
      } catch {
        addrs = [];
      }
    }
    if (deniedPorts.has(port) && addrs.some((a) => isLocalIp(a, locals))) {
      return { refuse: true };
    }
    // On joint la première adresse résolue, littéralement.
    return { refuse: false, addr: addrs[0] ?? bare };
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
      if (d.refuse) {
        refused++;
        res.writeHead(403).end('nodal endpoint refused by the sandbox');
        return;
      }
      const up = httpRequest(
        {
          host: d.addr,
          port,
          method: req.method,
          path: target.pathname + target.search,
          headers: req.headers, // garde l'en-tête Host d'origine
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
    void (async () => {
      const url = req.url ?? '';
      const i = url.lastIndexOf(':');
      const host = url.slice(0, i);
      const port = Number(url.slice(i + 1)) || 443;
      const d = host ? await classify(host, port) : ({ refuse: true } as const);
      if (d.refuse) {
        refused++;
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const up = netConnect(port, d.addr, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(clientSocket);
        clientSocket.pipe(up);
      });
      up.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => up.destroy());
    })();
  });

  // Upgrade websocket en clair (`ws://host:port`).
  server.on('upgrade', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
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
      if (d.refuse) {
        refused++;
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const up = netConnect(port, d.addr, () => {
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
      });
      up.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => up.destroy());
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
