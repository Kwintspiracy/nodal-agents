// turn-lane.ts — un tour de chat à la fois PAR CONVERSATION (Quentin, 18/09).
//
// Le dashboard laisse envoyer plusieurs messages à la suite, sans attendre la
// réponse au premier. Côté runner, deux tours lancés en même temps sur le même
// fil se marchaient dessus : le second lisait l'historique AVANT que la réponse
// du premier y soit, et les deux réponses arrivaient dans un ordre quelconque.
// L'agent répondait à la seconde question sans savoir ce qu'il venait de dire.
//
// Une file en mémoire par conversation suffit : le runner est un seul
// processus, et la file se vide d'elle-même quand le dernier tour est fini.
// Un tour qui échoue rend son erreur à SON appelant et ne bloque pas le
// suivant.

const lanes = new Map<string, Promise<void>>();

/** Lance `work` quand tout ce qui était déjà en file pour `key` est fini. */
export function runInLane<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = lanes.get(key) ?? Promise.resolve();
  const mine = previous.then(work);
  // Ce qu'on garde en file ne rejette jamais : l'échec d'un tour est rendu par
  // `mine`, pas transmis au tour suivant.
  const settled: Promise<void> = mine.then(
    () => undefined,
    () => undefined,
  );
  lanes.set(key, settled);
  void settled.then(() => {
    if (lanes.get(key) === settled) lanes.delete(key);
  });
  return mine;
}

/** Combien de conversations ont un tour en cours ou en attente (tests). */
export function openLanes(): number {
  return lanes.size;
}
