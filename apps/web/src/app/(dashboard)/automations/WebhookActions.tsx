'use client';

// WebhookActions — ce qu'on peut FAIRE à un webhook, à un seul endroit (#202).
//
// Même raison d'être que `ScheduleActions` : la carte de la liste et la page
// de l'automatisation partagent les gestes, pas seulement leur dessin.
//
// Un webhook n'a NI « Run now » NI « Edit », et la page ne les invente pas :
// il n'existe aucune action serveur qui déclenche un webhook depuis le
// tableau de bord (c'est le service extérieur qui poste), et `WebhookForm` est
// délibérément sans mode édition. Dessiner ces boutons désactivés « pour
// ressembler à un schedule » promettrait ce que le produit ne fait pas
// (invariant #4).

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Play, Pause, ArrowsClockwise, Trash } from '@phosphor-icons/react';
import {
  toggleWebhookTriggerAction,
  rotateWebhookSecretAction,
  deleteWebhookTriggerAction,
  type WebhookTriggerRow as WebhookTriggerRowData,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import PrimaryButton from '@/components/ui/PrimaryButton';

export interface Revealed {
  secret: string;
  path: string;
}

interface Props {
  webhook: WebhookTriggerRowData;
  onRevealed: (id: string, revealed: Revealed) => void;
  /** `row` : la carte de la liste. `page` : l'en-tête de la page (planche B). */
  layout?: 'row' | 'page';
}

export default function WebhookActions({ webhook: w, onRevealed, layout = 'row' }: Props) {
  const [isPending, startTransition] = useTransition();
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  function handleToggle() {
    startTransition(async () => {
      const r = await toggleWebhookTriggerAction(w.id, !w.active);
      if (!r.ok) toast.error(r.message);
      else toast.success(r.data.active ? 'Webhook enabled' : 'Webhook disabled');
    });
  }

  function performRotate() {
    setRotateConfirmOpen(false);
    startTransition(async () => {
      const r = await rotateWebhookSecretAction(w.id);
      if (!r.ok) toast.error(r.message);
      else {
        onRevealed(w.id, { secret: r.data.secret, path: r.data.path });
        toast.success('Secret rotated. The old URL no longer works.');
      }
    });
  }

  function performDelete() {
    setDeleteConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteWebhookTriggerAction(w.id);
      if (!r.ok) toast.error(r.message);
      else toast.success('Webhook deleted');
    });
  }

  const rotateConfirm = (
    <ConfirmDialog
      open={rotateConfirmOpen}
      title="Rotate webhook secret?"
      message="A new URL is generated immediately and the current one stops working. Update the external service before it fires again."
      confirmLabel="Rotate"
      destructive={false}
      onConfirm={performRotate}
      onCancel={() => setRotateConfirmOpen(false)}
    />
  );

  if (layout === 'page') {
    return (
      <div className="flex items-center gap-2" data-testid="automation-actions">
        <PrimaryButton variant="ink" onClick={handleToggle} disabled={isPending}>
          {w.active ? 'Pause' : 'Enable'}
        </PrimaryButton>
        <PrimaryButton
          variant="neutral"
          onClick={() => setRotateConfirmOpen(true)}
          disabled={isPending}
        >
          Rotate secret
        </PrimaryButton>
        {rotateConfirm}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5" data-testid="automation-actions">
      <RowActionButton
        square
        icon={w.active ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
        title={w.active ? 'Pause' : 'Enable'}
        onClick={handleToggle}
        disabled={isPending}
      />
      <RowActionButton
        square
        icon={<ArrowsClockwise size={16} />}
        title="Rotate secret"
        onClick={() => setRotateConfirmOpen(true)}
        disabled={isPending}
      />
      <RowActionButton
        square
        icon={<Trash size={16} />}
        title="Delete"
        tone="danger"
        onClick={() => setDeleteConfirmOpen(true)}
        disabled={isPending}
      />
      {rotateConfirm}
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Delete webhook?"
        message="This webhook trigger is removed. Any service still posting to its URL will get a 404."
        confirmLabel="Delete"
        onConfirm={performDelete}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    </div>
  );
}
