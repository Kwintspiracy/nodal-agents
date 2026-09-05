'use client';

// HistoryGroup — ce qui précède la demande : l'historique d'une conversation
// (Telegram, Slack…) que le runner préfixe au transcript pour que l'agent se
// souvienne. Ce n'est pas ce travail ; replié par défaut, il dit combien de
// messages il contient et se déplie en échanges lisibles.

import { useState } from 'react';
import DisclosureButton from '@/components/ui/DisclosureButton';

export default function HistoryGroup({
  exchanges,
}: {
  exchanges: Array<{ role: 'user' | 'agent'; text: string }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 max-w-[720px] overflow-hidden rounded-[10px] border border-dashed border-rule-2 bg-canvas">
      <DisclosureButton open={open} onClick={() => setOpen((v) => !v)} className="py-2">
        <span className="text-medium-13 text-ink-3">Earlier in this conversation</span>
        <span className="ml-auto text-mono-11 text-ink-4">
          {exchanges.length} {exchanges.length === 1 ? 'message' : 'messages'}
        </span>
      </DisclosureButton>
      {open && (
        <ul className="border-t border-rule-2 py-2">
          {exchanges.map((e, i) => (
            <li key={i} className="flex items-start gap-3 px-4 py-1.5 text-body-12 text-ink-3">
              <span className="w-[52px] shrink-0 text-mono-11 text-ink-4">
                {e.role === 'user' ? 'you' : 'agent'}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{e.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
