// sse.ts — écrire et lire des événements Server-Sent Events (#152).
//
// Deux fonctions, utilisées des deux côtés de la porte web : la route relaie le
// flux du runner au navigateur (elle lit ET écrit), le lecteur client lit. Une
// seule définition du format, donc aucune chance que les deux divergent.
//
// Volontairement minimal : on ne lit que `event:` et `data:`, parce que c'est
// tout ce que ce flux-ci émet. Un `id:` ou un `retry:` est ignoré plutôt que
// deviné.

/** Un événement SSE prêt à être écrit : `event:`, `data:`, ligne vide. */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface SseMessage {
  event: string;
  /** La charge telle quelle — l'appelant sait ce qu'il attend et la parse. */
  data: string;
}

/**
 * Les événements d'un corps de réponse, au fur et à mesure.
 *
 * Un fragment réseau ne s'aligne sur rien : il coupe au milieu d'une ligne,
 * d'un caractère multi-octets, d'un événement. D'où le décodeur en mode flux
 * (`stream: true`) et le tampon jusqu'à la ligne vide qui termine un événement.
 */
export async function* readSseMessages(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Un événement se termine par une ligne vide. `\r\n` autant que `\n` :
      // la spec autorise les deux, et un intermédiaire peut réécrire.
      let sep = buffer.search(/\r?\n\r?\n/);
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (/\r\n\r\n/.test(buffer.slice(sep, sep + 4)) ? 4 : 2));
        const parsed = parseSseBlock(raw);
        if (parsed) yield parsed;
        sep = buffer.search(/\r?\n\r?\n/);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(raw: string): SseMessage | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}
