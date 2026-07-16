'use client';

// AddWorkerModal — lets an orchestrator card pick up an existing worker.
//
// This is purely additive: `moveWorkerAssignmentAction` is always called with
// `fromOrchestratorId: null`, so a worker that already belongs to another
// team keeps that membership (multi-team is a legitimate agent_assignments
// shape — see the docstring on `listAgentGroupsAction`). The picker only
// hides workers already on THIS team, since re-adding them would be a silent
// no-op (onConflictDoNothing) that's more confusing to show than to hide.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Modal, { ModalFooter } from '@/components/ui/Modal.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import Checkbox from '@/components/ui/Checkbox.tsx';
import { moveWorkerAssignmentAction, type AgentRow } from '@/lib/actions.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  orchestrator: AgentRow;
  /** Every agent in the entity — filtered down to non-orchestrator workers
   *  not already on this team. */
  allAgents: AgentRow[];
  currentWorkerIds: string[];
  /** Called with the rows that were actually assigned, so the caller can
   *  update its optimistic groups view before `router.refresh()` lands. */
  onAssigned: (workers: AgentRow[]) => void;
}

export default function AddWorkerModal({
  open,
  onClose,
  orchestrator,
  allAgents,
  currentWorkerIds,
  onAssigned,
}: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const currentIds = new Set(currentWorkerIds);
  const candidates = allAgents.filter(
    (a) => a.role !== 'orchestrator' && a.id !== orchestrator.id && !currentIds.has(a.id),
  );

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handleClose() {
    setSelected([]);
    onClose();
  }

  function handleSubmit() {
    if (selected.length === 0) {
      handleClose();
      return;
    }
    startTransition(async () => {
      const results = await Promise.all(
        selected.map((workerId) =>
          moveWorkerAssignmentAction({
            workerId,
            fromOrchestratorId: null,
            toOrchestratorId: orchestrator.id,
          }),
        ),
      );

      const firstFailure = results.find((r) => !r.ok);
      if (firstFailure && !firstFailure.ok) {
        toast.error(firstFailure.message);
      }

      const added = candidates.filter((a) => {
        const idx = selected.indexOf(a.id);
        return idx >= 0 && results[idx]?.ok;
      });
      if (added.length > 0) {
        toast.success(added.length === 1 ? 'Worker added' : `${added.length} workers added`);
        onAssigned(added);
      }

      setSelected([]);
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Add worker to ${orchestrator.name}`}
      dismissable={false}
      footer={
        <ModalFooter>
          <PrimaryButton variant="neutral" type="button" onClick={handleClose}>
            Cancel
          </PrimaryButton>
          <PrimaryButton
            variant="ink"
            type="button"
            onClick={handleSubmit}
            disabled={isPending || selected.length === 0}
          >
            {isPending ? 'Adding…' : 'Add'}
          </PrimaryButton>
        </ModalFooter>
      }
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-ink-3">Every other worker is already on this team.</p>
      ) : (
        <div className="max-h-64 overflow-y-auto bg-hover border border-rule rounded-lg divide-y divide-neutral-800">
          {candidates.map((a) => (
            <Checkbox
              key={a.id}
              tone="agent"
              checked={selected.includes(a.id)}
              onChange={() => toggle(a.id)}
              containerClassName="px-3 py-2 hover:bg-hover/80"
              label={
                <>
                  <span className="text-ink">{a.name}</span>
                  <span className="ml-auto font-mono text-xs text-ink-3">{a.slug}</span>
                </>
              }
            />
          ))}
        </div>
      )}
    </Modal>
  );
}
