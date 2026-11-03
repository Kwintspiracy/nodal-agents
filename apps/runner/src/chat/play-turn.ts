// chat/play-turn.ts — UN tour de conversation, tel que chaque porte le joue.
//
// Trois portes jouent le même tour : `/api/chat` (d'un bloc), `/api/chat/stream`
// (au fil de l'eau, #152) et le tour vocal (#941). Chacune enveloppait
// `runChatTurn` des trois mêmes couches puis lançait le job escaladé ; une
// quatrième copie aurait été la première à dériver. Les couches, dans l'ordre :
//
//   - la file par conversation (`turn-lane.ts`, #149) : un tour à la fois, et
//     chacun voit la réponse au précédent ;
//   - le tour lisible d'une autre page (`live-turn.ts`, #457) ;
//   - le Stop de la personne (`turn-stop.ts`, #456), que `/api/chat/stop`
//     déclenche pour ce tour-là, quelle que soit la porte qui l'a lancé.
//
// Puis, si le tour a escaladé, son job part en fond. La porte ne décide que de
// ce qu'elle rend à son appelant.

import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { executeJob } from '../job/execute.ts';
import { withLiveTurn } from './live-turn.ts';
import { runChatTurn, type ChatTurnResult } from './run-chat-turn.ts';
import { runInLane } from './turn-lane.ts';
import { withChatTurnStop } from './turn-stop.ts';

export type PlayChatTurnInput = Omit<Parameters<typeof runChatTurn>[0], 'deps' | 'abortSignal'>;

export async function playChatTurn(
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
  input: PlayChatTurnInput,
  /** Le nom de la porte, pour le journal d'un job lancé qui échoue. */
  door: string,
): Promise<ChatTurnResult> {
  const { entityId, conversationId, onTextDelta } = input;
  const result = await runInLane(conversationId, () =>
    withLiveTurn(entityId, conversationId, (say) =>
      withChatTurnStop(conversationId, (abortSignal) =>
        runChatTurn({
          ...input,
          deps,
          abortSignal,
          // Le texte qui s'écrit est lisible d'une autre page (#457) : ce que
          // la porte diffuse passe d'abord par le tour en cours.
          ...(onTextDelta
            ? {
                onTextDelta: (delta: string) => {
                  say(delta);
                  onTextDelta(delta);
                },
              }
            : {}),
        }),
      ),
    ),
  );
  // Le tour a escaladé : le travail part en fond. Le tour a déjà rendu la
  // réponse de l'agent ; l'écran, ou le module, suit le job.
  if (result.ok && result.spawnedJobId) {
    void executeJob(result.spawnedJobId as JobId, deps, runnerEnv).catch((err: unknown) => {
      console.error(`[${door}] spawned job failed:`, err);
    });
  }
  return result;
}
