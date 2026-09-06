'use client';

// NewProjectConversationButton — ouvrir une conversation neuve SUR ce projet
// (P8). Elle naît ancrée : l'agent sait de quel dossier on parle dès le premier
// message, sans qu'on ait à le lui dire.

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { createProjectConversationAction } from '@/lib/project-actions.ts';

export default function NewProjectConversationButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function open(): void {
    startTransition(async () => {
      const r = await createProjectConversationAction(projectId);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      router.push(`/chat/${r.data.id}`);
    });
  }

  return (
    <PrimaryButton variant="neutral" size="sm" onClick={open} disabled={isPending}>
      {isPending ? 'Opening…' : 'New conversation'}
    </PrimaryButton>
  );
}
