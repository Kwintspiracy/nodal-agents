// GET /bench-studio/api/runs/<id>/events — le fil d'un lancement, en SSE (les événements passés d'abord).
import { studioError, studioRouteRefusal, studioRuntime } from '@/lib/bench-studio/server';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const refused = studioRouteRefusal(req);
  if (refused) return refused;
  const { id } = await params;
  const manager = studioRuntime().manager;
  if (!manager.get(id)) return studioError(new Error(`studio_no_run: ${id}`), 404);
  const enc = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = manager.subscribe(id, (e) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      });
      req.signal.addEventListener('abort', () => {
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // déjà fermé : le client est parti, il n'y a plus personne à prévenir
        }
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
