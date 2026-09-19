'use client';

// ProjectProof — le panneau de preuve d'un projet, sur SA page (#143).
//
// Le panneau vient de l'onglet Code, où il vivait dans la branche « projet
// ouvert » de la table des sessions. Il n'a pas changé : ce qu'il fait, les
// deux gestes séparés (écrire la liste, puis l'approuver), l'avertissement
// avant l'approbation et l'absence totale d'optimisme sont ceux de « Vérifier
// & Corriger ». Ce qui change est l'ENDROIT : la preuve d'un projet vit sur le
// projet, à côté de ses fichiers, et plus sur une page qui listait des
// sessions.
//
// Ce fichier n'existe que pour tenir l'état RELU : le panneau remonte les
// préférences après chaque écriture réussie, et sa page était celle qui les
// gardait. Ici, c'est ce composant, qui rafraîchit aussi la route — le verdict
// de la page voisine en dépend.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { projectKey } from '@nodal-agents/shared';
import type { CodeProjectPrefs } from '@/lib/actions.ts';
import ProjectVerificationPanel, { type ProjectVerification } from './ProjectVerificationPanel.tsx';

export default function ProjectProof({
  projectPath,
  initialVerification,
  isOwner,
}: {
  projectPath: string;
  /** L'état SERVEUR, ou `null` quand aucune ligne n'existe encore. */
  initialVerification: ProjectVerification | null;
  /** Vient du serveur (`getCodeTabOwnerAction`), jamais déduit ici. */
  isOwner: boolean;
}) {
  const [verification, setVerification] = useState<ProjectVerification | null>(initialVerification);
  const router = useRouter();

  return (
    <ProjectVerificationPanel
      projectPath={projectPath}
      verification={verification}
      isOwner={isOwner}
      onPrefsReloaded={(prefs: CodeProjectPrefs[]) => {
        // Retrouvée par sa CLÉ d'identité, jamais par égalité de texte : sous
        // Windows le même dossier remonte sous des casses différentes.
        const cle = projectKey(projectPath);
        const ligne = prefs.find((p) => projectKey(p.projectPath) === cle);
        setVerification(
          ligne
            ? {
                verifyCommands: ligne.verifyCommands,
                verifyApprovedAt: ligne.verifyApprovedAt,
                verifyManifestHash: ligne.verifyManifestHash,
                verifyStatus: ligne.verifyStatus,
                verifySource: ligne.verifySource,
              }
            : null,
        );
        router.refresh();
      }}
    />
  );
}
