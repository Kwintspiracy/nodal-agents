// RunScreen — la CHARPENTE d'une page de run, partagée par les trois routes.
//
// Les deux barres du fil (#135) au-dessus, le corps qui défile en dessous, la
// barre d'état tout en bas. C'est la géométrie, et rien d'autre : ce que la
// page MONTRE vit dans son corps.
//
// Elle est sortie de `RunPage` le 18/09 pour que `/code/[id]` s'y pose sans
// recopier quatre composants et leurs réglages — deux copies auraient divergé
// à la première correction, et c'est exactement ce que la planche demande de
// ne plus faire.
//
// `follow="never"` est ici et pas chez l'appelant : un run s'ouvre EN HAUT, sur
// sa carte de tête, et ne déplace jamais la vue tout seul. Un écran de
// conversation fait l'inverse, parce qu'une conversation se lit par sa fin.

import type { ReactNode } from 'react';
import type { BackLink } from '@/lib/back-links.ts';
import PageShell from '@/components/ui/PageShell';
import ThreadHeader from '@/app/(dashboard)/chat/[id]/ThreadHeader.tsx';
import ThreadScreen from '@/app/(dashboard)/chat/[id]/ThreadScreen.tsx';
import WorkBar from '@/app/(dashboard)/spaces/WorkBar.tsx';
import type { ThreadAgent } from '@/app/(dashboard)/spaces/format.ts';

export default function RunScreen({
  avatarName,
  avatarUrl = null,
  title,
  subtitle,
  back,
  agents,
  status = null,
  proofVerdict = null,
  filesHref = null,
  statusBar = null,
  children,
}: {
  /** De quoi tirer les initiales quand l'agent n'a pas d'image. */
  avatarName: string;
  avatarUrl?: string | null;
  title: string;
  subtitle: string;
  back: BackLink;
  agents: readonly ThreadAgent[];
  /** La pastille d'état du travail (Running, Done…). */
  status?: ReactNode;
  proofVerdict?: string | null;
  /**
   * Où mène le bouton « Files » de la barre : la page du dossier du projet.
   * `null` quand le run n'a pas de projet enregistré — pas de bouton, plutôt
   * qu'un lien mort.
   */
  filesHref?: string | null;
  /** La barre du bas, quand la page en a une. */
  statusBar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PageShell
      fill
      // Plein cadre, comme avant #237 : la borne de largeur du PageShell
      // vaut désormais aussi en mode pleine hauteur, et un fil n'en veut pas.
      fluid
      toolbarBleed
      header={
        <ThreadHeader
          avatarName={avatarName}
          avatarUrl={avatarUrl}
          title={title}
          subtitle={subtitle}
        />
      }
      toolbar={
        <WorkBar
          back={back}
          agents={agents}
          status={status}
          proofVerdict={proofVerdict}
          filesHref={filesHref}
        />
      }
    >
      {/* `sidePadding={false}` : les gouttières sont portées par le CORPS du
          run, sur la même boîte que sa largeur maximale — c'est ainsi que
          `PageShell` construit le corps de toutes les autres pages, et c'est la
          seule façon d'avoir la même largeur de contenu qu'elles. */}
      <ThreadScreen follow="never" sidePadding={false} statusBar={statusBar}>
        {children}
      </ThreadScreen>
    </PageShell>
  );
}
