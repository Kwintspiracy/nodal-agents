// ActivitySection — la CHRONOLOGIE du run, sous le titre qui la résume
// (#135, tableau du 18/09).
//
// Elle ne se replie pas : lire l'activité EST ce pour quoi on ouvre cette page
// (Quentin, 18/09). Un bloc qui se ferme cache la seule chose qu'on vient
// chercher, et le rouvrir à chaque visite est un clic qui ne décide de rien.
// Le titre reste donc une LIGNE DE SECTION et non un bouton : la page se lit
// comme le détail Code, chaque carte annoncée par son titre mono en capitales.
// Plus de composant client ici — il n'y a plus d'état à tenir.
//
// Pas de filtre par agent : Quentin a retiré du tableau (18/09) la rangée de
// pastilles qui en proposait un par agent — la chronologie dit déjà qui parle à
// chaque bloc.

import type { ReactNode } from 'react';

export default function ActivitySection({
  label,
  children,
}: {
  /** « 9 steps · 3 agents · 41 s », composé par `run-view.ts`. */
  label: string;
  /** La chronologie — rendue côté serveur, passée telle quelle. */
  children: ReactNode;
}) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-rule-2 bg-paper"
      data-testid="activity-section"
    >
      <h2 className="border-b border-rule-2 px-4 py-3 text-mono-11 tracking-wider text-ink-4 uppercase">
        Activity · {label}
      </h2>
      <div className="px-4 py-2">{children}</div>
    </div>
  );
}
