// routes/sse.ts — le format d'un événement Server-Sent Events.
//
// Trois lignes, mais écrites UNE fois : un `data:` qui porterait un retour à la
// ligne couperait l'événement en deux, et le lecteur d'en face lirait la moitié
// d'un JSON. `JSON.stringify` n'émet jamais de retour à la ligne brut, donc la
// charge tient toujours sur une seule ligne `data:`.
//
// Et LE flux d'un abonnement (`subscriptionStream`) : comment un flux qui
// écoute une source en mémoire se finit, écrit une fois pour toutes ses routes.

/** Un événement SSE prêt à être écrit sur le fil : `event:`, `data:`, ligne vide. */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Ce qu'un abonnement reçoit pour parler à son lecteur. */
export interface SubscriptionIo {
  /** Écrit un morceau du flux ; rien après la fin. Un lecteur parti finit le flux. */
  write: (chunk: string) => void;
  /** Finit le flux : désinscrit l'abonnement et ferme le corps. Sans effet la seconde fois. */
  end: () => void;
}

/**
 * LE flux SSE d'un abonnement à une source en mémoire (le bus des événements
 * de job, la voix d'une annonce, un tour en cours) : ce qui le finit, quoi que
 * ce soit, désinscrit l'abonnement et ferme le corps, UNE fois (#1033).
 *
 * `open` est appelé une fois, au démarrage du flux ; il inscrit l'abonnement
 * et rend sa désinscription. Trois choses finissent le flux, par le même
 * chemin (`end`) :
 *   - la requête abandonnée : son `signal`, y compris DÉJÀ abandonné quand le
 *     flux s'ouvre (un client parti pendant l'autorisation, avant la
 *     réponse). Un écouteur posé sur un signal déjà abandonné n'est jamais
 *     appelé, et `@hono/node-server` ne voit pas non plus ce départ-là : il
 *     n'écoute la fermeture de la connexion qu'en commençant à écrire le
 *     corps, après elle, puis attend un `drain` qui ne vient jamais ;
 *   - le lecteur qui annule le corps (`cancel`), ou un `enqueue` qui lève ;
 *   - l'abonnement lui-même (`end` : une fin de tour, une voix dite).
 *
 * Le flux GARDE sa requête jusqu'à sa fin. Le `signal` d'une `Request`
 * construite avec un signal d'appel (`new Request(url, { signal })`, ce que
 * passe à `app.fetch` tout appelant qui n'est pas `@hono/node-server`) ne fait
 * que SUIVRE celui-ci, et undici ne tient ce lien que par une référence
 * faible : la requête ramassée par le GC, l'abandon n'arrive plus jamais, et
 * l'abonnement reste inscrit pour toujours. Garder le seul `signal` n'y suffit
 * pas : c'est la requête qui porte le contrôleur qui l'abandonne.
 */
export function subscriptionStream(
  request: Request,
  open: (io: SubscriptionIo) => () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let end: () => void = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false;
      let unsubscribe: (() => void) | null = null;
      end = () => {
        if (ended) return;
        ended = true;
        // `request` est lu ici, par le flux : c'est ce qui le garde en vie
        // aussi longtemps que lui.
        request.signal.removeEventListener('abort', end);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Déjà fermé : le lecteur a annulé le corps.
        }
      };
      const write = (chunk: string): void => {
        if (ended) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Le lecteur est parti.
          end();
        }
      };
      const close = open({ write, end: () => end() });
      // L'abonnement a fini le flux pendant son ouverture, avant que sa
      // désinscription soit connue : elle se fait maintenant.
      if (ended) {
        close();
        return;
      }
      unsubscribe = close;
      if (request.signal.aborted) end();
      else request.signal.addEventListener('abort', end, { once: true });
    },
    cancel() {
      end();
    },
  });
}

/** Les en-têtes d'une réponse SSE — sans cache, sans tampon intermédiaire. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // nginx et consorts mettent en tampon par défaut : le flux arriverait d'un
  // bloc, ce qui est exactement ce qu'on cherche à éviter.
  'X-Accel-Buffering': 'no',
};
