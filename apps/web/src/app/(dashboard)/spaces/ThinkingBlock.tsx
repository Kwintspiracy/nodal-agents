'use client';

// ThinkingBlock — le raisonnement d'un tour, replié (P2bis).
//
// C'est tout ce qui reste de `StepsGroup` : les appels d'outil en sont sortis
// (chacun a son `ToolBlock`, visible), et il ne garde que ce qu'un lecteur
// n'ouvre qu'à l'occasion — ce que l'agent s'est dit avant d'agir. Une ligne
// de 36 px, et le compte de SES étapes à droite.
//
// #135 — ce que le TOUR a coûté ne s'accroche plus ici. Ces nombres parlaient
// du tour, pas du raisonnement, et n'étaient là que parce qu'ils passaient par
// là ; ils ont maintenant leur propre bloc (`ModelCallBlock`). Le mot
// « Reasoning » prend la couleur `feed/reasoning`, comme le texte des étapes :
// sur une ligne, ce qui distingue les choses est la COULEUR, pas l'italique.
//
// Pas de raisonnement dans le tour ⇒ pas de bloc. Un cadre vide intitulé
// « Reasoning » ne dirait rien qu'un silence ne dise mieux.

import { useState } from 'react';
import { Sparkle } from '@phosphor-icons/react/dist/ssr';
import DisclosureButton from '@/components/ui/DisclosureButton';

export default function ThinkingBlock({ steps }: { steps: string[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const right = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
  return (
    <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
      <DisclosureButton
        open={open}
        onClick={() => setOpen((v) => !v)}
        chevron="end"
        inset="tight"
        className="h-[36px] gap-2.5 py-0"
      >
        <Sparkle size={14} className="shrink-0 text-ink-4" aria-hidden />
        <span className="shrink-0 text-body-13 text-feed-reasoning">Reasoning</span>
        <span className="ml-auto truncate text-mono-11 text-feed-metric">{right}</span>
      </DisclosureButton>
      {open && (
        <ul className="border-t border-rule-2 py-1">
          {steps.map((text, i) => (
            <li
              key={i}
              className="px-4 py-2 text-body-12 text-feed-reasoning whitespace-pre-wrap break-words"
            >
              {text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
