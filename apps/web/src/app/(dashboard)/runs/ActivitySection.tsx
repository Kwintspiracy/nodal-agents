'use client';

// ActivitySection — la CHRONOLOGIE du run, sous une ligne qui la résume
// (#135, tableau du 18/09).
//
// Repliée par défaut quand le run est TERMINÉ : on ouvre la page d'un run fini
// pour lire ce qu'il a rendu, pas pour relire ses quarante appels d'outil.
// Ouverte tant qu'il court : là, on est venu le regarder travailler.
//
// Pas de filtre par agent (Quentin, 18/09 a retiré les pastilles All / Alfred /
// Reviewer C) : la chronologie dit déjà qui parle à chaque bloc.

import { useState, type ReactNode } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';

export default function ActivitySection({
  label,
  live,
  children,
}: {
  /** « 9 steps · 3 agents · 41 s », composé par `run-view.ts`. */
  label: string;
  /** true tant que le run court : la section s'ouvre d'elle-même. */
  live: boolean;
  /** La chronologie — rendue côté serveur, passée telle quelle. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(live);
  return (
    <div
      className="overflow-hidden rounded-xl border border-rule-2 bg-paper"
      data-testid="activity-section"
    >
      <DisclosureButton
        open={open}
        onClick={() => setOpen((v) => !v)}
        inset="tight"
        testId="activity-row"
      >
        <span className="shrink-0 text-mono-11 tracking-wider text-ink-4 uppercase">Activity</span>
        <span className="min-w-0 truncate text-mono-11 text-ink-4">· {label}</span>
      </DisclosureButton>
      {open && <div className="border-t border-rule-2 px-4 py-2">{children}</div>}
    </div>
  );
}
