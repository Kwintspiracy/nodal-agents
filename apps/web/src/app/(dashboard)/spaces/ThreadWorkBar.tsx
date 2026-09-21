// ThreadWorkBar — ce qu'un FIL met dans la WorkBar du design system (#242).
//
// Née le 07/09 comme « la » WorkBar, sous ce dossier de page, avec une API
// taillée pour un fil : les agents, le dossier du projet, la preuve, la
// densité de lecture. C'est précisément ce qui l'empêchait d'être le système —
// une page d'agent ou de skill n'a rien de tout cela à dire, donc aucune ne
// pouvait s'en servir, donc chacune dessinait son propre retour.
//
// La barre elle-même vit dans `components/ui/WorkBar.tsx` et ne connaît qu'un
// contexte. Ce fichier reste le contexte D'UN FIL, et rien d'autre : l'ordre de
// la maquette #135, les pastilles, le bouton du dossier.
//
// Plus de retour dedans : Quentin, 19/09, « retire les boutons retour
// PARTOUT ». Le nom du fil est le TITRE de la page et son chemin le
// sous-titre ; cette barre porte ce qui reste.

import type { ReactNode } from 'react';
import WorkBar from '@/components/ui/WorkBar';
import AvatarStack from '@/components/ui/AvatarStack';
import PrimaryButton from '@/components/ui/PrimaryButton';
import StatusPill from '@/components/ui/StatusPill';
import type { ThreadAgent } from './format.ts';

/**
 * Le verdict de la preuve pour TOUT le fil : celui de la dernière séquence.
 * `null` = aucune preuve n'a tourné — la pastille ne paraît pas, elle ne dit
 * pas « non vérifié » (la barre n'est pas le lieu de cet aveu, le
 * récapitulatif de livraison le porte).
 */
export type ProofVerdict = string | null;

export default function ThreadWorkBar({
  agents,
  status = null,
  proofVerdict = null,
  filesHref = null,
}: {
  agents: readonly ThreadAgent[];
  /** L'état du travail (Idle, Running…). */
  status?: ReactNode;
  proofVerdict?: ProofVerdict;
  /**
   * Où le bouton « Files » mène : la page des fichiers du projet
   * (`/spaces/<id>/files` — dossier, fichiers, preuve, autres conversations).
   * null : pas de projet, pas de bouton.
   */
  filesHref?: string | null;
}) {
  const preuveDite = proofVerdict === 'green' || proofVerdict === 'red';
  // Depuis que le retour est parti, une barre peut n'avoir RIEN à dire : un fil
  // sans agent connu, sans état, sans preuve et sans dossier. Elle ne se
  // dessine alors pas du tout, plutôt qu'en bandeau vide (#242).
  //
  // Le réglage de densité « Show the work · Folded / Unfolded » (#132) a vécu
  // ici jusqu'au 22/09 : Quentin l'a retiré partout. Un fil s'ouvre replié, et
  // chaque tour se déplie à la main ; la page d'un run reste la vue dépliée.
  const aQuelqueChoseADire =
    agents.length > 0 || status !== null || preuveDite || filesHref !== null;
  if (!aQuelqueChoseADire) return null;

  return (
    <WorkBar
      context={
        // L'ordre de la maquette : qui a travaillé, le dossier, la preuve,
        // l'état. La pastille de preuve passe APRÈS « Files » — les deux
        // pastilles se suivent, au lieu d'encadrer un bouton.
        <>
          {agents.length > 0 && (
            // Le composant Figma `AvatarStack` (53:10) porte lui-même son
            // libellé « N agents » ; et chaque tuile montre le VRAI avatar
            // quand l'agent en a un (Quentin, 17/09).
            <AvatarStack
              avatars={agents.map((a) => ({
                id: a.key,
                name: a.name,
                avatarUrl: a.avatarUrl ?? null,
              }))}
              max={4}
              label={`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`}
            />
          )}
          {filesHref !== null && (
            <PrimaryButton variant="neutral" size="sm" href={filesHref}>
              Files
            </PrimaryButton>
          )}
          {proofVerdict === 'green' && <StatusPill variant="done" label="Verified" />}
          {proofVerdict === 'red' && <StatusPill variant="warn" label="Checks failed" />}
          {status}
        </>
      }
    />
  );
}
