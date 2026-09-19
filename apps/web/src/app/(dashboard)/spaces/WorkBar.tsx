// WorkBar — la barre d'un fil, SOUS l'en-tête de page (07/09).
//
// Le design system a un `PageHeader`, et un seul : titre, sous-titre, contrôles
// globaux. Un niveau 2 de navigation (Edit agent) garde ce même en-tête et
// place son retour EN DESSOUS, un chevron et un mot. J'avais mis le nom, le
// chemin et une flèche DANS l'en-tête : un motif qui n'existe nulle part
// ailleurs (Quentin, 07/09 : « ça n'existe pas, tu n'as pas à faire ça »).
//
// Donc : le nom du fil est le TITRE de la page, son chemin le sous-titre, et
// cette barre porte ce qui reste — d'où l'on vient, qui a travaillé, le
// dossier, et l'état.

import type { ReactNode } from 'react';
import BackButton from '@/components/ui/BackButton';
import AvatarStack from '@/components/ui/AvatarStack';
import PrimaryButton from '@/components/ui/PrimaryButton';
import StatusPill from '@/components/ui/StatusPill';
import DensityToggle from './DensityToggle.tsx';
import type { FeedDensity } from '@/lib/feed-density.ts';
import type { ThreadAgent } from './format.ts';

/**
 * Le verdict de la preuve pour TOUT le fil : celui de la dernière séquence.
 * `null` = aucune preuve n'a tourné — la pastille ne paraît pas, elle ne dit
 * pas « non vérifié » (la barre n'est pas le lieu de cet aveu, le
 * récapitulatif de livraison le porte).
 */
export type ProofVerdict = string | null;

export default function WorkBar({
  back,
  agents,
  status,
  proofVerdict = null,
  filesHref = null,
  density = null,
}: {
  /**
   * Le PARENT de la page — le motif de « Back to agents » : un chevron, un mot.
   * Depuis #232 c'est un repli, pas une destination : `BackButton` ramène à la
   * page d'où l'on vient quand cet onglet en connaît une.
   */
  back: { label: string; href: string };
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
  /**
   * #132 — la densité de lecture de la personne, quand l'écran la laisse
   * choisir. `null` : pas de contrôle. La page d'un run ne le montre pas —
   * elle est la vue DÉPLIÉE par définition, et un contrôle qui ne changerait
   * rien là où on est venu voir le travail serait un bouton menteur.
   */
  density?: FeedDensity | null;
}) {
  return (
    // #135 — la barre dessinée : 54 px, un fond, deux filets, d'un bord à
    // l'autre de l'écran. Ses gouttières sont les siennes et celles de la page
    // (`toolbarBleed` retire l'enveloppe de `PageShell` qui les ajoutait), donc
    // le « ‹ Back » tombe sous l'avatar de l'en-tête.
    // `shrink-0` : dans la colonne pleine hauteur d'un écran de fil, une barre
    // à hauteur fixe se laisse comprimer par le fil qui pousse sous elle.
    <div className="flex h-[54px] w-full min-w-0 shrink-0 items-center gap-4 border-y border-rule-2 bg-canvas px-5 sm:px-8 lg:px-9">
      {/* #232 — le retour ne mène plus au `href` quoi qu'il arrive : c'est le
          PARENT déterministe de la page, celui qu'on prend faute de mieux.
          Quand cet onglet a une page précédente, `BackButton` y revient. */}
      <BackButton parent={back.href} label={back.label} className="text-body-13 hover:text-ink-2" />
      {/* L'ordre de la maquette : qui a travaillé, le dossier, la preuve,
          l'état. La pastille de preuve passe APRÈS « Files » — les deux
          pastilles se suivent, au lieu d'encadrer un bouton. */}
      <div className="ml-auto flex shrink-0 items-center gap-4">
        {agents.length > 0 && (
          // Le composant Figma `AvatarStack` (53:10) porte lui-même son
          // libellé « N agents » ; et chaque tuile montre le VRAI avatar quand
          // l'agent en a un (Quentin, 17/09).
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
        {/* #132 — tout au bout : le réglage porte sur la LECTURE du fil, pas
            sur le travail. */}
        {density !== null && <DensityToggle density={density} />}
      </div>
    </div>
  );
}
