// routes/chat-stream.ts — POST /api/chat/stream — le MÊME tour que /api/chat,
// dit au fur et à mesure qu'il s'écrit (#152).
//
// Ce qui change : QUAND le texte se montre. Rien d'autre. Le tour est le même
// tour (`runChatTurn`), il passe par la même file par conversation
// (`turn-lane.ts`, #149), il écrit la MÊME ligne assistant entière à la fin, et
// il escalade de la même façon. La route émet en plus les fragments de texte de
// la réponse pendant que le modèle les produit.
//
// Ce qui ne fuit PAS dans le flux : le recheck d'escalade, la relance sans
// outils, la génération du titre. Ce ne sont pas la réponse — les diffuser
// montrerait à l'écran du texte que personne n'a écrit pour être lu.
//
// Protocole (SSE) :
//   event: delta  data: { "text": "…" }        un fragment de la réponse
//   event: done   data: { "reply": "…", "spawnedJobId": …, "streamed": bool }
//   event: error  data: { "error": "code" }    le tour a échoué
//
// `done` porte la réponse ENTIÈRE, et c'est elle qui fait foi : un flux coupé
// en route ne doit jamais laisser un texte tronqué passer pour la réponse
// finale (invariant #4). Le lecteur d'en face remplace ce qu'il a accumulé.
//
// `streamed` dit si les fragments qui précèdent SONT cette réponse. Faux quand
// `streamText` a cassé et que la relance sans outils a livré le texte d'un
// bloc, ou quand l'agent tourne sur un runtime CLI qui ne diffuse rien. C'est
// un fait, pas une supposition laissée au lecteur (invariant #4).

import type { Context } from 'hono';
import { z } from 'zod';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { runChatTurn } from '../chat/run-chat-turn.ts';
import { runInLane } from '../chat/turn-lane.ts';
import { withChatTurnStop } from '../chat/turn-stop.ts';
import { executeJob } from '../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';
import { sseEvent, SSE_HEADERS } from './sse.ts';

const ChatStreamRequestSchema = z.object({
  entityId: z.string().guid(),
  agentId: z.string().guid(),
  conversationId: z.string().guid(),
  // Même plafond généreux que /api/chat : on y colle de gros textes.
  message: z.string().min(1).max(200_000),
});

export async function chatStreamRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const body = await c.req.json().catch(() => null);
  const parsed = ChatStreamRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, agentId, conversationId, message } = parsed.data;

  // Même autorisation que /api/chat : un appelant de confiance (le web, avec
  // WORKER_SECRET) a déjà résolu l'entité depuis la session ; un porteur de
  // jeton de session ne joue un tour que pour SA propre entité.
  if (!c.get('callerTrusted') && entityId !== c.get('callerEntityId')) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Tout ce qui pouvait être refusé l'a été AVANT d'ouvrir le flux : une fois
  // les en-têtes parties, le code HTTP ne peut plus rien dire. C'est ce qui
  // permet à l'appelant de se replier sur /api/chat sur un statut non-200 sans
  // risquer de rejouer un tour déjà lancé.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseEvent(event, data)));
        } catch {
          // Le lecteur est parti (onglet fermé). Le tour, lui, continue et
          // écrit sa ligne : ce qui a été dit à l'agent ne se perd pas.
          closed = true;
        }
      };

      void (async () => {
        try {
          const result = await runInLane(conversationId, () =>
            // Le tour en cours dépose son Stop (#456) : `/api/chat/stop` le
            // déclenche pour CETTE conversation, et pour ce tour-là seulement.
            withChatTurnStop(conversationId, (abortSignal) =>
              runChatTurn({
                deps,
                entityId,
                agentId,
                conversationId,
                message,
                onTextDelta: (delta) => send('delta', { text: delta }),
                abortSignal,
              }),
            ),
          );
          if (!result.ok) {
            send('error', { error: result.error });
            return;
          }
          send('done', {
            reply: result.reply,
            spawnedJobId: result.spawnedJobId ?? null,
            streamed: result.streamed === true,
            stopped: result.stopped === true,
          });

          // Le tour a escaladé : le travail part en fond, exactement comme sur
          // /api/chat. L'écran suit le job, pas ce flux-ci.
          if (result.spawnedJobId) {
            const jobId = result.spawnedJobId as JobId;
            void executeJob(jobId, deps, runnerEnv).catch((err: unknown) => {
              console.error('[chatStreamRoute] spawned job failed:', err);
            });
          }
        } catch (err) {
          console.error('[chatStreamRoute] turn failed:', err);
          send('error', { error: 'chat_failed' });
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            // Déjà fermé par le lecteur.
          }
        }
      })();
    },
  });

  return new Response(stream, { headers: { ...SSE_HEADERS } });
}
