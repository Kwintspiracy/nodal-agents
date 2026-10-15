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
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';

/** Une destination de Nodal à refuser : son port, sur les adresses locales. */
export interface DeniedEndpoint {
  readonly port: number;
}

/** Les adresses qui désignent CETTE machine : boucle locale + IP locales. */
export function localAddresses(): Set<string> {
  const out = new Set<string>(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::']);
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) out.add(i.address.toLowerCase());
  }
  return out;
}

/** Un hôte de destination désigne-t-il un service LOCAL ? */
function isLocalHost(host: string, locals: Set<string>): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return locals.has(h);
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
  const isDenied = (host: string, port: number): boolean =>
    deniedPorts.has(port) && isLocalHost(host, locals);

  const server: Server = createHttpServer((req, res) => {
    // Requête en forme absolue : `req.url` est l'URL complète.
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    if (isDenied(target.hostname, port)) {
      refused++;
      res.writeHead(403).end('nodal endpoint refused by the sandbox');
      return;
    }
    const up = httpRequest(
      {
        host: target.hostname,
        port,
        method: req.method,
        path: target.pathname + target.search,
        headers: req.headers,
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
  });

  // CONNECT (HTTPS, wss) : tunnel brut.
  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const [host, portRaw] = (req.url ?? '').split(':');
    const port = Number(portRaw) || 443;
    if (!host || isDenied(host, port)) {
      refused++;
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const up = netConnect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    });
    up.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => up.destroy());
  });

  // Upgrade websocket en clair (`ws://host:port`).
  server.on('upgrade', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      clientSocket.destroy();
      return;
    }
    const port = Number(target.port) || 80;
    if (isDenied(target.hostname, port)) {
      refused++;
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const up = netConnect(port, target.hostname, () => {
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
