'use client';

// RenameDialog — LA modale « donner un nouveau nom », la même pour un fil, un
// projet, un agent ou une automatisation (20/09). Elle vivait dans
// `RenameProjectButton` ; les menus de la barre latérale en ont besoin pour
// quatre sortes de lignes, et quatre copies auraient fini par diverger.
//
// Modale d'ÉDITION : ni clic dehors, ni Échap. On en sort par Cancel ou par
// Save, jamais en perdant sa saisie (règle du produit).

import { useState } from 'react';
import Modal, { ModalFooter } from './Modal';
import PrimaryButton from './PrimaryButton';
import TextInput from './TextInput';

export default function RenameDialog({
  open,
  title,
  currentName,
  hint,
  pending = false,
  onSave,
  onCancel,
  testId = 'rename',
}: {
  open: boolean;
  /** Le titre de la modale : « Rename this project ». */
  title: string;
  currentName: string;
  /** Une phrase sous le champ, quand le nom porte plus qu'un libellé. */
  hint?: string;
  pending?: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
  testId?: string;
}) {
  // Le champ part du nom COURANT à chaque ouverture : l'appelant remonte la
  // modale (`key` sur l'état ouvert) plutôt que de recopier la prop dans
  // l'état depuis un effet, ce que la règle React refuse.
  const [value, setValue] = useState(currentName);

  return (
    <Modal
      open={open}
      dismissable={false}
      onClose={onCancel}
      title={title}
      testId={testId}
      footer={
        <ModalFooter>
          <PrimaryButton variant="neutral" onClick={onCancel} disabled={pending}>
            Cancel
          </PrimaryButton>
          <PrimaryButton onClick={() => onSave(value.trim())} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </ModalFooter>
      }
    >
      <TextInput
        label="Name"
        id={`${testId}-name`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={currentName}
        maxLength={120}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !pending) {
            e.preventDefault();
            onSave(value.trim());
          }
        }}
      />
      {hint !== undefined && <p className="mt-2 text-body-12 text-ink-3">{hint}</p>}
    </Modal>
  );
}
