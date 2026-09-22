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
  // Rien à déplier, rien à annoncer. Constat C9 de la revue Codex de la PR #66 :
  // le séparateur `·` ne dépendait que de l'état replié, et un tour dont le
  // message d'utilisateur ne porte aucun bloc de texte (une image seule) donne
  // une consigne vide — l'écran offrait alors de déplier du vide derrière un
  // point.
  if (text.trim() === '') return null;
  return (
    <div className="mt-3">
      <DisclosureButton
        open={open}
        onClick={() => setOpen((o) => !o)}
        inset="none"
        // Le `py-0` que cette ligne passait par className n'a JAMAIS été rendu
        // (le `py-3` de base gagnait, #399) : la rangée a été validée à 12 px.
        // Elle les garde ; le retrait est dit ici, pas glissé dans une classe.
        insetY="default"
        className="h-auto"
      >
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
