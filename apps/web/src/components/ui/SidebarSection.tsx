import type { ReactNode } from 'react';

/**
 * SidebarSection — le titre en capitales qui ouvre un bloc du panneau.
 *
 * Mesures de la planche de Quentin (19/09/2026, Figma 487:5489) : mono 11,
 * `ink-4`, interlettrage 14 %, et 14 px au-dessus, 6 px en dessous, 12 px sur
 * les côtés — le MÊME retrait latéral que l'icône d'une ligne, si bien que le
 * titre du bloc et les icônes en dessous tombent sur une seule verticale.
 *
 * Le mobile garde ses marges d'origine : un titre serré entre deux lignes de
 * 48 px se lit mal.
 */
export default function SidebarSection({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-4 pb-1.5 text-mono-11 uppercase tracking-[0.14em] text-ink-4 lg:pt-3.5 lg:pb-1.5">
      {children}
    </div>
  );
}
