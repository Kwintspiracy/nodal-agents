'use client';

// RenameProjectButton — nommer un projet, depuis le projet OUVERT (#143).
//
// Le geste vient de l'onglet Code, où il vivait sur une ligne de liste. Il est
// maintenant ici, et c'est le bon endroit : on choisit le nom d'un projet en
// le regardant, pas en balayant une liste de cinquante.
//
// Le nom n'est PAS qu'un libellé d'écran : les agents l'entendent aussi (le
// bloc `## Runtime` lit `display_name`). C'est pourquoi le geste est réservé au
// propriétaire côté serveur, et pourquoi un refus se dit au lieu de se taire.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Modal, { ModalFooter } from '@/components/ui/Modal';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';
import { renameCodeProjectAction } from '@/lib/actions.ts';

export default function RenameProjectButton({
  projectPath,
  currentName,
}: {
  projectPath: string;
  currentName: string;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentName);
  const [pending, start] = useTransition();
  const router = useRouter();

  function save(): void {
    start(async () => {
      const result = await renameCodeProjectAction({ projectPath, displayName: value.trim() });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <PrimaryButton variant="neutral" onClick={() => setOpen(true)}>
        Rename
      </PrimaryButton>
      <Modal
        open={open}
        // Modale d'ÉDITION : ni clic dehors, ni Échap. On en sort par Cancel ou
        // par Save, jamais en perdant sa saisie.
        dismissable={false}
        onClose={() => setOpen(false)}
        title="Rename this project"
        testId="rename-project"
        footer={
          <ModalFooter>
            <PrimaryButton variant="neutral" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </PrimaryButton>
            <PrimaryButton onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </ModalFooter>
        }
      >
        <TextInput
          label="Name"
          id="rename-project-name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={currentName}
          maxLength={120}
        />
        <p className="mt-2 text-body-12 text-ink-3">
          Your agents use this name too. Leave it empty to go back to the folder name.
        </p>
      </Modal>
    </>
  );
}
