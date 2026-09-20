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
import PageShell from '@/components/ui/PageShell';
import ThreadHeader from '@/app/(dashboard)/chat/[id]/ThreadHeader.tsx';
import ThreadScreen from '@/app/(dashboard)/chat/[id]/ThreadScreen.tsx';
import ThreadWorkBar from '@/app/(dashboard)/spaces/ThreadWorkBar.tsx';
import type { ThreadAgent } from '@/app/(dashboard)/spaces/format.ts';

export default function RunScreen({
  avatarName,
  avatarUrl = null,
  title,
  subtitle,
  agents,
  status = null,
  proofVerdict = null,
  filesHref = null,
  statusBar = null,
  actions = null,
  children,
}: {
  /** De quoi tirer les initiales quand l'agent n'a pas d'image. */
  avatarName: string;
  avatarUrl?: string | null;
  title: string;
  subtitle: string;
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
  /**
   * CE QUE LA PAGE PERMET DE FAIRE — arrêter un run qui court (#252).
   *
   * Passée telle quelle à `ThreadScreen`, qui la pose hors de la zone qui
   * défile : la règle de #242, et UNE seule géométrie pour les trois écrans de
   * fil. `null` — un run terminé — et aucune rangée n'est dessinée.
   */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PageShell
      fill
      // #237 — la page d'un run remplit le cadre, comme le fil dont elle
      // reprend la forme : la borne de largeur du mode pleine hauteur ne vaut
      // pas pour elle.
      fluid
      toolbarBleed
      // La barre d'état PLEINE LARGEUR, comme l'en-tête (Quentin, 20/09).
      footer={statusBar}
      header={
        <ThreadHeader
          avatarName={avatarName}
          avatarUrl={avatarUrl}
          title={title}
          subtitle={subtitle}
        />
      }
      toolbar={
        <ThreadWorkBar
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
      <ThreadScreen follow="never" sidePadding={false} actions={actions}>
        {children}
      </ThreadScreen>
    </PageShell>
  );
}
