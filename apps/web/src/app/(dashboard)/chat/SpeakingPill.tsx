'use client';

// SpeakingPill — « Speaking » sur la réponse de l'agent PENDANT que sa voix
// joue (#942). Le fil est rendu côté serveur ; cette pastille est l'îlot client
// qui lit la voix en cours (`voice-playback.ts`) et ne paraît que sur le tour
// dont le texte est celui qui est dit.

import { SpeakerHigh } from '@phosphor-icons/react';
import StatusPill from '@/components/ui/StatusPill';
import { useSpeaking } from './voice-playback.ts';

export default function SpeakingPill({ text }: { text: string }) {
  const speaking = useSpeaking();
  if (speaking === null || speaking.reply.trim() === '' || speaking.reply.trim() !== text.trim()) {
    return null;
  }
  return (
    <StatusPill
      variant="run"
      label="Speaking"
      icon={<SpeakerHigh size={11} weight="regular" aria-hidden="true" />}
    />
  );
}
