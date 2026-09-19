'use client';

// ScheduleActions — ce qu'on peut FAIRE à une routine, à un seul endroit (#202).
//
// La carte de la liste et la page de l'automatisation proposent les mêmes
// gestes ; seule leur forme change — des boutons carrés dans une ligne de
// liste, des boutons nommés dans un en-tête de page. Deux copies des mêmes
// appels auraient divergé au premier ajout : c'est déjà arrivé aux libellés de
// canal (`CHANNEL_LABELS`, deux tables sur le même écran). Un composant, deux
// habillages, les mêmes actions serveur.
//
// `layout="page"` ne rend PAS « Duplicate » ni « Delete » : la planche B ne
// porte que les trois gestes qu'on vient faire là (lancer, suspendre,
// modifier), et supprimer depuis la page de la chose supprimée laisserait le
// lecteur sur une adresse qui n'existe plus.

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Play, Pause, PlayCircle, PencilSimple, Copy, Trash } from '@phosphor-icons/react';
import {
  toggleScheduleAction,
  deleteScheduleAction,
  duplicateScheduleAction,
  runScheduleNowAction,
  type AgentRow,
  type ScheduleRow as ScheduleRowData,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import PrimaryButton from '@/components/ui/PrimaryButton';
import ScheduleForm from './ScheduleForm.tsx';

interface Props {
  schedule: ScheduleRowData;
  agents: AgentRow[];
  /** `row` : la carte de la liste. `page` : l'en-tête de la page (planche B). */
  layout?: 'row' | 'page';
}

export default function ScheduleActions({ schedule: s, agents, layout = 'row' }: Props) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  function handleToggle() {
    startTransition(async () => {
      const r = await toggleScheduleAction(s.id);
      if (!r.ok) toast.error(r.message);
      else toast.success(r.data.active ? 'Schedule enabled' : 'Schedule disabled');
    });
  }

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteScheduleAction(s.id);
      if (!r.ok) toast.error(r.message);
      else toast.success('Schedule deleted');
    });
  }

  function handleRunNow() {
    startTransition(async () => {
      const r = await runScheduleNowAction(s.id);
      if (!r.ok) toast.error(r.message);
      else toast.success(`Running "${s.name}" now`);
    });
  }

  function handleDuplicate() {
    startTransition(async () => {
      const r = await duplicateScheduleAction(s.id);
      if (!r.ok) toast.error(r.message);
      else toast.success(`Duplicated "${s.name}", paused. Enable it when ready.`);
    });
  }

  // Le formulaire d'édition est le MÊME que celui de la liste, monté seulement
  // pendant l'édition pour que son état reparte de `initial` à chaque ouverture.
  const edit = editing ? (
    <ScheduleForm mode="edit" agents={agents} initial={s} onDone={() => setEditing(false)} />
  ) : null;

  const confirm = (
    <ConfirmDialog
      open={confirmOpen}
      title="Delete schedule?"
      message="This cron schedule will be removed. Past runs are kept for audit."
      confirmLabel="Delete"
      onConfirm={performDelete}
      onCancel={() => setConfirmOpen(false)}
    />
  );

  if (layout === 'page') {
    return (
      <div className="flex items-center gap-2" data-testid="automation-actions">
        <PrimaryButton
          variant="ink"
          onClick={handleRunNow}
          disabled={isPending || !s.task}
          title={s.task ? undefined : 'No task to run'}
        >
          Run now
        </PrimaryButton>
        <PrimaryButton variant="neutral" onClick={handleToggle} disabled={isPending}>
          {s.active ? 'Pause' : 'Enable'}
        </PrimaryButton>
        <PrimaryButton variant="neutral" onClick={() => setEditing(true)} disabled={isPending}>
          Edit
        </PrimaryButton>
        {edit}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5" data-testid="automation-actions">
      <RowActionButton
        square
        icon={<Play size={16} weight="fill" />}
        title={s.task ? 'Run now' : 'No task to run'}
        onClick={handleRunNow}
        disabled={isPending || !s.task}
      />
      <RowActionButton
        square
        icon={s.active ? <Pause size={16} weight="fill" /> : <PlayCircle size={16} weight="fill" />}
        title={s.active ? 'Pause' : 'Enable'}
        onClick={handleToggle}
        disabled={isPending}
      />
      <RowActionButton
        square
        icon={<PencilSimple size={16} />}
        title="Edit"
        onClick={() => setEditing(true)}
        disabled={isPending}
      />
      <RowActionButton
        square
        icon={<Copy size={16} />}
        title="Duplicate"
        onClick={handleDuplicate}
        disabled={isPending}
      />
      <RowActionButton
        square
        icon={<Trash size={16} />}
        title="Delete"
        tone="danger"
        onClick={() => setConfirmOpen(true)}
        disabled={isPending}
      />
      {confirm}
      {edit}
    </div>
  );
}
