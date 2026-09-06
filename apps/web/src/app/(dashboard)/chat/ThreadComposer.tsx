'use client';

// ThreadComposer — la saisie en bas d'un fil du dashboard (P7).
//
// C'est ce qui reste du chat à deux volets : une zone de texte et un envoi.
// L'envoi est SYNCHRONE côté runner (il génère la réponse et écrit les deux
// tours), donc l'écran attend puis se rafraîchit — le fil relu montre la
// réponse, ses actions et, s'il y a lieu, ce qui est sorti du chat.
//
// Un fil venu d'un canal n'a pas ce composant : répondre depuis le web vers
// Telegram ou Slack se vérifie canal par canal, et P7 ne le fait pas. La page
// le dit en toutes lettres plutôt que d'offrir un champ qui ne partirait pas.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextArea from '@/components/ui/TextArea';
import { sendChatMessageAction } from '@/lib/actions.ts';

export default function ThreadComposer({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [isPending, startTransition] = useTransition();

  function send(): void {
    const text = message.trim();
    if (text === '') return;
    startTransition(async () => {
      const r = await sendChatMessageAction({ conversationId, message: text });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setMessage('');
      router.refresh();
    });
  }

  return (
    <div className="mx-auto mt-8 flex max-w-[840px] items-end gap-3">
      <TextArea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Write to your agent…"
        rows={3}
        disabled={isPending}
        containerClassName="flex-1"
      />
      <PrimaryButton onClick={send} disabled={isPending || message.trim() === ''}>
        {isPending ? 'Sending…' : 'Send'}
      </PrimaryButton>
    </div>
  );
}
