'use client';

// RowActions — ce que les trois points d'une ligne de la barre proposent :
// RENAME et DELETE, câblés sur la sorte de ligne (20/09, planche 25:1062,
// cadre 22:1514).
//
// Une seule pièce pour cinq sortes de lignes, parce que le geste est le même
// partout : un menu, une modale de saisie pour le nom, une confirmation pour
// la suppression — jamais un dialogue natif (invariant #10). Ce qui varie est
// la TABLE : chaque sorte nomme son action de renommage et son action de
// suppression, et le mot que la confirmation emploie.
//
// Un projet ne se « supprime » pas : c'est un dossier sur le disque, et le
// produit ne détruit rien qu'il n'a pas créé. Sa ligne propose de le RETIRER
// de la liste (`hidden`), ce que la page du projet sait déjà faire.
//
// Après le geste : la liste se relit tout de suite (`onDone`), la page se
// rafraîchit, et si la ligne supprimée était celle où l'on se trouvait, on
// remonte à la page de sa section — rester sur l'adresse d'une chose qui
// n'existe plus afficherait une erreur à la place d'un choix.

import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import RowMenu from '../ui/RowMenu';
import RenameDialog from '../ui/RenameDialog';
import ConfirmDialog from '../ConfirmDialog.tsx';
import {
  deleteAgentAction,
  deleteConversationAction,
  deleteScheduleAction,
  deleteWebhookTriggerAction,
  renameCodeProjectAction,
  setCodeProjectHiddenAction,
} from '@/lib/actions.ts';
import {
  renameAgentAction,
  renameConversationAction,
  renameScheduleAction,
  renameWebhookTriggerAction,
} from '@/lib/row-actions.ts';

export type RowKind = 'conversation' | 'project' | 'agent' | 'cron' | 'webhook';

type Result = { ok: true } | { ok: false; message: string };

type Recette = {
  /** Le mot de la confirmation et des titres : « this conversation ». */
  chose: string;
  /** Le libellé de l'entrée qui retire la ligne. */
  retirer: string;
  /** La page de la section, où l'on remonte si la ligne ouverte disparaît. */
  section: string;
  rename: (id: string, name: string, path: string | undefined) => Promise<Result>;
  remove: (id: string, path: string | undefined) => Promise<Result>;
  /** Une phrase sous le champ de nom, quand le nom porte plus qu'un libellé. */
  hint?: string;
};

const RECETTES: Record<RowKind, Recette> = {
  conversation: {
    chose: 'this conversation',
    retirer: 'Delete',
    section: '/chat',
    rename: (id, name) => renameConversationAction({ id, name }),
    remove: (id) => deleteConversationAction(id),
  },
  project: {
    chose: 'this project',
    retirer: 'Remove from list',
    section: '/spaces',
    rename: (_id, name, path) =>
      path === undefined
        ? Promise.resolve({ ok: false, message: 'This project has no path' })
        : renameCodeProjectAction({ projectPath: path, displayName: name }),
    remove: (_id, path) =>
      path === undefined
        ? Promise.resolve({ ok: false, message: 'This project has no path' })
        : setCodeProjectHiddenAction({ projectPath: path, hidden: true }),
    hint: 'Your agents use this name too. Leave it empty to go back to the folder name.',
  },
  agent: {
    chose: 'this agent',
    retirer: 'Delete',
    section: '/agents',
    rename: (id, name) => renameAgentAction({ id, name }),
    remove: (id) => deleteAgentAction(id),
  },
  cron: {
    chose: 'this automation',
    retirer: 'Delete',
    section: '/automations',
    rename: (id, name) => renameScheduleAction({ id, name }),
    remove: (id) => deleteScheduleAction(id),
  },
  webhook: {
    chose: 'this webhook',
    retirer: 'Delete',
    section: '/automations',
    rename: (id, name) => renameWebhookTriggerAction({ id, name }),
    remove: (id) => deleteWebhookTriggerAction(id),
  },
};

export default function RowActions({
  kind,
  id,
  name,
  href,
  path,
  onDone,
}: {
  kind: RowKind;
  id: string;
  name: string;
  /** L'adresse de la ligne : c'est elle qui dit si l'on est dessus. */
  href: string;
  /** Le chemin d'un projet, ce que ses actions demandent à la place de l'id. */
  path?: string;
  /** Relit la liste tout de suite après un geste réussi. */
  onDone: () => Promise<void> | void;
}) {
  const recette = RECETTES[kind];
  const router = useRouter();
  const pathname = usePathname();
  const [renommer, setRenommer] = useState(false);
  const [supprimer, setSupprimer] = useState(false);
  const [pending, start] = useTransition();

  const dessus = pathname === href || pathname.startsWith(`${href}/`);

  function save(nouveau: string): void {
    // Un nom vide n'est permis qu'au projet, pour revenir au nom du dossier.
    if (nouveau === '' && kind !== 'project') {
      toast.error('A name is required');
      return;
    }
    start(async () => {
      const r = await recette.rename(id, nouveau, path);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setRenommer(false);
      await onDone();
      router.refresh();
    });
  }

  function remove(): void {
    start(async () => {
      const r = await recette.remove(id, path);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setSupprimer(false);
      await onDone();
      if (dessus) router.push(recette.section);
      router.refresh();
    });
  }

  return (
    <>
      <RowMenu
        label={name}
        testId={`row-menu-${kind}`}
        items={[
          { label: 'Rename', onSelect: () => setRenommer(true) },
          { label: recette.retirer, onSelect: () => setSupprimer(true), destructive: true },
        ]}
      />
      <RenameDialog
        // Remontée à chaque ouverture : le champ repart du nom courant.
        key={renommer ? 'open' : 'closed'}
        open={renommer}
        title={`Rename ${recette.chose}`}
        currentName={name}
        hint={recette.hint}
        pending={pending}
        onSave={save}
        onCancel={() => setRenommer(false)}
        testId={`rename-${kind}`}
      />
      <ConfirmDialog
        open={supprimer}
        title={`${recette.retirer} ${recette.chose}?`}
        message={
          kind === 'project'
            ? `"${name}" leaves the list. Nothing is deleted on disk; the folder stays where it is.`
            : `"${name}" is deleted. This cannot be undone.`
        }
        confirmLabel={recette.retirer}
        destructive
        onConfirm={remove}
        onCancel={() => setSupprimer(false)}
      />
    </>
  );
}
