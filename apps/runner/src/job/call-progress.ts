// job/call-progress.ts — ce qu'un appel au modèle produit, dit pendant qu'il
// le produit (issue #484).
//
// Job 82ecec67 : vingt et une minutes, 12 030 jetons générés, ni texte ni appel
// d'outil terminé, et rien ne le disait avant le Stop. Le flux rapporte sa
// production (`onProgress`, packages/llm/src/turn-clocks.ts) ; ce module la
// DIT à intervalle régulier, par une ligne de journal, pour TOUT appelant d'un
// appel streamé : la boucle des jobs et le chat en flux passent par lui, pas
// par deux copies qui divergeraient.
//
// Invariant #2 : une ligne de journal faite de champs typés, jamais un texte
// adressé à la personne.

import type { CallProgress } from '@nodal-agents/llm';

/** La période du battement d'un appel : celle du battement du job qu'il sert. */
export const CALL_PROGRESS_PERIOD_MS = 60_000;

const RIEN_ENCORE: CallProgress = {
  textChars: 0,
  reasoningChars: 0,
  toolInputChars: 0,
  toolName: null,
};

/** Le suivi d'UN appel : à brancher sur `onProgress`, à arrêter à sa fin. */
export interface CallProgressWatch {
  /** À passer tel quel en option `onProgress` de l'appel. */
  onProgress: (progress: CallProgress) => void;
  /** Ce que l'appel avait produit au dernier morceau reçu (`null` : rien). */
  produced: () => CallProgress | null;
  /** Arrête le battement ; à appeler dans le `finally` de l'appel. */
  stop: () => void;
}

/**
 * Dit, toutes les `periodMs`, depuis combien de temps l'appel tourne et ce
 * qu'il a produit : caractères de texte, de raisonnement, d'arguments d'outil,
 * et l'outil en cours de remplissage.
 */
export function watchCallProgress(
  say: (facts: Record<string, unknown>) => void,
  periodMs: number = CALL_PROGRESS_PERIOD_MS,
): CallProgressWatch {
  const startedAt = Date.now();
  let last: CallProgress | null = null;
  const timer = setInterval(() => {
    say({ elapsedMs: Date.now() - startedAt, ...(last ?? RIEN_ENCORE) });
  }, periodMs);
  return {
    onProgress: (progress) => {
      last = progress;
    },
    produced: () => last,
    stop: () => clearInterval(timer),
  };
}
