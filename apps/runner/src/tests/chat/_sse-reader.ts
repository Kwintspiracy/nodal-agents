// _sse-reader.ts — lit un flux SSE de route au fil de l'eau, pour les tests.
//
// Le test n'attend pas la fin du flux : il regarde ce qui est DÉJÀ arrivé
// (`events`), pendant que la lecture continue en fond.

export interface SseEvent {
  event: string;
  data: unknown;
}

export function readSse(res: Response): { events: SseEvent[]; done: Promise<void> } {
  const events: SseEvent[] = [];
  const body = res.body;
  if (!body) throw new Error('readSse: response has no body');
  const done = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        events.push({ event, data: data.length > 0 ? JSON.parse(data.join('\n')) : null });
        cut = buffer.indexOf('\n\n');
      }
    }
  })();
  done.catch(() => {});
  return { events, done };
}
