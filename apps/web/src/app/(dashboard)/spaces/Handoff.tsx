'use client';

// Handoff.tsx — la consigne que le chat a passée au travail, repliable.
//
// Un composant client à part, parce qu'il tient un état (ouvert/fermé) et que
// le fil (`ConversationFeedView`) est rendu côté serveur.

import { useState } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';

/**
 * P7, puis « Créer, c'est prouver » (point 2) : la consigne passée au travail
 * se DÉPLIE. Repliée, une ligne ; dépliée, le texte entier, retours à la ligne
 * compris. Elle tenait dans un `<p class="truncate">` : 1 649 caractères
 * réduits à une ligne, et c'est précisément là qu'on voyait que l'agent avait
 * inventé des exigences (« Requirements: 1. … ») que personne ne lui avait
 * données. Le texte est dans le flux dans les deux états — le clip est visuel,
 * jamais une coupe du contenu.
 */
export default function Handoff({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <DisclosureButton open={open} onClick={() => setOpen((o) => !o)} className="h-auto py-0 px-0">
        <span className="shrink-0 text-mono-11 text-ink-4">Handed to the work</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-left text-mono-11 text-ink-4">
            · {text}
          </span>
        )}
      </DisclosureButton>
      {open && (
        <p className="mt-1.5 pl-[22px] text-mono-11 whitespace-pre-wrap break-words text-ink-3">
          {text}
        </p>
      )}
    </div>
  );
}
