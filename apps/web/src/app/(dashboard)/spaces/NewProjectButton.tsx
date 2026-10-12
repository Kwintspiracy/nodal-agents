'use client';

// NewProjectButton — la porte de `/spaces` vers la modale de création.
//
// La modale elle-même vit dans `components/NewProjectModal.tsx` : le « + » de
// la section PROJECTS de la barre latérale ouvre la MÊME, et deux copies d'un
// formulaire de création finissent toujours par se contredire.

import { useState } from 'react';
import NewProjectModal from '@/components/NewProjectModal.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton';

export default function NewProjectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <PrimaryButton onClick={() => setOpen(true)}>New project</PrimaryButton>
      <NewProjectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
