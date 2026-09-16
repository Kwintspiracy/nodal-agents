// ModelCallBlock — UN appel de modèle, dans le vocabulaire visuel de
// `ToolBlock` (#134).
//
// Un run entrelace deux choses : ce que l'agent a FAIT (les outils) et ce qu'il
// a DEMANDÉ (les modèles). Le bloc d'outil du chat existe déjà et sert tel
// quel ; celui-ci est son pendant, même cadre, même hauteur de ligne, même
// pastille d'issue, pour que la suite se lise comme une seule colonne de temps.
//
// Ce qu'il dit tient en une ligne : le modèle qui a EFFECTIVEMENT répondu, ses
// jetons, sa durée, son coût. Une seconde ligne n'apparaît que quand l'appel a
// échoué, et porte l'erreur telle qu'elle a été écrite.

import { Sparkle, ArrowElbowDownRight } from '@phosphor-icons/react/dist/ssr';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import type { RunModelCall } from '@/lib/actions.ts';
import { formatMs, formatTokens, formatCost } from '../spaces/format.ts';

export default function ModelCallBlock({ call }: { call: RunModelCall }) {
  const failed = call.error !== null && call.error !== '';
  const tokens =
    call.inputTokens === null && call.outputTokens === null
      ? null
      : `${formatTokens(call.inputTokens ?? 0)} in / ${formatTokens(call.outputTokens ?? 0)} out`;
  return (
    <div className="overflow-hidden rounded-md border border-rule-2 bg-canvas">
      <div className="flex h-[31px] items-center gap-2 px-3">
        <Sparkle size={14} className="shrink-0 text-ink-3" aria-hidden />
        <span className="shrink-0 text-mono-12 text-ink" title={call.model}>
          {call.model}
        </span>
        <span className="min-w-0 flex-1 truncate text-mono-12 text-ink-3">
          {tokens !== null && tokens}
          {tokens !== null && call.costUsd !== null && ' · '}
          {call.costUsd !== null && formatCost(call.costUsd)}
        </span>
        {call.failover && <MonoMicroTag tone="warn">failover</MonoMicroTag>}
        <span
          className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-err' : 'bg-ok'}`}
          aria-hidden
        />
        {call.durationMs !== null && (
          <span className="shrink-0 text-mono-12 text-ink-4">{formatMs(call.durationMs)}</span>
        )}
      </div>
      {failed && (
        <div className="flex h-[31px] items-center gap-2 border-t border-rule-2 px-3">
          <ArrowElbowDownRight size={12} className="shrink-0 text-ink-4" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-mono-12 text-err">{call.error}</span>
        </div>
      )}
    </div>
  );
}
