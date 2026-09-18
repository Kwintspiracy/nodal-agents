'use client';

// RunSummaryRow — ce qu'un run a fait, sur UNE ligne, et le dépliage qui montre
// comment (#135, #132).
//
// Le principe de Quentin (#132) : un seul rendu de ce qu'un run a fait, à deux
// densités. Le chat ouvre le fil REPLIÉ — la réponse d'abord, et sous elle
// cette ligne ; un clic déplie, bloc par bloc, exactement ce que la page du run
// montre. Le rendu est le même des deux côtés ; seul l'état de DÉPART change,
// et il vient d'une préférence de la personne, pas d'une constante de code.
//
// Ce qui est replié n'est PAS dans le DOM, comme pour `FoldableBlock` : un
// corps caché en CSS resterait cherchable (Ctrl+F le trouverait dans une page
// qui ne le montre pas). Ce n'est PAS un gain de poids : les blocs restent
// construits au SERVEUR et arrivent en `children`, donc ils voyagent dans la
// charge RSC même repliés — seul le DOM les ignore (Reviewer C, passe 1). Les
// charger au clic n'est pas dans cette PR.
//
// La densité ne fixe que l'état de départ du GROUPE : chaque bloc à l'intérieur
// se déplie toujours pour son compte.

import { useState, type ReactNode } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';
import type { RunSummary } from '@/lib/conversation-feed.ts';
import { formatCost, formatMs } from './format.ts';

/** Le singulier et le pluriel, pour ne jamais écrire « 1 tools ». */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Ce que la ligne DIT, morceau par morceau — exporté pour être prouvé sans
 * navigateur.
 *
 * Une valeur absente ne se dessine pas (invariant #4) : pas de « 0 tools », pas
 * de « $0 », pas de tiret à la place d'une durée inconnue. Un coût NUL est
 * traité comme un coût inconnu — « $0.0000 » sous un run qui a appelé un modèle
 * n'affirme rien de vrai.
 */
export function runSummaryParts(summary: RunSummary): string[] {
  const parts: string[] = [];
  if (summary.tools > 0) parts.push(plural(summary.tools, 'tool', 'tools'));
  if (summary.delegations > 0) parts.push(plural(summary.delegations, 'delegation', 'delegations'));
  if (summary.modelCalls > 0) parts.push(plural(summary.modelCalls, 'model call', 'model calls'));
  if (summary.durationMs !== null && summary.durationMs > 0)
    parts.push(formatMs(summary.durationMs));
  if (summary.costUsd !== null && summary.costUsd > 0) parts.push(formatCost(summary.costUsd));
  return parts;
}

export default function RunSummaryRow({
  jobId,
  summary,
  /** L'état de DÉPART, donné par la densité de la personne (#132). */
  defaultOpen = false,
  children,
}: {
  jobId: string;
  summary: RunSummary;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const parts = runSummaryParts(summary);
  return (
    <div className="mt-3">
      {/* La ligne dessinée : 32 px, un fond, un filet, arrondie. La hauteur est
          fixe — c'est elle qui tient la géométrie, pas les marges internes,
          comme pour `FoldableBlock`. */}
      <div className="overflow-hidden rounded-md border border-rule-2 bg-canvas">
        <DisclosureButton
          open={open}
          onClick={() => setOpen((v) => !v)}
          testId={`run-summary-${jobId}`}
          className="h-8 gap-2 px-3"
        >
          {parts.length > 0 && (
            <span className="min-w-0 flex-1 truncate text-mono-12 text-feed-metric">
              {parts.join(' · ')}
            </span>
          )}
          <span className="ml-auto shrink-0 text-micro-10 text-ink-4">
            {open ? 'Hide the work' : 'Show the work'}
          </span>
        </DisclosureButton>
      </div>
      {open && children}
    </div>
  );
}
