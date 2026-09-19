'use client';

import { useEffect, useRef } from 'react';

/**
 * layers.ts — QUI prend Échap quand plusieurs calques sont ouverts (#233).
 *
 * Le problème, et pourquoi ce module existe plutôt que six écouteurs polis.
 *
 * Chaque calque de l'app — modale, dialogue de confirmation, tiroir, panneau
 * ancré, popover, menu mobile — écoutait `keydown` sur `window` pour son
 * propre compte. Sans convention, un seul Échap les traversait tous. La
 * première correction a demandé à chacun de regarder `e.defaultPrevented` et
 * de poser `e.preventDefault()` en agissant, les calques à voile écoutant en
 * phase de capture pour parler les premiers.
 *
 * Ça a cassé quelque chose de vrai, et la revue l'a attrapé : une `Modal`
 * `dismissable={false}` prenait la touche SANS se fermer, donc le popover
 * d'avatar ouvert DANS elle ne la recevait plus. Sur Agents › Modifier un
 * agent, Échap ne fermait plus rien. La phase capture/bulle dit « les modales
 * avant les autres » ; elle ne sait pas dire « le calque le plus INTÉRIEUR
 * d'abord », qui est la vraie règle.
 *
 * Donc : une pile. Un calque s'y inscrit en s'ouvrant, s'en retire en se
 * fermant, et UN seul écouteur `window` donne la touche au DERNIER inscrit —
 * le plus intérieur — puis s'arrête. Aucun autre calque ne voit l'événement.
 *
 * Une modale non-dismissable s'inscrit avec un geste VIDE : elle prend donc la
 * touche quand elle est au sommet (Échap ne fait rien, la règle produit est
 * respectée), et elle ne la prend pas quand quelque chose est ouvert dedans.
 * C'est exactement ce qui manquait.
 *
 * Deux calques non modaux ouverts ensemble — le panneau ancré et un popover —
 * sont réglés par la même règle : le dernier ouvert se ferme le premier. Il
 * n'y a plus de cas « non dit ».
 *
 * Limite connue : l'ordre est celui de l'OUVERTURE, pas celui de
 * l'imbrication. Deux calques montés dans le MÊME rendu s'inscrivent dans
 * l'ordre des effets de React, c'est-à-dire l'enfant avant le parent, et le
 * parent se retrouverait au sommet. Le produit ne fait jamais ça — un calque
 * ouvert dans un autre l'est toujours par un geste ultérieur — et le test le
 * dit plutôt que de le supposer.
 */

type Layer = {
  /** Ce que fait ce calque quand il reçoit Échap. Vide = il l'absorbe. */
  onEscape: () => void;
};

/** Ordonnée par ouverture : le dernier est le plus intérieur. */
const stack: Layer[] = [];
let listening = false;

function handleKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  // Le calque du dessus prend la touche, qu'il en fasse quelque chose ou non.
  e.preventDefault();
  top.onEscape();
}

function startListening(): void {
  if (listening) return;
  window.addEventListener('keydown', handleKeydown);
  listening = true;
}

function stopListening(): void {
  if (!listening) return;
  window.removeEventListener('keydown', handleKeydown);
  listening = false;
}

function push(layer: Layer): void {
  stack.push(layer);
  startListening();
}

function remove(layer: Layer): void {
  const i = stack.indexOf(layer);
  if (i !== -1) stack.splice(i, 1);
  if (stack.length === 0) stopListening();
}

/**
 * Inscrit un calque tant qu'il est ouvert, et lui donne Échap quand il est le
 * plus intérieur.
 *
 * `onEscape` peut changer d'identité à chaque rendu sans conséquence : seule
 * l'ouverture inscrit et désinscrit, le geste est lu au moment de la touche.
 * Passer un geste vide (`() => {}`) veut dire « j'absorbe Échap sans rien
 * faire » — c'est ce que fait une modale non-dismissable.
 */
export function useLayer(open: boolean, onEscape: () => void): void {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });

  useEffect(() => {
    if (!open) return;
    const layer: Layer = { onEscape: () => latest.current() };
    push(layer);
    return () => remove(layer);
  }, [open]);
}

/** Le geste vide, d'identité stable — pour les calques qui absorbent Échap. */
export const ABSORB_ESCAPE = (): void => {};

/** Le nombre de calques ouverts. Pour les tests, jamais pour du rendu. */
export function openLayerCount(): number {
  return stack.length;
}
