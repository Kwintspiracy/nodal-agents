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
          className="px-3 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded-md hover:bg-emerald-500 disabled:opacity-40"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={handleReject}
          disabled={isPending}
          className="px-3 py-1.5 text-xs font-semibold border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
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
            className="px-3 py-1.5 text-xs text-neutral-500 hover:text-white"
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
          className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-xs text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none resize-none"
        />
      )}
    </div>
  );
}
