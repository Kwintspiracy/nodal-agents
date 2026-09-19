// routes/sse.ts — le format d'un événement Server-Sent Events.
//
// Trois lignes, mais écrites UNE fois : un `data:` qui porterait un retour à la
// ligne couperait l'événement en deux, et le lecteur d'en face lirait la moitié
// d'un JSON. `JSON.stringify` n'émet jamais de retour à la ligne brut, donc la
// charge tient toujours sur une seule ligne `data:`.

/** Un événement SSE prêt à être écrit sur le fil : `event:`, `data:`, ligne vide. */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
