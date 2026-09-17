// ModelCallBlock — ce que le TOUR a demandé au modèle, sur une ligne (#135).
//
// Jusqu'ici ces nombres vivaient à deux endroits selon le tour : à droite du
// nom de l'agent, ou à droite du bloc de raisonnement quand il y en avait un.
// Les deux étaient des endroits de passage. Le tableau de Quentin leur donne
// leur propre bloc, dans la même colonne de temps que les appels d'outil : un
// appel de modèle est un appel, il se lit comme les autres.
//
// Rien ne s'y déplie — donc composant SERVEUR, contrairement à `ToolBlock`.
//
// Un tour DÉDUIT ne porte ni modèle ni jetons (`usage: null` : le compteur
// pourrait désigner une tentative rejetée). Il n'a donc pas de bloc — plutôt
// que des zéros, qui affirmeraient un appel qu'on n'a pas vu.

import { Brain } from '@phosphor-icons/react/dist/ssr';
import type { TurnUsage } from '@/lib/conversation-feed.ts';
import { formatCost, formatMs, formatTokens } from './format.ts';

export default function ModelCallBlock({
  model,
  usage,
  className = '',
}: {
  model: string | null;
  usage: TurnUsage | null;
  /** L'espacement que l'appelant met AUTOUR du bloc — porté par le bloc
   *  lui-même, pour qu'un tour sans appel de modèle ne laisse pas une marge
   *  orpheline derrière un conteneur vide. */
  className?: string;
}) {
  if (usage === null) return null;
  // Une valeur absente ne se dessine pas : pas de tiret, pas de « 0 tokens ».
  const tokens = [
    usage.inputTokens > 0 ? `${formatTokens(usage.inputTokens)} in` : null,
    usage.outputTokens > 0 ? `${formatTokens(usage.outputTokens)} out` : null,
    usage.cachedTokens > 0 ? `${formatTokens(usage.cachedTokens)} cached` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');
  const right = [
    usage.durationMs > 0 ? formatMs(usage.durationMs) : null,
    usage.costUsd !== null ? formatCost(usage.costUsd) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');
  // Un `usage` qui ne dit RIEN (tout à zéro, pas de coût, pas de modèle) ne
  // vaut pas une ligne : ce serait un cadre vide affirmant un appel.
  if (model === null && tokens === '' && right === '') return null;
  return (
    <div
      className={`flex items-center gap-2 overflow-hidden rounded-md border border-rule-2 bg-canvas px-3 py-[7px] ${className}`}
    >
      <Brain size={14} className="shrink-0 text-ink-4" aria-hidden />
      {model !== null && (
        <span className="shrink-0 text-mono-12 text-feed-model" title={model}>
          {model}
        </span>
      )}
      {tokens !== '' && (
        <span className="min-w-0 flex-1 truncate text-mono-12 text-feed-metric">{tokens}</span>
      )}
      {right !== '' && (
        <span className="ml-auto shrink-0 text-mono-12 text-feed-metric">{right}</span>
      )}
    </div>
  );
}
