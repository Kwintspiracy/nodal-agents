'use client';

// DensityToggle — à quelle densité je lis ce fil (#135, #132).
//
// Le tableau pose deux écrans du même fil, « folded (default density) » et
// « unfolded (builder density) » : ce n'est pas deux rendus, c'est le même,
// ouvert autrement. Le réglage vit à droite de la barre de travail, là où se
// tient déjà ce qui concerne la LECTURE du fil et non son contenu.
//
// Il fixe l'état de DÉPART de chaque groupe de run de la page ; chaque groupe,
// et chaque bloc dedans, se déplie toujours pour son compte ensuite. Et c'est
// une préférence de la PERSONNE : elle est écrite sur sa ligne `users`, donc
// elle la suit d'un écran à l'autre et d'une session à la suivante.

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import SegmentedControl from '@/components/ui/SegmentedControl';
import { setFeedDensityAction } from '@/lib/actions.ts';
import type { FeedDensity } from '@/lib/feed-density.ts';

export default function DensityToggle({ density }: { density: FeedDensity }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // L'état local suit le clic tout de suite : le fil, lui, n'est redessiné
  // qu'au retour du serveur, et un contrôle qui ne bouge pas pendant ce
  // temps-là se lit comme un clic perdu.
  const [choice, setChoice] = useState<FeedDensity>(density);
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-medium-13 text-ink-2">Show the work</span>
      <SegmentedControl<FeedDensity>
        ariaLabel="Show the work"
        value={choice}
        disabled={pending}
        options={[
          { value: 'folded', label: 'Folded', testId: 'density-folded' },
          { value: 'unfolded', label: 'Unfolded', testId: 'density-unfolded' },
        ]}
        onChange={(next) => {
          setChoice(next);
          startTransition(async () => {
            const result = await setFeedDensityAction(next);
            // Un échec d'écriture ne se déguise pas en choix retenu
            // (invariant #4) : le contrôle revient là où il était.
            if (!result.ok) setChoice(density);
            else router.refresh();
          });
        }}
      />
    </div>
  );
}
