'use client';

// WebhookPageActions — les gestes d'un webhook sur SA page (#202).
//
// Un seul état à tenir ici : l'URL que la rotation vient de frapper. Le secret
// n'est jamais relu depuis la base, donc il n'existe que dans cette page et
// jusqu'au prochain rechargement — exactement comme sur la liste, où
// `AutomationsClient` tient la même carte.

import { useState } from 'react';
import type { WebhookTriggerRow } from '@/lib/actions.ts';
import { SetUrl } from '@/components/ui/SetUrl.tsx';
import WebhookActions, { type Revealed } from '../WebhookActions.tsx';
import { composeWebhookUrl } from '../webhook-url.ts';

export default function WebhookPageActions({ webhook }: { webhook: WebhookTriggerRow }) {
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  return (
    <div className="flex flex-col items-end gap-2">
      <WebhookActions
        webhook={webhook}
        layout="page"
        onRevealed={(_id, next) => setRevealed(next)}
      />
      {revealed && (
        <div className="w-full">
          <SetUrl
            subtitle="Webhook URL, contains the secret. Treat it like a password."
            url={composeWebhookUrl(revealed.path)}
          />
        </div>
      )}
    </div>
  );
}
