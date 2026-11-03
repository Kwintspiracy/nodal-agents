// runner-proxy.ts — la porte du navigateur vers une route du runner, SANS logique.
//
// Le tableau de bord n'est qu'un client des routes du runner (règle du #948) :
// ce qu'un module externe peut faire, il le fait par les mêmes routes. Cette
// porte ne fait que ce qu'un module ferait avec son propre jeton :
//
//   - la session du tableau de bord, et rien d'autre, dit QUI appelle ;
//   - le secret interne (WORKER_SECRET) prouve au runner que la porte web a
//     déjà résolu l'entité de cette session (server.ts, `callerTrusted`) ;
//   - la réponse du runner revient TELLE QUELLE : statut, type et corps.
//
// Ce qu'elle ne fait pas : décider. Un code d'erreur du runner n'est ni
// traduit ni avalé ; c'est l'écran qui le dit, comme le dirait un module.

import { requireUserWithEntity } from '@/lib/server.ts';
import { env } from '@/lib/env.ts';

export type ProxySession = { userId: string; entityId: string };

function refuse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Relaie `req` vers `url`, une route du runner. L'appelant l'écrit EN ENTIER
 * (l'adresse du runner suivie du chemin) : c'est la forme que lit la garde
 * `runner-routes.arch.test.ts`, qui confronte chaque appel du web aux routes
 * que le runner sert vraiment. `body` reçoit la session : c'est
 * elle, et jamais le client, qui donne l'entité d'un corps (le paramètre
 * existe pour ça). Sans `body`, le corps du navigateur passe en flux, sans
 * être lu ici : la borne de taille est celle du runner, qui la tient déjà
 * (`readBoundedBody`).
 */
export async function proxyToRunner(
  req: Request,
  url: string,
  opts: {
    method: 'POST' | 'DELETE';
    /** Le corps JSON à envoyer, construit depuis la session. Absent : le corps reçu, en flux. */
    body?: (session: ProxySession) => Promise<unknown>;
    /** Le nom de la porte, pour le journal. */
    door: string;
  },
): Promise<Response> {
  let session: ProxySession;
  try {
    session = await requireUserWithEntity(req);
  } catch {
    return refuse('unauthorized', 401);
  }

  if (!env.WORKER_SECRET) {
    console.error(`[${opts.door}] WORKER_SECRET missing — cannot reach runner`);
    return refuse('runner_unreachable', 503);
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${env.WORKER_SECRET}` };
  let body: BodyInit | null = null;
  // `duplex` n'est pas encore dans le type `RequestInit` de TypeScript : il est
  // exigé par undici dès que le corps est un flux.
  const init: RequestInit & { duplex?: 'half' } = { method: opts.method, headers };
  if (opts.body) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(await opts.body(session));
  } else if (req.body) {
    headers['Content-Type'] = req.headers.get('content-type') ?? 'application/octet-stream';
    body = req.body;
    init.duplex = 'half';
  }
  if (body !== null) init.body = body;

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (err) {
    console.error(`[${opts.door}] runner unreachable:`, err);
    return refuse('runner_unreachable', 502);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
