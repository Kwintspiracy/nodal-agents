'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { resolveApprovalAction } from '@/lib/actions.ts';

interface Props {
  approvalId: string;
}

export default function ApprovalActions({ approvalId }: Props) {
  const [isPending, startTransition] = useTransition();
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [notes, setNotes] = useState('');

  function handleApprove() {
    startTransition(async () => {
      const r = await resolveApprovalAction({
        approvalRequestId: approvalId,
        decision: 'approve',
      });
      if (!r.ok) toast.error(r.message);
      else toast.success('Approved');
    });
  }

  function handleReject() {
    if (!showRejectInput) {
      setShowRejectInput(true);
      return;
    }
    startTransition(async () => {
      const r = await resolveApprovalAction({
        approvalRequestId: approvalId,
        decision: 'reject',
        notes: notes.trim() || undefined,
      });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success('Rejected');
        setShowRejectInput(false);
        setNotes('');
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleApprove}
          disabled={isPending}
          className="rounded-md bg-ok px-3 py-1.5 text-xs font-semibold text-canvas transition-[filter] hover:brightness-[0.92] disabled:opacity-40"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={handleReject}
          disabled={isPending}
          className="rounded-md border border-err/30 px-3 py-1.5 text-xs font-semibold text-err transition-colors hover:border-err/60 disabled:opacity-40"
        >
          {showRejectInput ? 'Confirm reject' : 'Reject'}
        </button>
        {showRejectInput && (
          <button
            type="button"
            onClick={() => {
              setShowRejectInput(false);
              setNotes('');
            }}
            className="px-3 py-1.5 text-xs text-ink-3 hover:text-ink"
          >
            Cancel
          </button>
        )}
      </div>
      {showRejectInput && (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Reason for rejection (optional, shown to the agent)"
          rows={2}
          maxLength={500}
          className="w-full resize-none rounded-md border border-rule bg-canvas px-2 py-1.5 text-xs text-ink placeholder-ink-4 focus:border-ink-3 focus:outline-none"
        />
      )}
    </div>
  );
}
