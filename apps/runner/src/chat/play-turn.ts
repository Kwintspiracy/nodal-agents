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
//
// LES FRAGMENTS SONT MASQUÉS ICI, UNE FOIS (revue de #968, passe 2). Avant
// tout consommateur du texte qui s'écrit — le tour lisible d'une autre page
// (`say`, `/api/chat/live`) ET la porte (`onTextDelta` : le flux tapé, la voix
// du tour dit) —, le masqueur de flux (`createStreamRedactor`,
// packages/shared) retire les secrets. Aucun client du runner, tableau de bord
// ou module, ne reçoit un fragment brut, et la voix n'en dit aucun. Il garde en
// réserve ce qui pourrait encore devenir un secret jusqu'à l'espace suivante
// (un mot au plus) ; la réserve sort quand le texte est fixé
// (`onReplyText`), ou à la fin du tour. La ligne rangée en base reste intacte :
// le masquage est d'affichage, comme aux portes web.

import type { JobId } from '@nodal-agents/orchestration';
import { createStreamRedactor } from '@nodal-agents/shared';
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
  const { entityId, conversationId, onTextDelta, onReplyText } = input;
  const result = await runInLane(conversationId, () =>
    withLiveTurn(entityId, conversationId, (say) =>
      withChatTurnStop(conversationId, async (abortSignal) => {
        const redactor = createStreamRedactor();
        // Le texte qui s'écrit est lisible d'une autre page (#457) : ce que
        // la porte diffuse passe d'abord par le tour en cours. Masqué avant
        // l'un et l'autre.
        const out = (safe: string): void => {
          if (safe === '' || !onTextDelta) return;
          say(safe);
          onTextDelta(safe);
        };
        const turn = await runChatTurn({
          ...input,
          deps,
          abortSignal,
          ...(onTextDelta
            ? {
                onTextDelta: (delta: string) => out(redactor.push(delta)),
                // Le texte fixé : la réserve du masqueur sort AVANT que la
                // porte l'apprenne, pour que ce qu'elle a reçu soit entier.
                onReplyText: (reply: { text: string; streamed: boolean }) => {
                  out(redactor.flush());
                  onReplyText?.(reply);
                },
              }
            : {}),
        });
        // Un tour fini sans texte fixé (Stop, coupure, runtime CLI) : la
        // réserve sort ici, avant la fin du tour lisible.
        out(redactor.flush());
        return turn;
      }),
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
