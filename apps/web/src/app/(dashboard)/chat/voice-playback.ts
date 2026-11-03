'use client';

// voice-playback.ts — la réponse DITE qui joue en ce moment (#942).
//
// Une seule voix à la fois dans l'onglet, et elle survit à la navigation :
// l'écran d'une conversation neuve DEVIENT le fil qui vient de naître pendant
// que la réponse joue, et le Stop du fil doit encore l'arrêter. D'où un porteur
// au niveau du module, lu par `useSyncExternalStore`, plutôt qu'un état de
// composant qui partirait avec l'écran.
//
// Deux lecteurs : le composeur (Stop prend la place d'Envoyer) et le fil (la
// pastille « Speaking » sur la réponse qui joue).
//
// L'audio est le WAV entier, en base64, que rend la route du tour (#941) ; le
// flux viendra avec #943.

import { useSyncExternalStore } from 'react';

export type Speaking = { reply: string } | null;

let current: { audio: HTMLAudioElement; reply: string } | null = null;
let snapshot: Speaking = null;
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = current ? { reply: current.reply } : null;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Arrêter la voix qui joue, s'il y en a une. */
export function stopSpeaking(): void {
  if (!current) return;
  const { audio } = current;
  current = null;
  audio.pause();
  emit();
}

/**
 * Jouer la réponse dite. Rend `ok: false` quand le navigateur refuse de jouer
 * (format illisible, lecture bloquée) : l'écran le dit, la voix ne se tait pas
 * en silence.
 */
export async function playSpoken(input: {
  mimeType: string;
  base64: string;
  reply: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  stopSpeaking();
  const audio = new Audio(`data:${input.mimeType};base64,${input.base64}`);
  const mine = { audio, reply: input.reply };
  current = mine;
  const done = (): void => {
    if (current !== mine) return;
    current = null;
    emit();
  };
  audio.addEventListener('ended', done);
  audio.addEventListener('error', done);
  emit();
  try {
    await audio.play();
    return { ok: true };
  } catch (err) {
    done();
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Ce qui joue en ce moment : la réponse dite, ou `null`. */
export function useSpeaking(): Speaking {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => null,
  );
}
