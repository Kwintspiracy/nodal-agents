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

/** La période à laquelle la page d'un run voit l'appel en cours avancer (#444). */
export const LIVE_PROGRESS_PERIOD_MS = 5_000;

/** Ce que la page d'un run lit de l'appel en cours (`agent_jobs.live_progress`). */
export type LiveProgress = CallProgress & {
  turn: number;
  callStartedAt: string;
  lastProgressAt: string | null;
};

/** Le suivi en direct d'UN appel, pour la page du run. */
export interface LiveCallProgress {
  /** À brancher sur `onProgress`, à côté de `watchCallProgress`. */
  onProgress: (progress: CallProgress) => void;
  /** Arrête les écritures et remet la colonne à NULL ; dans le `finally` de l'appel. */
  stop: () => Promise<void>;
}

/**
 * LA MÊME MESURE que `watchCallProgress` (le flux de l'appel, #484), rendue
 * lisible par la page d'un run (#444) : `write` pose la valeur sur la ligne du
 * job. Dès le début de l'appel (l'appel est là, rien n'est venu), puis au plus
 * une fois par période quand le flux a rapporté du neuf — jamais une écriture
 * par morceau — et NULL à la fin : ce qui fait foi ensuite, c'est le
 * transcript et `llm_calls`.
 */
export function liveCallProgress(
  write: (value: LiveProgress | null) => Promise<void>,
  opts: { turn: number; periodMs?: number },
): LiveCallProgress {
  const callStartedAt = new Date().toISOString();
  let last: CallProgress = RIEN_ENCORE;
  let lastProgressAt: string | null = null;
  let dirty = false;
  let stopped = false;
  const snapshot = (): LiveProgress => ({
    turn: opts.turn,
    ...last,
    callStartedAt,
    lastProgressAt,
  });
  // Une écriture qui échoue ne casse pas l'appel : la page perd un battement,
  // le travail continue, et la panne se dit dans le journal.
  const safeWrite = (value: LiveProgress | null): Promise<void> =>
    write(value).catch((err: unknown) => {
      console.warn('[call-progress] live_progress write failed', (err as Error).message);
    });
  void safeWrite(snapshot());
  const timer = setInterval(() => {
    if (!dirty || stopped) return;
    dirty = false;
    void safeWrite(snapshot());
  }, opts.periodMs ?? LIVE_PROGRESS_PERIOD_MS);
  return {
    onProgress: (progress) => {
      last = progress;
      lastProgressAt = new Date().toISOString();
      dirty = true;
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await safeWrite(null);
    },
  };
}
